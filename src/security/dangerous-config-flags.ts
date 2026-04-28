import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { DANGEROUS_SANDBOX_DOCKER_BOOLEAN_KEYS } from "../agents/sandbox/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  collectPluginConfigContractMatches,
  resolvePluginConfigContractsById,
} from "../plugins/config-contracts.js";
import { isRecord } from "../utils.js";
import { collectCoreInsecureOrDangerousFlags } from "./core-dangerous-config-flags.js";

function formatDangerousConfigFlagValue(value: string | number | boolean | null): string {
  return value === null ? "null" : String(value);
}

function getAgentDangerousFlagPathSegment(agent: unknown, index: number): string {
  const id =
    agent &&
    typeof agent === "object" &&
    !Array.isArray(agent) &&
    typeof (agent as { id?: unknown }).id === "string" &&
    (agent as { id: string }).id.length > 0
      ? (agent as { id: string }).id
      : undefined;
  return id ? `agents.list[id=${JSON.stringify(id)}]` : `agents.list[${index}]`;
}

export function collectEnabledInsecureOrDangerousFlags(cfg: OpenClawConfig): string[] {
  const enabledFlags = collectCoreInsecureOrDangerousFlags(cfg);

  const collectSandboxDockerDangerousFlags = (
    docker: Record<string, unknown> | undefined,
    pathPrefix: string,
  ): void => {
    if (!isRecord(docker)) {
      return;
    }
    for (const key of DANGEROUS_SANDBOX_DOCKER_BOOLEAN_KEYS) {
      if (docker[key] === true) {
        enabledFlags.push(`${pathPrefix}.${key}=true`);
      }
    }
  };

  if (cfg.hooks?.allowRequestSessionKey === true) {
    enabledFlags.push("hooks.allowRequestSessionKey=true");
  }
  if (cfg.browser?.ssrfPolicy?.dangerouslyAllowPrivateNetwork === true) {
    enabledFlags.push("browser.ssrfPolicy.dangerouslyAllowPrivateNetwork=true");
  }
  if (cfg.tools?.fs?.workspaceOnly === false) {
    enabledFlags.push("tools.fs.workspaceOnly=false");
  }
  collectSandboxDockerDangerousFlags(
    isRecord(cfg.agents?.defaults?.sandbox?.docker)
      ? cfg.agents?.defaults?.sandbox?.docker
      : undefined,
    "agents.defaults.sandbox.docker",
  );
  if (Array.isArray(cfg.agents?.list)) {
    for (const [index, agent] of cfg.agents.list.entries()) {
      collectSandboxDockerDangerousFlags(
        isRecord(agent?.sandbox?.docker) ? agent.sandbox.docker : undefined,
        `${getAgentDangerousFlagPathSegment(agent, index)}.sandbox.docker`,
      );
    }
  }
  // [HARDENED] sandbox off — skills/sub-agents run with full host access.
  if (cfg.agents?.defaults?.sandbox?.mode === "off") {
    enabledFlags.push(
      "agents.defaults.sandbox.mode=off (skills run on host without isolation — enable Docker sandbox)",
    );
  }
  // [HARDENED] mode=none disables authentication entirely — flag as dangerous.
  if (cfg.gateway?.auth?.mode === "none") {
    enabledFlags.push("gateway.auth.mode=none (authentication fully disabled)");
  }
  // [HARDENED] trusted-proxy with an empty allowUsers list accepts ALL proxy users.
  if (
    cfg.gateway?.auth?.mode === "trusted-proxy" &&
    Array.isArray(cfg.gateway?.auth?.trustedProxy?.allowUsers) &&
    cfg.gateway.auth.trustedProxy.allowUsers.length === 0
  ) {
    enabledFlags.push(
      "gateway.auth.trustedProxy.allowUsers=[] (all proxy-authenticated users accepted)",
    );
  }


  const pluginEntries = cfg.plugins?.entries;
  if (!isRecord(pluginEntries)) {
    return enabledFlags;
  }

  const configContracts = resolvePluginConfigContractsById({
    config: cfg,
    workspaceDir: resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg)),
    env: process.env,
    cache: true,
    pluginIds: Object.keys(pluginEntries),
  });
  const seenFlags = new Set<string>();
  for (const [pluginId, metadata] of configContracts.entries()) {
    const dangerousFlags = metadata.configContracts.dangerousFlags;
    if (!dangerousFlags?.length) {
      continue;
    }
    const pluginEntry = pluginEntries[pluginId];
    if (!isRecord(pluginEntry) || !isRecord(pluginEntry.config)) {
      continue;
    }
    for (const flag of dangerousFlags) {
      for (const match of collectPluginConfigContractMatches({
        root: pluginEntry.config,
        pathPattern: flag.path,
      })) {
        if (!Object.is(match.value, flag.equals)) {
          continue;
        }
        const rendered =
          `plugins.entries.${pluginId}.config.${match.path}` +
          `=${formatDangerousConfigFlagValue(flag.equals)}`;
        if (seenFlags.has(rendered)) {
          continue;
        }
        seenFlags.add(rendered);
        enabledFlags.push(rendered);
      }
    }
  }

  return enabledFlags;
}
