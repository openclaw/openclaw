import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import { loadConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import { agentViaGatewayCommand } from "./agent-via-gateway.js";

export async function sessionsWrapupCommand(
  opts: { agent?: string; summary?: string; json?: boolean; timeout?: string },
  runtime: RuntimeEnv,
) {
  const summary = opts.summary?.trim() ?? "";
  if (!summary) {
    runtime.error("--summary is required");
    runtime.exit(1);
    return;
  }

  const cfg = loadConfig();
  const agent = opts.agent?.trim() || resolveDefaultAgentId(cfg);

  await agentViaGatewayCommand(
    {
      agent,
      message: `/new ${summary}`,
      json: Boolean(opts.json),
      timeout: opts.timeout,
    },
    runtime,
  );
}
