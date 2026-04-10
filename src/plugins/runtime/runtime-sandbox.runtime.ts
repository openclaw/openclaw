import { loadConfig } from "../../config/config.js";
import type {
  PluginSandboxExecParams,
  PluginSandboxExecResult,
  PluginRuntimeCore,
} from "./types-core.js";

export function createRuntimeSandbox(): PluginRuntimeCore["sandbox"] {
  return {
    exec: async (params: PluginSandboxExecParams): Promise<PluginSandboxExecResult> => {
      const cfg = loadConfig();
      const { resolveDefaultAgentId } = await import("../../agents/agent-scope.js");
      const agentId = resolveDefaultAgentId(cfg);

      const { resolveSandboxToolPolicyForAgent, isToolAllowed } =
        await import("../../agents/sandbox/tool-policy.js");
      const policy = resolveSandboxToolPolicyForAgent(cfg, agentId);
      if (!isToolAllowed(policy, "exec")) {
        throw new Error(
          "Plugin sandbox exec is denied by tool policy. The 'exec' tool is not in the allow list or is explicitly denied.",
        );
      }

      const timeoutMs = params.timeoutMs ?? 30_000;

      // Build a combined abort signal when a timeout is specified.
      let signal = params.signal;
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      if (timeoutMs > 0) {
        const timeoutController = new AbortController();
        timeoutId = setTimeout(() => timeoutController.abort(), timeoutMs);
        signal = params.signal
          ? AbortSignal.any([params.signal, timeoutController.signal])
          : timeoutController.signal;
      }

      try {
        // Try sandbox backend when a session key is available and sandbox is configured.
        if (params.sessionKey) {
          const { resolveSandboxContext } = await import("../../agents/sandbox/context.js");
          const sandboxCtx = await resolveSandboxContext({
            config: cfg,
            sessionKey: params.sessionKey,
          });
          if (sandboxCtx?.backend) {
            const result = await sandboxCtx.backend.runShellCommand({
              script: params.command,
              allowFailure: true,
              signal,
            });
            return {
              stdout: result.stdout.toString("utf-8"),
              stderr: result.stderr.toString("utf-8"),
              exitCode: result.code,
            };
          }
        }

        // Fall back to host execution.
        const { runCommandWithTimeout } = await import("../../process/exec.js");
        const argv = ["sh", "-c", params.command];
        const result = await runCommandWithTimeout(argv, {
          timeoutMs,
          cwd: params.cwd,
        });
        return {
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.code ?? 1,
        };
      } finally {
        if (timeoutId !== undefined) {
          clearTimeout(timeoutId);
        }
      }
    },
  };
}
