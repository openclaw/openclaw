import { expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.sqlite-entry.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { normalizeSessionDeliveryState } from "../utils/delivery-context.shared.js";
import { loadGatewaySessionEntryReadOnlyInWorker } from "./session-utils-store-worker.js";

it("prepares complete Gateway entries while preserving main aliases and exact-row isolation", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const cfg: OpenClawConfig = {
      agents: { ownership: "explicit", entries: { main: {} } },
      session: { mainKey: "primary" },
    };
    const sessionKey = "agent:main:primary";
    const seed = (key: string, entry: SessionEntry) =>
      replaceSessionEntrySync({ agentId: "main", sessionKey: key, env }, entry);
    const skillsSnapshot = { prompt: "Complete saved skill instructions", skills: [] };
    seed(sessionKey, { sessionId: "worker-projection", updatedAt: 1, skillsSnapshot });
    const childKey = "agent:main:child";
    const seedChild = (fields: Partial<SessionEntry>) =>
      seed(childKey, { sessionId: "child", updatedAt: 1, ...fields });
    seedChild({
      parentSessionKey: sessionKey,
      skillsSnapshot: { prompt: "Child payload stays out of discovery", skills: [] },
    });
    const input = { cfg, key: "main", agentId: "main", env, includeStoreChildEntries: true };
    const read = (key = "main", excludeInternalEffects = false) =>
      loadGatewaySessionEntryReadOnlyInWorker({ ...input, key, excludeInternalEffects });
    await read();
    const internalKey = "agent:main:internal-session-effects:fixture";
    seed(internalKey, { sessionId: "internal-effects", updatedAt: 1 });
    const sibling = "agent:main:matrix:channel:!mixed:example.org";
    seed(sibling, { sessionId: sibling, updatedAt: 1 });
    const database = openOpenClawAgentDatabase({ agentId: "main", env });
    database.db
      .prepare("UPDATE session_nodes SET entry_json = ?, entry_valid = 1 WHERE session_key = ?")
      .run(
        JSON.stringify({
          sessionId: sibling,
          updatedAt: 1,
          delivery: normalizeSessionDeliveryState({
            context: { channel: "matrix", to: "!Mixed:example.org" },
          }),
        }),
        sibling,
      );
    const sql = observeHostDataSql();
    try {
      const loaded = await read();
      expect(loaded.canonicalKey).toBe(sessionKey);
      expect(loaded.entry).toMatchObject({ sessionId: "worker-projection", skillsSnapshot });
      expect(loaded.store[childKey]).toMatchObject({
        sessionId: "child",
        parentSessionKey: sessionKey,
      });
      expect(loaded.store[childKey]?.skillsSnapshot).toBeUndefined();
      const ordinary = await read(internalKey, true);
      expect([ordinary.entry, ordinary.store[internalKey]]).toEqual([undefined, undefined]);
      expect((await read(internalKey)).entry?.sessionId).toBe("internal-effects");
      expect(
        sql.queries.filter((query) =>
          /\bfrom\s+"?session_(?:nodes|windows|participants)\b/i.test(query),
        ),
      ).toEqual([]);
    } finally {
      sql.restore();
    }
    seed(sessionKey, { sessionId: "updated-parent", updatedAt: 2, label: "Updated" });
    expect((await read()).entry).toMatchObject({ sessionId: "updated-parent", label: "Updated" });
    seedChild({ updatedAt: 2, spawnedBy: sessionKey, label: "Changed in process" });
    expect((await read()).store[childKey]?.label).toBe("Changed in process");
    seedChild({ updatedAt: 3, parentSessionKey: "agent:main:other" });
    expect((await read()).store[childKey]).toBeUndefined();
  });
});

it("rechecks caller authority before returning prepared Gateway metadata", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const cfg: OpenClawConfig = { agents: { ownership: "explicit", entries: { main: {} } } };
    const sessionKey = "agent:main:primary";
    replaceSessionEntrySync(
      { agentId: "main", sessionKey, env },
      { sessionId: "worker-authority", updatedAt: 1 },
    );
    const revoked = new Error("original caller revoked");
    const assertActive = vi.fn();
    const read = loadGatewaySessionEntryReadOnlyInWorker({
      cfg,
      key: sessionKey,
      agentId: "main",
      env,
      assertActive,
    });
    assertActive.mockImplementation(() => {
      throw revoked;
    });
    await expect(read).rejects.toBe(revoked);
  });
});
