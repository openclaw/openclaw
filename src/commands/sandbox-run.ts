import type { RuntimeEnv } from "../runtime.js";
import { resolveAgentConfig, resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { createExecTool } from "../agents/bash-tools.exec.js";
import { resolveSandboxContext } from "../agents/sandbox.js";
import { loadConfig, type OpenClawConfig } from "../config/config.js";
import { resolveMainSessionKey } from "../config/sessions.js";
import {
  buildAgentMainSessionKey,
  normalizeAgentId,
  normalizeMainKey,
  resolveAgentIdFromSessionKey,
} from "../routing/session-key.js";

type SandboxRunOptions = {
  command: string;
  session?: string;
  agent?: string;
  workdir?: string;
};

function resolveRunSessionKey(params: {
  cfg: OpenClawConfig;
  agentId: string;
  session?: string;
}): string {
  const raw = (params.session ?? "").trim();
  if (!raw) {
    const mainKey = normalizeMainKey(params.cfg.session?.mainKey);
    return buildAgentMainSessionKey({ agentId: params.agentId, mainKey });
  }
  if (raw.includes(":")) {
    return raw;
  }
  return buildAgentMainSessionKey({
    agentId: params.agentId,
    mainKey: normalizeMainKey(raw),
  });
}

export async function sandboxRunCommand(
  opts: SandboxRunOptions,
  runtime: RuntimeEnv,
): Promise<void> {
  const cfg = loadConfig();

  const defaultAgentId = resolveAgentIdFromSessionKey(resolveMainSessionKey(cfg));
  const resolvedAgentId = normalizeAgentId(
    opts.agent?.trim()
      ? opts.agent
      : opts.session?.trim()
        ? resolveAgentIdFromSessionKey(opts.session)
        : defaultAgentId,
  );

  const sessionKey = resolveRunSessionKey({
    cfg,
    agentId: resolvedAgentId,
    session: opts.session,
  });

  // Resolve the effective workspace root for this specific agent.
  const workspaceDir = resolveAgentWorkspaceDir(cfg, resolvedAgentId);

  // Resolve context with the correct host workspace root.
  const sandbox = await resolveSandboxContext({
    config: cfg,
    sessionKey,
    workspaceDir,
  });

  if (!sandbox) {
    runtime.error(
      `Sandboxing is not enabled for agent "${resolvedAgentId}" (session: ${sessionKey}).`,
    );
    runtime.error(
      "Check your configuration: agents.defaults.sandbox.mode or agents.list[].sandbox.mode",
    );
    runtime.exit(1);
    return;
  }

  const agentConfig = resolveAgentConfig(cfg, resolvedAgentId);
  const execConfig = cfg.tools?.exec;
  const agentExec = agentConfig?.tools?.exec;

  const tool = createExecTool({
    host: "sandbox",
    security: "full",
    ask: "off",
    agentId: resolvedAgentId,
    sessionKey,
    // CRITICAL: use the workspace Dir from sandbox context as tool base cwd
    cwd: sandbox.workspaceDir,
    sandbox: {
      containerName: sandbox.containerName,
      workspaceDir: sandbox.workspaceDir,
      containerWorkdir: sandbox.containerWorkdir,
      env: sandbox.docker.env,
    },
    pathPrepend: agentExec?.pathPrepend ?? execConfig?.pathPrepend,
    safeBins: agentExec?.safeBins ?? execConfig?.safeBins,
  });

  let lastOutput = "";
  const result = await tool.execute(
    "cli-sandbox-run",
    {
      command: opts.command,
      workdir: opts.workdir,
    },
    new AbortController().signal,
    (update) => {
      if (typeof update === "object" && update !== null && Array.isArray(update.content)) {
        for (const item of update.content) {
          if (item.type === "text" && item.text && item.text !== lastOutput) {
            lastOutput = item.text;
            process.stdout.write("\x1b[2J\x1b[0;0H"); // Clear screen
            process.stdout.write(item.text);
          }
        }
      }
    },
  );

  if (result.isError) {
    runtime.error(`\nCommand failed: ${result.error}`);
    runtime.exit(1);
  } else {
    // Ensure we have a newline at the end if we had output
    if (lastOutput) {
      process.stdout.write("\n");
    }
    // Propagate the inner command's exit code if available
    const exitCode = result.details?.exitCode;
    if (typeof exitCode === "number" && exitCode !== 0) {
      runtime.exit(exitCode);
    }
  }
}
