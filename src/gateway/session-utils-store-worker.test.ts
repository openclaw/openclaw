import { expect, it } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.sqlite-entry.js";
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
    replaceSessionEntrySync(
      { agentId: "main", sessionKey, env },
      {
        sessionId: "worker-projection",
        updatedAt: 1,
        skillsSnapshot: { prompt: "Complete saved skill instructions", skills: [] },
      },
    );
    const childKey = "agent:main:child";
    const childScope = { agentId: "main", sessionKey: childKey, env };
    replaceSessionEntrySync(childScope, {
      sessionId: "child",
      updatedAt: 1,
      parentSessionKey: sessionKey,
      skillsSnapshot: { prompt: "Child payload stays out of discovery", skills: [] },
    });
    const input = { cfg, key: "main", agentId: "main", env, includeStoreChildEntries: true };
    await loadGatewaySessionEntryReadOnlyInWorker(input);
    const internalKey = "agent:main:internal-session-effects:fixture";
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: internalKey, env },
      { sessionId: "internal-effects", updatedAt: 1 },
    );
    const sibling = "agent:main:matrix:channel:!mixed:example.org";
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: sibling, env },
      { sessionId: sibling, updatedAt: 1 },
    );
    const database = openOpenClawAgentDatabase({ agentId: "main", env });
    database.db.prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?").run(
      JSON.stringify({
        sessionId: sibling,
        updatedAt: 1,
        delivery: normalizeSessionDeliveryState({
          context: { channel: "matrix", to: "!Mixed:example.org" },
        }),
      }),
      sibling,
    );
    database.db
      .prepare("UPDATE session_nodes SET entry_valid = 1 WHERE session_key = ?")
      .run(sibling);
    const sql = observeHostDataSql();
    try {
      const loaded = await loadGatewaySessionEntryReadOnlyInWorker(input);
      expect(loaded.canonicalKey).toBe(sessionKey);
      expect(loaded.entry).toMatchObject({
        sessionId: "worker-projection",
        skillsSnapshot: { prompt: "Complete saved skill instructions", skills: [] },
      });
      expect(loaded.store[childKey]).toMatchObject({
        sessionId: "child",
        parentSessionKey: sessionKey,
      });
      expect(loaded.store[childKey]?.skillsSnapshot).toBeUndefined();
      const internal = { ...input, key: internalKey };
      const ordinary = await loadGatewaySessionEntryReadOnlyInWorker({
        ...internal,
        excludeInternalEffects: true,
      });
      expect(ordinary.entry).toBeUndefined();
      expect(ordinary.store[internalKey]).toBeUndefined();
      expect((await loadGatewaySessionEntryReadOnlyInWorker(internal)).entry?.sessionId).toBe(
        "internal-effects",
      );
      expect(
        sql.queries.filter((query) =>
          /\bfrom\s+"?session_(?:nodes|windows|participants)\b/i.test(query),
        ),
      ).toEqual([]);
    } finally {
      sql.restore();
    }
    replaceSessionEntrySync(
      { agentId: "main", sessionKey, env },
      { sessionId: "updated-worker-projection", updatedAt: 2, label: "Updated in process" },
    );
    expect((await loadGatewaySessionEntryReadOnlyInWorker(input)).entry).toMatchObject({
      sessionId: "updated-worker-projection",
      label: "Updated in process",
    });
    replaceSessionEntrySync(childScope, {
      sessionId: "child",
      updatedAt: 2,
      spawnedBy: sessionKey,
      label: "Changed in process",
    });
    expect((await loadGatewaySessionEntryReadOnlyInWorker(input)).store[childKey]?.label).toBe(
      "Changed in process",
    );
    replaceSessionEntrySync(childScope, {
      sessionId: "child",
      updatedAt: 3,
      parentSessionKey: "agent:main:other",
    });
    expect((await loadGatewaySessionEntryReadOnlyInWorker(input)).store[childKey]).toBeUndefined();
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
    let current = true;
    const read = loadGatewaySessionEntryReadOnlyInWorker({
      cfg,
      key: sessionKey,
      agentId: "main",
      env,
      assertActive() {
        if (!current) {
          throw revoked;
        }
      },
    });
    current = false;
    await expect(read).rejects.toBe(revoked);
  });
});
