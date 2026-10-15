import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, vi } from "vitest";
import { readToolAllowlistIntersection } from "../../agents/tool-policy-shared.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { enqueueSessionEventForHost } from "./session-event-handoff.js";

export function describeToolCap(allow: readonly string[] | undefined) {
  return { allow, intersections: allow ? readToolAllowlistIntersection(allow) : undefined };
}

export async function enqueueGuardedCliWatchdog(params: {
  config: OpenClawConfig;
  workspaceDir: string;
  sessionKey: string;
  entry: SessionEntry;
  signal: AbortSignal;
  diagnostic: Record<string, unknown>;
}) {
  const { prepareSystemAgentRunAdmission } = await import("../../agents/admitted-run-context.js");
  const { testing: cliBackends } = await import("../../agents/cli-backends.test-support.js");
  const { prepareCliRunContext } = await import("../../agents/cli-runner/prepare.js");
  const { runPreparedCliAgent } = await import("../../agents/cli-runner.js");
  const { executeDeps } = await import("../../agents/cli-runner/execute-deps.js");
  const { resolveSessionFilePathCore, resolveSessionFilePathOptions, resolveSessionStorePathCore } =
    await import("../../config/sessions/paths.js");
  const sessionTarget = {
    agentId: "main",
    sessionKey: params.sessionKey,
    sessionId: params.entry.sessionId,
    storePath: resolveSessionStorePathCore(params.config.session?.store, { agentId: "main" }),
  };
  const runId = "guarded-cli-watchdog";
  const admission = prepareSystemAgentRunAdmission(params.config, runId, "main", "watchdog-proof");
  cliBackends.setDepsForTest({
    resolvePluginSetupCliBackend: () => undefined,
    resolveRuntimeCliBackends: () => [
      {
        id: "watchdog-cli",
        pluginId: "watchdog-proof",
        nativeToolMode: "selectable",
        toolAvailabilityEnforcement: "execution-args",
        resolveExecutionArgs: ({ baseArgs }) => baseArgs,
        config: {
          command: process.execPath,
          args: [],
          output: "text",
          input: "arg",
          sessionMode: "none",
        },
      },
    ],
  });
  let receipt: ReturnType<typeof enqueueSessionEventForHost> | undefined;
  const enqueue = executeDeps.enqueueSessionEvent;
  const observer = vi.spyOn(executeDeps, "enqueueSessionEvent").mockImplementation((...args) => {
    params.diagnostic.target = {
      tools: describeToolCap(args[1].expectedTarget?.toolsAllow),
      settings: args[1].expectedTarget?.settings,
    };
    receipt = enqueue(...args);
    return receipt;
  });
  const supervisor = vi.spyOn(executeDeps, "getProcessSupervisor").mockReturnValue({
    acquireScopeCleanup: () => async () => {},
    spawn: async () => ({
      runId,
      startedAtMs: Date.now(),
      activity: { resultSettled: true, lastOutputAtMs: Date.now() },
      cancel: () => {},
      wait: async () => ({
        reason: "no-output-timeout",
        exitCode: null,
        exitSignal: "SIGKILL",
        durationMs: 1,
        stdout: "partial progress before stall",
        stderr: "",
        timedOut: true,
        noOutputTimedOut: true,
      }),
    }),
    cancel: () => {},
    cancelScope: () => {},
  });
  try {
    const context = await prepareCliRunContext({
      preparedRunAdmission: admission,
      config: params.config,
      agentId: "main",
      sessionId: params.entry.sessionId,
      sessionKey: params.sessionKey,
      sessionFile: resolveSessionFilePathCore(
        params.entry.sessionId,
        params.entry,
        resolveSessionFilePathOptions(sessionTarget),
      ),
      sessionTarget,
      sessionEntry: { ...params.entry, permissionMode: "guarded" },
      workspaceDir: params.workspaceDir,
      cwd: params.workspaceDir,
      skillsSnapshot: { prompt: "", skills: [] },
      toolsAllow: ["read"],
      sourceReplyDeliveryMode: "message_tool_only",
      provider: "watchdog-cli",
      model: "synthetic-watchdog-model",
      prompt: "Read the completion status.",
      timeoutMs: 180_000,
      runId,
      abortSignal: params.signal,
    });
    params.diagnostic.prepared = {
      tools: describeToolCap(context.sessionEventSourcePolicy?.toolsAllow),
      settings: context.sessionEventSourcePolicy?.settings,
    };
    await expect(runPreparedCliAgent(context)).rejects.toThrow("produced no output");
    return expectDefined(receipt, "ordinary watchdog occurrence");
  } finally {
    observer.mockRestore();
    supervisor.mockRestore();
    cliBackends.resetDepsForTest();
    admission.close();
  }
}
