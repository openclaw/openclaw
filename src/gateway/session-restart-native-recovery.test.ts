import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import * as sessionEvents from "../auto-reply/reply/session-event-handoff.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import {
  loadExactSessionEntry,
  patchSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { stageSessionPendingInput } from "../config/sessions/session-accessor.pending-inputs.js";
import {
  captureSessionQueuedInputsForRestart,
  readSessionQueuedInputPage,
} from "../config/sessions/session-pending-input-history.js";
import { createDeferredCore } from "../shared/deferred.js";
import { waitForAgentInputAdmission } from "../state/agent-database-preparation-context.js";
import { createAgentDatabaseStartupObservation } from "../state/agent-database-startup-observation.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { ensureGatewayOwnerProfile } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { captureQueuedOperatorRecoverySource } from "./operator-run-recovery-source.js";
import { pairedOperator, recoveryFixture } from "./operator-run-recovery.test-support.js";
import * as gatewayDispatch from "./server-in-process-dispatch.js";
import { resumeMarkedSessions } from "./session-restart-resume.js";

it.for([false, true])(
  "releases only the original FIFO (restart after acknowledgment: %s)",
  (restart) =>
    withOpenClawTestState({ scenario: "minimal" }, async ({ stateDir }) => {
      const cfg = { agents: { entries: { main: {} } } };
      const owner = ensureGatewayOwnerProfile("Fixture operator");
      const fixture = await recoveryFixture(stateDir, owner.id, {
        device: pairedOperator(),
        config: cfg,
      });
      const { target } = fixture;
      setRuntimeConfigSnapshot(cfg);
      const runId = "interrupted-native-run";
      await patchSessionEntryCore(target, () => ({
        nativeRestartRecovery: { runId, state: "held" },
      }));
      const source = captureQueuedOperatorRecoverySource(fixture.sourceAuthority);
      expect(source?.kind).toBe("gateway");
      const database = openOpenClawAgentDatabase({ agentId: "main" });
      for (const id of ["original-a", "original-b"]) {
        const receipt = await stageSessionPendingInput(target, {
          runId: id,
          recoverySource: source,
          message: {
            role: "user",
            content: id,
            timestamp: 1,
            idempotencyKey: id + ":user",
            __openclaw: { senderIdentity: { type: "profile", id: owner.id } },
          },
          assertCurrent() {},
        });
        expect(receipt).toBeDefined();
        (await captureSessionQueuedInputsForRestart(target)).preserve();
        receipt!.finish("interrupted", "failed");
        await receipt!.settled?.();
        database.db
          .prepare(
            "UPDATE session_pending_inputs SET lifecycle_generation = 'previous-process' WHERE input_id = ?",
          )
          .run(receipt!.inputId);
      }
      const boot = new AbortController();
      const context = fixture.context;
      context.getSessionEventSubscriberConnIds = () => new Set();
      context.agentDatabaseStartup = createAgentDatabaseStartupObservation(new Map(), boot.signal);
      const observed: unknown[] = [];
      const entered = createDeferredCore();
      const continueFirst = createDeferredCore();
      const request = gatewayDispatch.dispatchGatewayRequestInProcess;
      const dispatch = vi
        .spyOn(gatewayDispatch, "dispatchGatewayRequestInProcess")
        .mockImplementation(async (method, params, options) => {
          expect(method).toBe("chat.send");
          const run = asOptionalRecord(params)?.idempotencyKey;
          observed.push([run, options.client?.internal?.operatorRunAuthority?.profileId]);
          if (run === "original-a") {
            entered.resolve();
            await continueFirst.promise;
          }
          return {};
        });
      const root = vi.spyOn(sessionEvents, "enqueueSessionEventForHost");
      const params = { context, signal: boot.signal, log: { warn: vi.fn() } };
      const diagnostics = () =>
        JSON.stringify([
          ...params.log.warn.mock.calls,
          ...vi.mocked(context.logGateway.warn).mock.calls,
        ]);
      const waitForInputs = () =>
        waitForAgentInputAdmission(target.agentId, {
          ...target,
          owner: context.agentDatabaseStartup,
        });
      const acknowledge = (expectedRunId: string, client = fixture.client) =>
        request(
          "sessions.nativeRecovery.resume",
          {
            agentId: target.agentId,
            sessionKey: target.sessionKey,
            sessionId: target.sessionId,
            runId: expectedRunId,
          },
          { context, client },
        );
      try {
        await resumeMarkedSessions(params);
        expect((await readSessionQueuedInputPage(target)).rows.map((row) => row.run_id)).toEqual([
          "original-b",
          "original-a",
        ]);
        await expect(waitForInputs()).rejects.toMatchObject({ reason: "native_recovery_held" });
        await expect(acknowledge("stale-run")).rejects.toThrow("no longer held");
        await expect(
          acknowledge(runId, {
            ...fixture.client,
            connect: { ...fixture.client.connect, scopes: ["operator.read"] },
          }),
        ).rejects.toThrow();
        await expect(
          acknowledge(runId, {
            ...fixture.client,
            internal: { ...fixture.client.internal, syntheticClient: true },
          }),
        ).rejects.toThrow();
        expect(dispatch).not.toHaveBeenCalled();
        if (restart) {
          // The previous process persisted the acknowledgment, then died before queue admission.
          await patchSessionEntryCore(target, () => ({
            nativeRestartRecovery: { runId, state: "releasing" },
          }));
          boot.abort();
          const nextBoot = new AbortController();
          context.agentDatabaseStartup = createAgentDatabaseStartupObservation(
            new Map(),
            nextBoot.signal,
          );
          continueFirst.resolve();
          await resumeMarkedSessions({ ...params, signal: nextBoot.signal });
        } else {
          const acknowledged = acknowledge(runId);
          try {
            await Promise.race([
              entered.promise,
              acknowledged.then((result) => {
                throw new Error(
                  "Resume returned before releasing the queue: " +
                    JSON.stringify(result) +
                    " " +
                    diagnostics(),
                );
              }),
            ]);
            const fresh = waitForInputs()!.then(() => observed.push("fresh send admitted"));
            expect(observed).toEqual([["original-a", owner.id]]);
            continueFirst.resolve();
            await expect(acknowledged).resolves.toEqual({ queueReleased: true });
            await fresh;
          } finally {
            continueFirst.resolve();
            await acknowledged.catch(() => {});
          }
        }
        expect(observed, diagnostics()).toEqual([
          ["original-a", owner.id],
          ["original-b", owner.id],
          ...(restart ? [] : ["fresh send admitted"]),
        ]);
        expect(root).not.toHaveBeenCalled();
        expect(loadExactSessionEntry(target)?.entry.nativeRestartRecovery).toBeUndefined();
        await expect(acknowledge(runId)).rejects.toThrow("no longer held");
      } finally {
        continueFirst.resolve();
        root.mockRestore();
        dispatch.mockRestore();
      }
    }),
);
