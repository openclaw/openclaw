// Implements default-agent reassignment for configured agent rosters.
import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import { formatCliCommand } from "../cli/command-format.js";
import { replaceConfigFile } from "../config/config.js";
import { logConfigUpdated } from "../config/logging.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";
import { requireValidConfigFileSnapshot } from "./agents.command-shared.js";
import { findAgentEntryIndex, listAgentEntries } from "./agents.config.js";

type AgentsSetDefaultOptions = {
  id: string;
  json?: boolean;
};

/** Reassign the default marker in one validated config write. */
export async function agentsSetDefaultCommand(
  opts: AgentsSetDefaultOptions,
  runtime: RuntimeEnv = defaultRuntime,
) {
  const configSnapshot = await requireValidConfigFileSnapshot(runtime);
  if (!configSnapshot) {
    return;
  }
  const cfg = configSnapshot.sourceConfig ?? configSnapshot.config;
  const baseHash = configSnapshot.hash;

  const input = opts.id?.trim();
  if (!input) {
    runtime.error(
      `Agent id is required. Run ${formatCliCommand("openclaw agents list")} to choose one.`,
    );
    runtime.exit(1);
    return;
  }

  const agentId = normalizeAgentId(input);
  const entries = listAgentEntries(cfg);
  if (findAgentEntryIndex(entries, agentId) < 0) {
    runtime.error(
      `Agent "${agentId}" not found. Run ${formatCliCommand("openclaw agents list")} to see configured agents.`,
    );
    runtime.exit(1);
    return;
  }

  if (agentId === resolveDefaultAgentId(cfg)) {
    if (opts.json) {
      writeRuntimeJson(runtime, { agentId, changed: false });
    } else {
      runtime.log(`Agent "${agentId}" is already the default.`);
    }
    return;
  }

  const nextEntries = Object.fromEntries(
    entries.map((entry) => {
      const { default: _default, id, ...config } = entry;
      return [id, normalizeAgentId(id) === agentId ? { ...config, default: true } : config];
    }),
  );
  const { list: _legacyList, ...agentsConfig } = cfg.agents ?? {};
  const nextConfig = {
    ...cfg,
    agents: {
      ...agentsConfig,
      entries: nextEntries,
    },
  };

  await replaceConfigFile({
    nextConfig,
    ...(baseHash !== undefined ? { baseHash } : {}),
  });

  if (opts.json) {
    writeRuntimeJson(runtime, { agentId, changed: true });
    return;
  }
  logConfigUpdated(runtime);
  runtime.log(`Default agent: ${agentId}`);
}
