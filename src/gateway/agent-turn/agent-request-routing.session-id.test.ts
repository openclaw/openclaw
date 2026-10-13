import { expect, it, vi } from "vitest";
import { prepareEmbeddedRunSession } from "../../agents/embedded-agent-runner/run/session-bootstrap.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import * as sessionAccessor from "../../config/sessions/session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "../../config/sessions/session-sqlite-target.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import * as nodeSqlite from "../../infra/node-sqlite.js";
import { unregisterOpenClawAgentDatabase } from "../../state/openclaw-agent-db-registry.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  isOpenClawAgentDatabaseOpen,
} from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { prepareAgentRequestRouting } from "./agent-request-routing.js";

it.each([
  { caller: "Gateway", sessionKey: "global" },
  { caller: "embedded", sessionKey: "unknown" },
])(
  "resolves cold $sessionKey ownership off the main thread in $caller",
  async ({ caller, sessionKey }) => {
    await withOpenClawTestState({ label: "session-id-cold-inspection" }, async (state) => {
      const storePath = state.statePath("sessions.json");
      const cfg: OpenClawConfig = {
        agents: { ownership: "explicit", entries: { main: {}, ops: {} } },
        session: { store: storePath },
      };
      await state.writeConfig(cfg);
      setRuntimeConfigSnapshot(cfg);
      for (const agentId of ["main", "ops"]) {
        await sessionAccessor.replaceSessionEntry(
          { agentId, storePath, sessionKey },
          { sessionId: `${agentId}-session`, updatedAt: 1 },
        );
        const target = resolveSqliteTargetFromSessionStorePath(storePath, { agentId });
        await closeOpenClawAgentDatabaseByPathAsync(target.path);
        unregisterOpenClawAgentDatabase({ agentId, path: target.path });
        expect(isOpenClawAgentDatabaseOpen(target.path)).toBe(false);
      }

      const openDatabase = vi.spyOn(nodeSqlite, "openNodeSqliteDatabase");
      try {
        if (caller === "Gateway") {
          const respond = vi.fn();
          const routing = await prepareAgentRequestRouting({
            cfg,
            request: { message: "resume", sessionId: "ops-session", idempotencyKey: "lookup" },
            runId: "lookup",
            context: createDirectChatContext({ getRuntimeConfig: () => cfg }),
            respond,
            isRawModelRun: false,
            agentDedupeKeys: ["agent:lookup"],
            reserveDedupe: vi.fn(),
            bindDedupeSessionTarget: vi.fn(),
            clearDedupe: vi.fn(),
          });
          expect(respond).not.toHaveBeenCalled();
          expect(routing).toMatchObject({ agentId: "ops", requestedSessionKey: sessionKey });
        } else {
          const prepared = await prepareEmbeddedRunSession({
            config: cfg,
            sessionId: "ops-session",
            sessionFile: sessionKey,
            workspaceDir: state.workspaceDir,
            prompt: "resume",
            runId: "lookup",
            timeoutMs: 1000,
          });
          expect(prepared.params.sessionKey).toBe(sessionKey);
          expect(prepared.params.agentId).toBe("ops");
        }
        expect(openDatabase).not.toHaveBeenCalled();
      } finally {
        vi.restoreAllMocks();
        clearRuntimeConfigSnapshot();
      }
    });
  },
);
