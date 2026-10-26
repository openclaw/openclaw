import { expect, it } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { loadTranscriptEvents } from "../config/sessions/session-accessor.js";
import { resolveSessionStoreKey } from "../gateway/session-store-key.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createCanonicalRepairFixture } from "./doctor-session-repair-fixture.test-support.js";

async function expectMessage(target: Parameters<typeof loadTranscriptEvents>[0], content: string) {
  expect(await loadTranscriptEvents(target)).toContainEqual(
    expect.objectContaining({ type: "message", message: { role: "user", content } }),
  );
}

it.each(["custom-main", "global"])(
  "preserves literal main rows and lineage beside the %s request destination",
  async (variant) => {
    await withOpenClawTestState({ prefix: "doctor-stored-address-" }, async (state) => {
      const { cfg, scope, load, insert, repair } = createCanonicalRepairFixture(
        state.stateDir,
        "work",
      );
      if (variant === "global") {
        cfg.session = { store: cfg.session!.store, scope: "global" };
      }
      setRuntimeConfigSnapshot(cfg);
      const literal = "agent:main:main";
      const destination = variant === "global" ? "global" : "agent:main:work";
      const child = "agent:main:child";
      const target = (sessionKey: string) => ({
        ...scope(),
        sessionKey,
        sessionId: `window-${sessionKey}`,
      });
      const lineage = {
        parentSessionKey: literal,
        spawnedBy: literal,
        forkSource: {
          sessionKey: literal,
          sessionId: `window-${literal}`,
          entryId: "parent-entry",
        },
      };
      for (const key of [literal, destination, child]) {
        insert(
          key,
          { sessionId: target(key).sessionId, updatedAt: 1, ...(key === child ? lineage : {}) },
          key,
        );
      }
      const readRows = () => [literal, destination, child].map((key) => load(key));
      const before = readRows();
      expect(resolveSessionStoreKey({ cfg, sessionKey: literal, storeAgentId: "main" })).toBe(
        destination,
      );
      for (const apply of [false, true]) {
        expect(await repair(apply)).toMatchObject({
          foundGroups: 0,
          removedRows: 0,
          repairedGroups: 0,
        });
        expect(readRows()).toEqual(before);
        for (const key of [literal, destination, child]) {
          await expectMessage(target(key), key);
        }
      }
    });
  },
);

it("still repairs a removed default agent's legacy work address into the store owner", async () => {
  await withOpenClawTestState({ prefix: "doctor-legacy-default-owner-" }, async (state) => {
    const { cfg, scope, load, insert, repair } = createCanonicalRepairFixture(
      state.stateDir,
      "work",
      ["ops"],
    );
    setRuntimeConfigSnapshot(cfg);
    const sessionKey = "agent:main:work";
    insert(sessionKey, { sessionId: "legacy-history", updatedAt: 1 }, "kept legacy history", "ops");
    const childKey = "agent:ops:child";
    insert(
      childKey,
      {
        sessionId: "child-history",
        updatedAt: 1,
        parentSessionKey: sessionKey,
        spawnedBy: sessionKey,
        forkSource: { sessionKey, sessionId: "legacy-history", entryId: "legacy-history-message" },
      },
      undefined,
      "ops",
    );
    const retiredScope = { ...scope(), sessionKey };
    const retired = { ...retiredScope, sessionId: "retired-history" };
    insert(sessionKey, { sessionId: retired.sessionId, updatedAt: 1 }, "kept retired history");
    const retiredBefore = load(sessionKey);
    expect(await repair(false)).toMatchObject({ foundGroups: 2, repairedGroups: 0 });
    expect(await repair()).toMatchObject({ foundGroups: 2, repairedGroups: 2, removedRows: 1 });
    expect(load(sessionKey, "ops")).toBeUndefined();
    const repaired = { ...scope("ops"), sessionKey: "agent:ops:work", sessionId: "legacy-history" };
    expect(load(repaired.sessionKey, "ops")?.entry.sessionId).toBe("legacy-history");
    await expectMessage(repaired, "kept legacy history");
    expect(load(childKey, "ops")?.entry).toMatchObject({
      parentSessionKey: repaired.sessionKey,
      spawnedBy: repaired.sessionKey,
      forkSource: {
        sessionKey: repaired.sessionKey,
        sessionId: "legacy-history",
        entryId: "legacy-history-message",
      },
    });
    expect(load(sessionKey)).toEqual(retiredBefore);
    await expectMessage(retired, "kept retired history");
    expect(await repair()).toMatchObject({ foundGroups: 0, repairedGroups: 0 });
  });
});
