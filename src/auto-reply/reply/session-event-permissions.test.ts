import "../../config/sessions/session-accessor.sqlite-replacement-publication.test-support.js";
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it, vi } from "vitest";
import type { RunEmbeddedAgentParams } from "../../agents/embedded-agent-runner/run/params.js";
import { runEmbeddedAgent } from "../../agents/embedded-agent.js";
import { createAgentHarnessHostCapabilities } from "../../agents/harness/host-capability.js";
import { resolveAttemptWorkspaceSandbox } from "../../agents/workspace-sandbox.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { replaceSessionEntry, loadSessionEntry } from "../../config/sessions/session-accessor.js";
import { registerSessionMaintenancePreserveKeysProvider } from "../../config/sessions/store-maintenance-preserve.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  captureSessionEventTargetForHost,
  enqueueSessionEventForHost,
} from "./session-event-handoff.js";
// mock-isolation: Use synthetic model execution with real admission and native filesystem guards.
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

it.for([
  "allowed",
  "new-session",
  "creation-retry",
  "cancelled-creation",
  "downgrade",
  "upgrade",
  "retained-tool-downgrade",
  "retained-config-downgrade",
] as const)(
  "bounds a production background completion by current and retained permissions: %s",
  async (change, { signal, onTestFinished }) => {
    const fixtureWork = withOpenClawTestState(
      { label: "session-event-permissions", env: { OPENCLAW_TEST_FAST: "0" } },
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
          tools: { profile: "coding", codeMode: false, toolSearch: false },
          skills: { load: { watch: false } },
          plugins: { enabled: false },
        };
        setRuntimeConfigSnapshot(config);
        await state.writeConfig(config);
        // Gateway boot admits shared state before accepting events; the agent store stays cold.
        openOpenClawStateDatabase();
        await fs.mkdir(state.workspaceDir, { recursive: true });
        const filePath = path.join(state.workspaceDir, "completion.txt");
        await fs.writeFile(filePath, "original\n");
        const scope = { agentId: "main", sessionKey: "agent:main:permission-completion" };
        const sessionId = "permission-completion";
        const lifecycleRevision = "same-generation";
        const setMode = async (permissionMode: SessionEntry["permissionMode"]) =>
          replaceSessionEntry(scope, {
            ...loadSessionEntry(scope),
            sessionId,
            lifecycleRevision,
            updatedAt: Date.now(),
            sessionStartedAt: Date.now(),
            permissionMode,
          });
        const fresh =
          change === "new-session" ||
          change === "creation-retry" ||
          change === "cancelled-creation";
        if (!fresh) {
          await setMode(change === "upgrade" ? "read-only" : "full");
        }
        const target = await captureSessionEventTargetForHost(scope.agentId, scope.sessionKey);
        if (fresh) {
          expect(target.sessionId).toBe("");
        }
        if (change === "downgrade" || change === "upgrade") {
          await setMode(change === "downgrade" ? "read-only" : "full");
        }
        let attempted = false;
        let observedMode: SessionEntry["permissionMode"];
        let retainedWriteRejected = false;
        const retainedDowngrade =
          change === "retained-tool-downgrade" || change === "retained-config-downgrade";
        runEmbeddedAgentMock
          .mockReset()
          .mockImplementation(async (params: RunEmbeddedAgentParams) => {
            const admission = expectDefined(
              params.preparedRunAdmission,
              "ordinary reply admission",
            );
            const admittedRunContext = await admission.admit("gateway", params.runId);
            params.onExecutionPhase?.({ phase: "model_call_started" });
            await params.onExecutionStarted?.();
            await params.onAgentEvent?.({ stream: "lifecycle", data: { phase: "start" } });
            const workspace = await resolveAttemptWorkspaceSandbox({
              ...params,
              admittedRunContext,
            });
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
                bootstrapWorkspaceDir: params.bootstrapWorkspaceDir,
                cwd: params.cwd,
                sandboxAgentId: params.sandboxAgentId,
                skillsSnapshot: params.skillsSnapshot,
                toolExecutionAllow: params.toolExecutionAllow,
                runtimePluginToolGrant: params.runtimePluginToolGrant,
                trigger: params.trigger,
                approvalReviewerDeviceId: params.approvalReviewerDeviceId,
                messageChannel: params.messageChannel,
                messageProvider: params.messageProvider,
                messageTo: params.messageTo,
                currentMessagingTarget: params.currentMessagingTarget,
                currentChannelId: params.currentChannelId,
                currentThreadTs: params.currentThreadTs,
                agentAccountId: params.agentAccountId,
                senderId: params.senderId,
                senderIsOwner: params.senderIsOwner,
                memberRoleIds: params.memberRoleIds,
              },
              pluginId: "openclaw",
            });
            try {
              observedMode = params.permissionMode;
              const tools = expectDefined(
                host.capabilities.createToolSurface,
                "managed tool surface",
              )({
                config: params.config,
                agentId: params.agentId,
                sessionId: params.sessionId,
                sessionKey: params.sessionKey,
                workspaceDir: workspace.effectiveWorkspace,
                cwd: workspace.effectiveCwd,
                sessionPermissionPolicy: workspace.sessionPermissionPolicy,
                toolConstructionPlan: {
                  includeBaseCodingTools: true,
                  includeShellTools: false,
                  includeChannelTools: false,
                  includeOpenClawTools: false,
                  includePluginTools: false,
                },
              });
              const read = expectDefined(
                tools.find((tool) => tool.name === "read"),
                "read tool",
              );
              await read.execute("read-completion", { path: filePath });
              const write = tools.find((tool) => tool.name === "write");
              if (change === "retained-tool-downgrade") {
                expect(write).toBeDefined();
                await setMode("read-only");
              } else if (change === "retained-config-downgrade") {
                expect(write).toBeDefined();
                config.tools = { ...config.tools, deny: ["write"] };
                setRuntimeConfigSnapshot(config);
              }
              if (write) {
                attempted = true;
                try {
                  await write.execute("write-completion", {
                    path: filePath,
                    content: "completed\n",
                  });
                } catch (error) {
                  if (!retainedDowngrade) {
                    throw error;
                  }
                  expect(String(error)).toMatch(
                    /authority|permission|active|configuration changed/i,
                  );
                  retainedWriteRejected = true;
                }
              }
              return { payloads: [{ text: "Completion observed" }], meta: { durationMs: 1 } };
            } finally {
              host.close();
            }
          });
        let maintenancePrepared = false;
        const cancellation = new AbortController();
        if (change === "cancelled-creation") {
          const { getReplacementPublicationDelivery } =
            await import("../../config/sessions/session-accessor.sqlite-replacement-publication.test-support.js");
          getReplacementPublicationDelivery().afterResult = () => cancellation.abort();
        }
        let stopPreserving = () => {};
        if (change === "creation-retry") {
          stopPreserving = registerSessionMaintenancePreserveKeysProvider(async () => {
            maintenancePrepared = true;
            stopPreserving();
            return { capture: () => [], dispose: () => {} };
          });
        }
        let outcome: Awaited<ReturnType<typeof enqueueSessionEventForHost>["settled"]>;
        try {
          outcome = await enqueueSessionEventForHost("Process the event; record the result.", {
            ...scope,
            source: fresh ? "plugin" : "exec",
            abortSignal: AbortSignal.any([signal, cancellation.signal]),
            expectedTarget: target,
            createIfMissing: fresh ? true : undefined,
            deliver: false,
          }).settled;
        } finally {
          stopPreserving();
        }
        if (change === "creation-retry") {
          expect(maintenancePrepared).toBe(true);
          expect(outcome).toMatchObject({
            status: "failed",
            executionStarted: false,
            error: expect.stringContaining("retry against the current session"),
          });
          expect(loadSessionEntry(scope)).toBeUndefined();
          expect(await fs.readFile(filePath, "utf8")).toBe("original\n");
          expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
          return;
        }
        if (change === "cancelled-creation") {
          expect(cancellation.signal.aborted).toBe(true);
          expect(outcome).toMatchObject({
            status: "cancelled",
            executionStarted: false,
            delivered: false,
          });
          expect(target.sessionId).not.toBe("");
          expect(loadSessionEntry(scope)).toMatchObject({
            sessionId: target.sessionId,
            lifecycleRevision: target.lifecycleRevision,
          });
          expect(await fs.readFile(filePath, "utf8")).toBe("original\n");
          expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
          return;
        }
        expect(await fs.readFile(filePath, "utf8"), JSON.stringify(outcome)).toBe(
          change === "allowed" || change === "new-session" ? "completed\n" : "original\n",
        );
        expect(runEmbeddedAgentMock, JSON.stringify(outcome)).toHaveBeenCalledOnce();
        expect(observedMode).toBe(
          change === "downgrade" || change === "upgrade"
            ? "read-only"
            : change === "new-session"
              ? undefined
              : "full",
        );
        expect(attempted).toBe(
          change === "allowed" || change === "new-session" || retainedDowngrade,
        );
        expect(retainedWriteRejected).toBe(retainedDowngrade);
        if (change === "new-session") {
          expect(loadSessionEntry(scope)?.sessionId).toBe(target.sessionId);
        } else {
          expect(loadSessionEntry(scope)).toMatchObject({ sessionId, lifecycleRevision });
        }
        if (retainedDowngrade) {
          expect(loadSessionEntry(scope)?.permissionMode).toBe(
            change === "retained-tool-downgrade" ? "read-only" : "full",
          );
          expect(outcome.executionStarted).toBe(true);
        } else {
          expect(outcome.status, outcome.error).toBe("completed");
        }
      },
    );
    // A timed-out body still owns its state until cancellation and cleanup settle.
    onTestFinished(async () => {
      await Promise.allSettled([fixtureWork]);
    });
    await fixtureWork;
  },
);
