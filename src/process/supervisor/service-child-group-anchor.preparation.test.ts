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

describe.skipIf(process.platform === "win32")("POSIX anchor preparation", () => {
  it("prepares lineage completion before spawning the commanded worker", async () => {
    const fixture = createHeldAnchorPreparation(tempDirs.make("openclaw-anchor-preparation-"));
    try {
      const first = await fixture.firstFact();
      if (first.type === "spawn") {
        // Prove that the real late import is held before reporting the ordering failure.
        fixture.send({ type: "cancel", signal: "SIGTERM" });
        await fixture.loading();
      }
      expect(first, JSON.stringify(fixture.facts)).toEqual({
        type: "lineage-loading",
      });
      expect(fixture.facts.some((fact) => fact.type === "spawn")).toBe(false);
      expect(fixture.messages.some((message) => message.type === "ready")).toBe(false);
      fixture.release();
      await Promise.all([fixture.ready(), fixture.spawned()]);
      expect(
        fixture.facts.filter((fact) => !fact.type.startsWith("loader-")).map((fact) => fact.type),
      ).toEqual(["lineage-loading", "lineage-loaded", "spawn"]);
      fixture.send({ type: "worker-start" });
      expect(await fixture.rootResult()).toMatchObject({ code: 0, signal: null });
      await fixture.closed;
      expect(isOwnedProcessGroupGone(fixture.child.pid!)).toBe(true);
    } finally {
      await fixture.dispose();
    }
  });

  it("keeps the accepted identity when a duplicate start arrives during preparation", async () => {
    const fixture = createHeldAnchorPreparation(tempDirs.make("openclaw-anchor-duplicate-"));
    try {
      await fixture.loading();
      await fixture.duplicateStart();
      expectNoCommand(fixture);
      fixture.release();
      const [ready] = await Promise.all([fixture.ready(), fixture.spawned()]);
      expect(ready).toMatchObject({ type: "ready", generation: fixture.generation });
      fixture.send({ type: "worker-start" });
      expect(await fixture.rootResult()).toMatchObject({ code: 0, signal: null });
      await fixture.closed;
      expect(fixture.facts.filter((fact) => fact.type === "spawn")).toHaveLength(1);
      expect(fixture.messages.every((message) => message.generation === fixture.generation)).toBe(
        true,
      );
      expect(isOwnedProcessGroupGone(fixture.child.pid!)).toBe(true);
    } finally {
      await fixture.dispose();
    }
  });

  it.each(["cancel TERM", "cancel KILL", "worker-close", "SIGTERM", "SIGINT"] as const)(
    "keeps %s authoritative when held preparation resumes before startup-error acknowledgement",
    async (action) => {
      const fixture = createHeldAnchorPreparation(tempDirs.make("openclaw-anchor-cancel-"), {
        acknowledgeStartupError: false,
      });
      try {
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
      } finally {
        await fixture.dispose();
      }
    },
  );

  it.each(["control EOF", "IPC disconnect", "parent-loss"] as const)(
    "extinguishes the preparing anchor after %s without inventing a command result",
    async (action) => {
      const fixture = createHeldAnchorPreparation(tempDirs.make("openclaw-anchor-control-loss-"), {
        acknowledgeStartupError: false,
      });
      try {
        await fixture.loading();
        if (action === "control EOF") {
          fixture.control.end();
        } else if (action === "IPC disconnect") {
          fixture.child.disconnect();
        } else {
          fixture.parentLoss();
        }
        await expectClosedBeforeSpawn(fixture);
        fixture.release();
        expectNoCommand(fixture);
        expect(fixture.facts.some((fact) => fact.type === "lineage-loaded")).toBe(false);
      } finally {
        await fixture.dispose();
      }
    },
  );

  it.each(["control lost before ACK", "ACK crosses relay disconnect"] as const)(
    "joins actual startup-error retirement when %s",
    async (action) => {
      const fixture = createHeldAnchorPreparation(tempDirs.make("openclaw-anchor-startup-ack-"), {
        acknowledgeStartupError: false,
      });
      try {
        await fixture.loading();
        fixture.send({ type: "cancel", signal: "SIGTERM" });
        await fixture.startupError();
        if (action === "control lost before ACK") {
          fixture.control.end();
        } else {
          // The real host revokes relay IPC before acknowledging the startup error.
          fixture.child.disconnect();
          fixture.send({ type: "startup-error-ack" });
        }
        await expectClosedBeforeSpawn(fixture);
        fixture.release();
        expectNoCommand(fixture);
      } finally {
        await fixture.dispose();
      }
    },
  );
});
