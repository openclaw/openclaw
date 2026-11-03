import assert from "node:assert/strict";
import { expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/io.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { loadExactSessionEntry } from "../config/sessions/session-accessor.js";
import { stageSessionPendingInput } from "../config/sessions/session-accessor.pending-inputs.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.sqlite-entry.js";
import {
  captureSessionQueuedInputsForRestart,
  readSessionPendingInput,
  readSessionQueuedInputPage,
} from "../config/sessions/session-pending-input-history.js";
import { createAgentDatabaseStartupObservation } from "../state/agent-database-startup-observation.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createPluginReloadRestartClaim } from "./plugin-reload-operation-gateway.js";
import { savePluginReloadOperation } from "./plugin-reload-operation-store.js";
import { createContext } from "./server-plugin-in-process-dispatch.test-support.js";
import { prepareAgentRestartRecovery, resumeMarkedSessions } from "./session-restart-resume.js";

it.each(["global", "deferred"] as const)(
  "preserves another logical agent's queued custody across %s recovery of their shared physical store",
  (mode) =>
    withOpenClawTestState({ scenario: "minimal" }, async () => {
      const storePath = resolveSessionStorePathCore(undefined, { agentId: "main" });
      const cfg = {
        agents: { entries: { main: {}, ops: {} }, defaults: { sessionStore: { agentId: "main" } } },
        session: { store: storePath },
      };
      setRuntimeConfigSnapshot(cfg);
      const target = { agentId: "main", sessionKey: "agent:main:shared-custody", storePath };
      const database = openOpenClawAgentDatabase({ agentId: "main" });
      replaceSessionEntrySync(target, { sessionId: "shared-custody", updatedAt: Date.now() });
      const entry = loadExactSessionEntry(target)?.entry;
      assert(entry);
      const scope = { ...target, sessionId: entry.sessionId };
      const receipts = [];
      for (const name of ["owned", "unowned"]) {
        const receipt = await stageSessionPendingInput(scope, {
          runId: name,
          message: {
            role: "user",
            content: name,
            timestamp: Date.now(),
            idempotencyKey: name + ":user",
          },
          assertCurrent() {},
        });
        assert(receipt);
        receipts.push(receipt);
        if (name === "owned") {
          (await captureSessionQueuedInputsForRestart(scope)).preserve();
        }
        receipt.finish("interrupted");
        await receipt.settled?.();
      }
      const [owned, unowned] = receipts;
      assert(owned && unowned);
      database.db
        .prepare(
          "UPDATE session_pending_inputs SET lifecycle_generation = 'previous-process', state = 'queued' WHERE input_id IN (?, ?)",
        )
        .run(owned.inputId, unowned.inputId);
      await savePluginReloadOperation({
        id: "shared-custody",
        pluginIds: ["example"],
        state: "reloading",
        createdAtMs: 1,
        updatedAtMs: 1,
        continuations: [
          {
            agentId: "ops",
            sessionKey: target.sessionKey,
            sessionId: entry.sessionId,
            sourceRunId: "source-ops",
            recoverySource: { kind: "unavailable" },
            queuedInputIds: [owned.inputId],
            state: "pending",
          },
        ],
      });
      const context = createContext([], () => cfg);
      context.resolveGatewayContext = () => context;
      const signal = new AbortController().signal;
      if (mode === "deferred") {
        context.agentDatabaseStartup = createAgentDatabaseStartupObservation(new Map(), signal);
      }
      const claimResume = await createPluginReloadRestartClaim(context, signal);
      const params = { context, signal, log: { warn: vi.fn() }, claimResume };
      const prepared =
        mode === "deferred"
          ? await prepareAgentRestartRecovery({
              ...params,
              agentId: "main",
              env: process.env,
              assertCurrent() {},
            })
          : undefined;
      if (mode === "deferred") {
        assert(prepared);
      }
      const recovering = prepared?.();
      await resumeMarkedSessions(params);
      await recovering;
      // Replaying another logical target must not rescan or damage the cached store.
      await resumeMarkedSessions(params);
      expect(params.log.warn.mock.calls).toEqual([]);
      expect(loadExactSessionEntry(target)?.entry.resumeAfterRestart).toBeUndefined();
      const queued = await readSessionQueuedInputPage(scope, {
        queuedInputIds: [owned.inputId, unowned.inputId],
      });
      expect(queued.rows).toMatchObject([{ input_id: owned.inputId, state: "queued" }]);
      expect(queued.rows).toHaveLength(1);
      expect(await readSessionPendingInput(scope, unowned.inputId)).toMatchObject({
        state: "cancelled",
      });
    }),
);
