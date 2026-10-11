import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createHeldAnchorPreparation } from "./service-child-group-anchor.preparation.test-support.js";
import { isOwnedProcessGroupGone } from "./service-child-group-ownership.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

type PreparationFixture = ReturnType<typeof createHeldAnchorPreparation>;

function expectNoCommand(fixture: PreparationFixture) {
  expect(fixture.facts.filter((fact) => fact.type === "spawn")).toEqual([]);
  expect(
    fixture.messages.filter((message) => !["startup-error", "closing"].includes(message.type)),
  ).toEqual([]);
  expect(fs.existsSync(fixture.databasePath)).toBe(false);
}

async function expectClosedBeforeSpawn(fixture: PreparationFixture) {
  expect(await fixture.closed).toEqual({ code: null, signal: "SIGKILL" });
  expectNoCommand(fixture);
  expect(isOwnedProcessGroupGone(fixture.child.pid!)).toBe(true);
  expect(fixture.descriptorsClosed()).toBe(true);
}

async function withPreparation(check: (fixture: PreparationFixture) => Promise<void>) {
  const fixture = createHeldAnchorPreparation(tempDirs.make("openclaw-anchor-preparation-"), {
    acknowledgeStartupError: false,
  });
  try {
    await check(fixture);
  } finally {
    await fixture.dispose();
  }
}

describe.skipIf(process.platform === "win32")("POSIX anchor preparation", () => {
  it("prepares before spawning once with the accepted identity despite a duplicate start", () =>
    withPreparation(async (fixture) => {
      const first = await fixture.firstFact();
      if (first.type === "spawn") {
        // Prove that the real late import is held before reporting the ordering failure.
        fixture.send({ type: "cancel", signal: "SIGTERM" });
        await fixture.loading();
      }
      expect(first, JSON.stringify(fixture.facts)).toEqual({ type: "lineage-loading" });
      await fixture.duplicateStart();
      expectNoCommand(fixture);
      fixture.release();
      const [ready] = await Promise.all([fixture.ready(), fixture.spawned()]);
      expect(ready).toMatchObject({ type: "ready", generation: fixture.generation });
      expect(
        fixture.facts
          .filter((fact) => !fact.type.startsWith("loader-") && fact.type !== "duplicate-start")
          .map((fact) => fact.type),
      ).toEqual(["lineage-loading", "lineage-loaded", "spawn"]);
      fixture.send({ type: "worker-start" });
      expect(await fixture.rootResult()).toMatchObject({ code: 0, signal: null });
      await fixture.closed;
      expect(fixture.facts.filter((fact) => fact.type === "spawn")).toHaveLength(1);
      expect(fixture.messages.every((message) => message.generation === fixture.generation)).toBe(
        true,
      );
      expect(isOwnedProcessGroupGone(fixture.child.pid!)).toBe(true);
    }));

  it.each(["cancel TERM", "cancel KILL", "worker-close", "SIGTERM"] as const)(
    "keeps %s authoritative when preparation resumes before startup-error acknowledgement",
    (action) =>
      withPreparation(async (fixture) => {
        await fixture.loading();
        if (action === "cancel TERM" || action === "cancel KILL") {
          fixture.send({
            type: "cancel",
            signal: action === "cancel TERM" ? "SIGTERM" : "SIGKILL",
          });
        } else if (action === "worker-close") {
          fixture.send({ type: "worker-close" });
        } else {
          fixture.child.kill(action);
        }
        expect(await fixture.startupError()).toMatchObject({
          type: "startup-error",
          generation: fixture.generation,
        });
        expectNoCommand(fixture);
        expect(isOwnedProcessGroupGone(fixture.child.pid!)).toBe(false);
        fixture.release();
        await fixture.prepared();
        expectNoCommand(fixture);
        expect(isOwnedProcessGroupGone(fixture.child.pid!)).toBe(false);
        fixture.send({ type: "startup-error-ack" });
        await expectClosedBeforeSpawn(fixture);
        expect(fixture.messages.map((message) => message.type)).toEqual([
          "startup-error",
          "closing",
        ]);
      }),
  );

  it.each([
    { action: "control EOF", cancelled: false },
    { action: "IPC disconnect", cancelled: false },
    { action: "parent-loss", cancelled: false },
    { action: "control EOF", cancelled: true },
    { action: "IPC disconnect", cancelled: true },
  ])("joins preparation retirement after $action (cancelled=$cancelled)", ({ action, cancelled }) =>
    withPreparation(async (fixture) => {
      await fixture.loading();
      if (cancelled) {
        fixture.send({ type: "cancel", signal: "SIGTERM" });
        await fixture.startupError();
      }
      if (action === "control EOF") {
        fixture.control.end();
      } else if (action === "IPC disconnect") {
        fixture.child.disconnect();
        if (cancelled) {
          fixture.send({ type: "startup-error-ack" });
        }
      } else {
        fixture.parentLoss();
      }
      await expectClosedBeforeSpawn(fixture);
      fixture.release();
      expectNoCommand(fixture);
      expect(fixture.facts.some((fact) => fact.type === "lineage-loaded")).toBe(false);
    }),
  );
});
