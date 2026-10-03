import { expect, it } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.sqlite-entry.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { loadGatewaySessionEntryReadOnlyInWorker } from "./session-utils-store-worker.js";

it("prepares complete Gateway entries through the worker while preserving main aliases", async () => {
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
    const input = { cfg, key: "main", agentId: "main", env };
    await loadGatewaySessionEntryReadOnlyInWorker(input);
    const sql = observeHostDataSql();
    try {
      const loaded = await loadGatewaySessionEntryReadOnlyInWorker(input);
      expect(loaded.canonicalKey).toBe(sessionKey);
      expect(loaded.entry).toMatchObject({
        sessionId: "worker-projection",
        skillsSnapshot: { prompt: "Complete saved skill instructions", skills: [] },
      });
      expect(
        sql.queries.filter((query) =>
          /\bfrom\s+"?session_(?:nodes|windows|participants)\b/i.test(query),
        ),
      ).toEqual([]);
    } finally {
      sql.restore();
    }
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
