import { expect, it, vi } from "vitest";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  loadExactSessionEntryCandidates,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createGatewaySession } from "./session-create-service.js";

it.each(["durable", "incognito", "shared durable"] as const)(
  "rejects collisions in %s storage without decoding unrelated durable entries",
  async (collisionStore) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const shared = collisionStore === "shared durable";
      const agentId = shared ? "work" : "main";
      const storePath = shared
        ? state.statePath("shared.sqlite")
        : resolveSessionStorePathCore(undefined, { agentId });
      const target = resolveSqliteTargetFromSessionStorePath(storePath, { agentId });
      const readSource = { agentId: target.agentId ?? agentId, path: target.path };
      const { db } = openOpenClawAgentDatabase(readSource);
      const key = `agent:${agentId}:dashboard:incognito-collision`;
      const unrelatedLabel = "unrelated-durable-row-must-not-be-decoded";
      replaceSessionEntrySync(
        { agentId, sessionKey: `agent:${agentId}:dashboard:unrelated`, storePath },
        { sessionId: "unrelated", updatedAt: 1, label: unrelatedLabel },
      );
      if (collisionStore !== "incognito") {
        // A legacy durable collision cannot be seeded through incognito-aware writers.
        db.prepare(
          "INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at) VALUES (?, 'collision', ?, 1)",
        ).run(key, JSON.stringify({ sessionId: "collision", updatedAt: 1 }));
        db.prepare("UPDATE session_nodes SET entry_valid = 1 WHERE session_key = ?").run(key);
      } else {
        replaceSessionEntrySync(
          { agentId, sessionKey: key },
          { sessionId: "collision", updatedAt: 1, incognito: true },
        );
      }
      // First admission validates durable canonical keys independently of request reads.
      loadExactSessionEntryCandidates({
        readSource,
        readOnly: true,
        projection: "list",
        sessionKeys: [key],
      });
      const parse = vi.spyOn(JSON, "parse");
      try {
        const result = await createGatewaySession({
          cfg: { agents: { entries: { [agentId]: {} } }, session: { store: storePath } },
          agentId,
          key,
          incognito: true,
          commandSource: "test",
        });
        expect(result).toMatchObject({
          ok: false,
          error: { message: "incognito is immutable and requires a new session key" },
        });
        expect(parse.mock.calls.some(([json]) => json.includes(unrelatedLabel))).toBe(false);
      } finally {
        parse.mockRestore();
      }
    });
  },
);
