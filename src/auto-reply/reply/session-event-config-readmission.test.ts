import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import type { RunEmbeddedAgentParams } from "../../agents/embedded-agent-runner/run/params.js";
import { runEmbeddedAgent } from "../../agents/embedded-agent.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { peekSystemEventEntries, resetSystemEventsForTest } from "../../infra/system-events.js";
import { drainGlobalSingletonLifecycleState } from "../../shared/global-singleton.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import {
  captureSessionEventTargetForHost,
  enqueueSessionEventForHost,
} from "./session-event-handoff.js";
// mock-isolation: Synthetic model execution; admission, queue and dispatch stay real.
vi.mock("../../agents/embedded-agent-runner/run.js", () => ({
  runEmbeddedAgent: vi.fn(),
}));
const runEmbeddedAgentMock = vi.mocked(runEmbeddedAgent);
// Match Gateway startup: activate the real reply runtimes before timing turn authority.
await Promise.all([
  import("../dispatch.js"),
  import("./get-reply-from-config.runtime.js").then((runtime) =>
    runtime.prewarmConfigDrivenReplyRuntime(),
  ),
]);

it.for([{ storm: false }, { storm: true }])(
  "re-admits an accepted deferred event under the current policy (publication storm: $storm)",
  async ({ storm }, { signal }) => {
    await withOpenClawTestState(
      { label: "session-event-config-readmission", env: { OPENCLAW_TEST_FAST: "0" } },
      async (state) => {
        const config: OpenClawConfig = {
          agents: {
            entries: { main: { workspace: state.workspaceDir } },
            defaults: {
              workspace: state.workspaceDir,
              skipBootstrap: true,
              model: { primary: "mock-openai/gpt-5.6-luna" },
              models: { "mock-openai/gpt-5.6-luna": { agentRuntime: { id: "openclaw" } } },
            },
          },
          plugins: { enabled: false },
          skills: { load: { watch: false } },
        };
        setRuntimeConfigSnapshot(config);
        await state.writeConfig(config);
        openOpenClawStateDatabase();
        const scope = { agentId: "main", sessionKey: "agent:main:config-readmission" };
        await replaceSessionEntry(scope, {
          sessionId: "config-readmission",
          lifecycleRevision: "original",
          permissionMode: "full",
          // A channel route arms durable restart-recovery source claims.
          delivery: normalizeSessionDeliveryState({
            context: { channel: "telegram", to: "-100001", accountId: "readmission" },
          }),
          updatedAt: Date.now(),
          sessionStartedAt: Date.now(),
        });
        const firstStarted = createDeferred();
        const releaseFirst = createDeferred();
        const runs: Array<{ prompt: string; deny: readonly string[] | undefined }> = [];
        runEmbeddedAgentMock
          .mockReset()
          .mockImplementation(async (params: RunEmbeddedAgentParams) => {
            const admission = expectDefined(params.preparedRunAdmission, "normal reply admission");
            await admission.admit("gateway", params.runId);
            params.onExecutionPhase?.({ phase: "model_call_started" });
            await params.onExecutionStarted?.();
            await params.onAgentEvent?.({ stream: "lifecycle", data: { phase: "start" } });
            runs.push({ prompt: params.prompt, deny: params.config?.tools?.deny });
            if (runs.length === 1) {
              firstStarted.resolve();
              await releaseFirst.promise;
            }
            return { payloads: [{ text: "Observed" }], meta: { durationMs: 1 } };
          });
        const target = await captureSessionEventTargetForHost(scope.agentId, scope.sessionKey);
        const first = enqueueSessionEventForHost("First admitted work", {
          ...scope,
          source: "task",
          expectedTarget: target,
          abortSignal: signal,
          deliver: false,
        });
        let publishing = false;
        let publications = 0;
        let completion: ReturnType<typeof enqueueSessionEventForHost> | undefined;
        try {
          await expect(first.accepted).resolves.toEqual({ ok: true });
          await withinTest(firstStarted.promise, signal);
          completion = enqueueSessionEventForHost("Background exec completed", {
            ...scope,
            source: "exec",
            // The real exec producer's durable source identity.
            sourceTurnId: "exec:readmission-process",
            expectedTarget: target,
            abortSignal: signal,
            deliver: false,
            // A storm publishes a fresh policy at every liveness check, so each
            // re-admission is rejected again until the bounded budget is spent.
            assertCurrent: () => {
              if (publishing) {
                // Identical values are a no-op publication; each storm step changes policy.
                setRuntimeConfigSnapshot({
                  ...config,
                  tools: { deny: ["write", `storm-${++publications}`] },
                });
              }
            },
          });
          // The active turn accepts the completion as a deferred follow-up.
          await expect(completion.accepted).resolves.toEqual({ ok: true });
          setRuntimeConfigSnapshot({ ...config, tools: { deny: ["write"] } });
          publishing = storm;
          releaseFirst.resolve();
          await expect(first.settled).resolves.toMatchObject({ status: "completed" });
          if (storm) {
            await expect(completion.settled).resolves.toMatchObject({
              status: "failed",
              executionStarted: false,
            });
            expect(runs).toHaveLength(1);
          } else {
            await expect(completion.settled).resolves.toMatchObject({
              status: "completed",
              executionStarted: true,
            });
            expect(runs).toHaveLength(2);
            expect(runs[1]?.prompt).toContain("Background exec completed");
            // The completion turn binds the published policy, never the stale one.
            expect(runs[1]?.deny).toEqual(["write"]);
          }
          // Settled either way: nothing is left for a later ordinary turn to drain.
          expect(completion.cancel()).toBe(false);
          expect(peekSystemEventEntries(scope.sessionKey)).toEqual([]);
        } finally {
          publishing = false;
          releaseFirst.resolve();
          await Promise.allSettled([first.settled, completion?.settled]);
          await drainGlobalSingletonLifecycleState("restart");
          resetSystemEventsForTest();
        }
      },
    );
  },
);
