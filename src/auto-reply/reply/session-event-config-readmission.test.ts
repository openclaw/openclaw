import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import {
  createAdmittedRunOperatorAuthority,
  readAdmittedRunOperatorAuthority,
  type AdmittedRunOperatorAuthority,
} from "../../agents/admitted-run-context.js";
import {
  applyEmbeddedAttemptToolsAllow,
  resolveEmbeddedAttemptToolConstructionPlan,
} from "../../agents/embedded-agent-runner/run/attempt-tool-construction-plan.js";
import { buildEmbeddedAttemptToolRunContext } from "../../agents/embedded-agent-runner/run/attempt-tool-run-context.js";
import type { RunEmbeddedAgentParams } from "../../agents/embedded-agent-runner/run/params.js";
import { runEmbeddedAgent } from "../../agents/embedded-agent.js";
import { createAgentHarnessHostCapabilities } from "../../agents/harness/host-capability.js";
import { resolveAttemptWorkspaceSandbox } from "../../agents/workspace-sandbox.js";
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
// mock-isolation: Synthetic model decisions; admission, queue and real tool writes stay real.
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

/** Attempts the real managed write tool, as the model would, and reports the final effect. */
async function attemptRealWrite(
  params: RunEmbeddedAgentParams,
  filePath: string,
  operatorAuthority?: AdmittedRunOperatorAuthority,
) {
  const admittedRunContext = expectDefined(
    await params.preparedRunAdmission?.admit("gateway", params.runId),
    "ordinary reply admission",
  );
  if (operatorAuthority) {
    expect(readAdmittedRunOperatorAuthority(admittedRunContext)?.profileId).toBe("original-guest");
  }
  params.onExecutionPhase?.({ phase: "model_call_started" });
  await params.onExecutionStarted?.();
  await params.onAgentEvent?.({ stream: "lifecycle", data: { phase: "start" } });
  const workspace = await resolveAttemptWorkspaceSandbox({ ...params, admittedRunContext });
  const host = createAgentHarnessHostCapabilities({
    attempt: {
      admittedRunContext,
      runId: params.runId,
      abortSignal: params.abortSignal,
      config: params.config,
      agentId: params.agentId,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      sessionTarget: params.sessionTarget,
      permissionMode: params.permissionMode,
      requireWorkspaceOnly: params.requireWorkspaceOnly,
      sessionRoot: workspace.sessionPermissionRoot,
      workspaceDir: params.workspaceDir,
      cwd: params.cwd,
      toolExecutionAllow: params.toolExecutionAllow,
      toolsAllow: params.toolsAllow,
      trigger: params.trigger,
      senderIsOwner: params.senderIsOwner,
    },
    pluginId: "openclaw",
  });
  try {
    const toolRunContext = buildEmbeddedAttemptToolRunContext({
      ...params,
      model:
        params.provider && params.model
          ? { provider: params.provider, id: params.model }
          : undefined,
    });
    const construction = resolveEmbeddedAttemptToolConstructionPlan({
      toolsAllow: toolRunContext.runtimeToolAllowlist,
    });
    const tools = applyEmbeddedAttemptToolsAllow(
      expectDefined(
        host.capabilities.createToolSurface,
        "managed tool surface",
      )({
        ...toolRunContext,
        config: params.config,
        agentId: params.agentId,
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        workspaceDir: workspace.effectiveWorkspace,
        cwd: workspace.effectiveCwd,
        sessionPermissionPolicy: workspace.sessionPermissionPolicy,
        toolConstructionPlan: {
          ...construction.codingToolConstructionPlan,
          includeShellTools: false,
          includeChannelTools: false,
          includeOpenClawTools: false,
          includePluginTools: false,
        },
      }),
      construction.runtimeToolAllowlist,
    );
    const write = tools.find((tool) => tool.name === "write");
    if (write) {
      await write
        .execute("readmission-write", { path: filePath, content: "written\n" })
        .catch(() => undefined);
    }
  } finally {
    host.close();
  }
}

it.for([
  { scenario: "published-deny" },
  { scenario: "retained-ceiling" },
  { scenario: "allow-control" },
  { scenario: "revoked-producer" },
  { scenario: "publication-storm" },
] as const)(
  "re-admits an accepted deferred exec completion after a config publication: $scenario",
  async ({ scenario }, { signal }) => {
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
        let sourceReferences = 1;
        const operatorAuthority =
          scenario === "allow-control"
            ? createAdmittedRunOperatorAuthority({
                profileId: "original-guest",
                scopes: ["operator.write"],
                assertCurrent() {
                  if (sourceReferences === 0) {
                    throw new Error("original source released");
                  }
                },
                retain() {
                  sourceReferences++;
                  return () => {
                    sourceReferences--;
                  };
                },
              })
            : undefined;
        const filePath = path.join(state.workspaceDir, "readmission.txt");
        const firstStarted = createDeferred();
        const releaseFirst = createDeferred();
        const prompts: string[] = [];
        runEmbeddedAgentMock
          .mockReset()
          .mockImplementation(async (params: RunEmbeddedAgentParams) => {
            prompts.push(params.prompt);
            if (prompts.length === 1) {
              const admission = expectDefined(params.preparedRunAdmission, "reply admission");
              await admission.admit("gateway", params.runId);
              params.onExecutionPhase?.({ phase: "model_call_started" });
              await params.onExecutionStarted?.();
              await params.onAgentEvent?.({ stream: "lifecycle", data: { phase: "start" } });
              firstStarted.resolve();
              await releaseFirst.promise;
            } else {
              await attemptRealWrite(params, filePath, operatorAuthority);
            }
            return { payloads: [{ text: "NO_REPLY" }], meta: { durationMs: 1 } };
          });
        const target = await captureSessionEventTargetForHost(scope.agentId, scope.sessionKey, {
          operatorAuthority,
        });
        const first = enqueueSessionEventForHost("First admitted work", {
          ...scope,
          source: "task",
          expectedTarget: target,
          abortSignal: signal,
          deliver: false,
        });
        let publications = 0;
        let storming = false;
        let revoked = false;
        let completion: ReturnType<typeof enqueueSessionEventForHost> | undefined;
        try {
          await expect(first.accepted).resolves.toEqual({ ok: true });
          await withinTest(firstStarted.promise, signal);
          completion = enqueueSessionEventForHost("Background exec completed", {
            ...scope,
            source: "exec",
            // The real exec producer's durable source identity.
            sourceTurnId: "exec:readmission-process",
            // The producing turn's tool ceiling travels with the captured target.
            expectedTarget:
              scenario === "retained-ceiling" ? { ...target, toolsAllow: ["read"] } : target,
            abortSignal: signal,
            assertCurrent: () => {
              if (revoked) {
                throw new Error("Background producer retired");
              }
              if (storming) {
                // Identical values are a no-op publication; each storm step changes policy.
                setRuntimeConfigSnapshot({
                  ...config,
                  tools: { deny: ["write", `storm-${++publications}`] },
                });
              }
            },
          });
          sourceReferences--;
          // The active turn accepts the completion as a deferred follow-up.
          await expect(completion.accepted).resolves.toEqual({ ok: true });
          setRuntimeConfigSnapshot({
            ...config,
            // Ceiling and control publish a change that still permits write.
            tools: { deny: scenario === "published-deny" ? ["write"] : ["exec"] },
          });
          storming = scenario === "publication-storm";
          revoked = scenario === "revoked-producer";
          releaseFirst.resolve();
          await expect(first.settled).resolves.toMatchObject({ status: "completed" });
          if (scenario === "publication-storm" || scenario === "revoked-producer") {
            await expect(completion.settled).resolves.toMatchObject({
              status: "failed",
              executionStarted: false,
            });
            expect(prompts).toHaveLength(1);
          } else {
            await expect(completion.settled).resolves.toMatchObject({
              status: "completed",
              executionStarted: true,
            });
            expect(prompts).toHaveLength(2);
            expect(prompts[1]).toContain("Background exec completed");
          }
          // Final effect: only the unrestricted control reaches the filesystem.
          const written = await fs.readFile(filePath, "utf8").catch(() => undefined);
          expect(written).toBe(scenario === "allow-control" ? "written\n" : undefined);
          // Settled either way: nothing is left for a later ordinary turn to drain.
          expect(completion.cancel()).toBe(false);
          expect(sourceReferences).toBe(0);
          expect(peekSystemEventEntries(scope.sessionKey)).toEqual([]);
        } finally {
          storming = false;
          revoked = false;
          releaseFirst.resolve();
          await Promise.allSettled([first.settled, completion?.settled]);
          await drainGlobalSingletonLifecycleState("restart");
          resetSystemEventsForTest();
        }
      },
    );
  },
);
