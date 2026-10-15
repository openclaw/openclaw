import path from "node:path";
import { expect, it } from "vitest";
import { isAgentDeletionBlocked } from "../../agents/agent-lifecycle-registry.js";
import { writeSessionEntry } from "../../config/sessions/session-accessor.sqlite-entry-store.js";
import { createGatewayCronTargetResolver } from "../../gateway/server-cron-targets.js";
import { peekSystemEventEntries } from "../../infra/system-events.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { beginAgentDeletionJournal } from "../../test-utils/agent-deletion-journal.js";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { enqueueSessionEventForHost } from "./session-event-handoff.js";
import {
  assertSessionEventTargetCurrent,
  captureSessionEventTargetForHost,
  prepareSessionEventTargetForHost,
} from "./session-event-target.js";

type WithTargetFixture = (
  run: (fixture: OpenClawTestState & { storePath: string }) => Promise<void>,
  options?: { empty?: boolean; native?: boolean },
) => Promise<void>;

export function registerSessionEventDeletionEnvironmentTests(
  withTargetFixture: WithTargetFixture,
  withFailedDispatch: (error: Error, run: () => Promise<void>) => Promise<void>,
) {
  it.for(["ambient", "captured"] as const)(
    "checks deletion only in the captured event environment (journal: %s)",
    async (journalScope) => {
      await withTargetFixture(
        async (state) => {
          const injectedRoot = state.path("injected-gateway");
          const injectedEnv = {
            ...state.env,
            OPENCLAW_STATE_DIR: injectedRoot,
            OPENCLAW_AGENT_DIR: undefined,
          };
          openOpenClawStateDatabase({ env: injectedEnv });
          const database = openOpenClawAgentDatabase({ agentId: "main", env: injectedEnv });
          const sessionKey = "agent:main:deletion-environment";
          writeSessionEntry(database, sessionKey, {
            sessionId: "injected-session",
            lifecycleRevision: "injected-generation",
            updatedAt: 1,
          });
          const target = await captureSessionEventTargetForHost("main", sessionKey, {
            env: injectedEnv,
          });
          const resolver = createGatewayCronTargetResolver(injectedEnv, { warn() {} });
          const journalRoot = journalScope === "captured" ? injectedRoot : state.stateDir;
          const journalEnv = journalScope === "captured" ? injectedEnv : state.env;
          beginAgentDeletionJournal(
            {
              agentId: "main",
              operationId: `delete-${journalScope}`,
              agentDir: path.join(journalRoot, "agents", "main", "agent"),
              sessionsDir: path.join(journalRoot, "agents", "main", "sessions"),
              workspaceDir: path.join(journalRoot, "workspace"),
              deleteFiles: false,
            },
            { env: journalEnv },
          );
          expect(isAgentDeletionBlocked("main", { env: state.env })).toBe(
            journalScope === "ambient",
          );
          expect(isAgentDeletionBlocked("main", { env: injectedEnv })).toBe(
            journalScope === "captured",
          );
          if (journalScope === "captured") {
            expect(() => assertSessionEventTargetCurrent(target)).toThrow("owner is being deleted");
            expect(() => resolver.resolveCronAgent("main")).toThrow(
              "cron job agent is unavailable",
            );
          } else {
            expect(() => assertSessionEventTargetCurrent(target)).not.toThrow();
            expect(resolver.resolveCronAgent("main").agentId).toBe("main");
            const prepared = await prepareSessionEventTargetForHost(target);
            try {
              prepared.assertCurrent();
            } finally {
              prepared.release();
            }
            const dispatchFailure = new Error(
              "Injected dispatch boundary after native target admission",
            );
            await withFailedDispatch(dispatchFailure, async () => {
              const receipt = enqueueSessionEventForHost("Check the injected session", {
                agentId: "main",
                sessionKey,
                source: "exec",
                expectedTarget: target,
                deliver: false,
              });
              await expect(receipt.accepted).resolves.toEqual({
                ok: false,
                error: String(dispatchFailure),
              });
              await expect(receipt.settled).resolves.toMatchObject({
                status: "failed",
                executionStarted: false,
                delivered: false,
                error: String(dispatchFailure),
              });
              expect(peekSystemEventEntries(sessionKey)).toEqual([]);
            });
          }
        },
        { native: true },
      );
    },
  );
}
