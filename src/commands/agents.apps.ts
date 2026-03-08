import fs from "node:fs";
import {
  cleanupManagedAotuiAppArtifacts,
  deriveAotuiRegistryName,
  installNpmAotuiPackage,
  parseAotuiInstallSource,
} from "../agent-apps/install.js";
import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import type { OpenClawConfig } from "../config/config.js";
import { loadConfig, writeConfigFile } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import { listAgentEntries } from "./agents.config.js";

export type AgentsAppsEnableDisableOptions = {
  json?: boolean;
};

export type AgentsAppsInstallOptions = {
  source: string;
  as?: string;
  agent?: string;
  force?: boolean;
  select?: boolean;
  json?: boolean;
};

export type AgentsAppsUninstallOptions = {
  name: string;
  json?: boolean;
};

export async function agentsAppsEnableCommand(
  opts: AgentsAppsEnableDisableOptions,
  runtime: Pick<RuntimeEnv, "log">,
): Promise<void> {
  const cfg = loadConfig();
  const next: OpenClawConfig = {
    ...cfg,
    aotui: {
      ...cfg.aotui,
      enabled: true,
    },
  };
  await writeConfigFile(next);
  logAgentsAppsResult(
    runtime,
    opts.json,
    {
      ok: true,
      enabled: true,
      message: "Enabled Agent Apps. Restart the gateway to apply the change.",
    },
    "Enabled Agent Apps. Restart the gateway to apply the change.",
  );
}

export async function agentsAppsDisableCommand(
  opts: AgentsAppsEnableDisableOptions,
  runtime: Pick<RuntimeEnv, "log">,
): Promise<void> {
  const cfg = loadConfig();
  const next: OpenClawConfig = {
    ...cfg,
    aotui: {
      ...cfg.aotui,
      enabled: false,
    },
  };
  await writeConfigFile(next);
  logAgentsAppsResult(
    runtime,
    opts.json,
    {
      ok: true,
      enabled: false,
      message: "Disabled Agent Apps. Restart the gateway to apply the change.",
    },
    "Disabled Agent Apps. Restart the gateway to apply the change.",
  );
}

export async function agentsAppsInstallCommand(
  opts: AgentsAppsInstallOptions,
  runtime: Pick<RuntimeEnv, "log">,
): Promise<void> {
  const cfg = loadConfig();
  const parsedSource = parseAotuiInstallSource(opts.source);
  if (parsedSource.kind === "local" && !fs.existsSync(parsedSource.absolutePath)) {
    throw new Error(`Local Agent App path does not exist: ${parsedSource.absolutePath}`);
  }
  const registryName = deriveAotuiRegistryName({ parsedSource, alias: opts.as });
  if (!registryName) {
    throw new Error("Could not derive an app registry name. Pass --as <name>.");
  }

  const resolvedSource =
    parsedSource.kind === "npm"
      ? await installNpmAotuiPackage(parsedSource.packageSpec, {
          forceReinstall: opts.force,
        })
      : null;
  const source = resolvedSource?.localSource ?? parsedSource.source;

  const previousEntry = cfg.aotui?.apps?.[registryName];
  if (previousEntry && !opts.force) {
    throw new Error(`Agent app "${registryName}" already exists. Use --force to replace it.`);
  }

  let next: OpenClawConfig = {
    ...cfg,
    aotui: {
      ...cfg.aotui,
      apps: {
        ...cfg.aotui?.apps,
        [registryName]: {
          source,
          enabled: true,
        },
      },
    },
  };

  if (opts.select !== false) {
    next = applyAgentAppSelection(next, registryName, opts.agent);
  }

  await writeConfigFile(next);
  if (previousEntry && previousEntry.source !== source) {
    await cleanupManagedAotuiAppArtifacts(previousEntry.source);
  }

  const target = resolveSelectionTargetLabel(next, opts.agent);
  const lines = [
    `Installed Agent App ${registryName}.`,
    `Source: ${source}`,
    opts.select === false ? "Selection: not changed." : `Selection target: ${target}`,
    "Restart the gateway to apply the change.",
  ];
  logAgentsAppsResult(
    runtime,
    opts.json,
    {
      ok: true,
      name: registryName,
      source,
      selected: opts.select !== false,
      target,
      message: lines.join(" "),
    },
    lines.join("\n"),
  );
}

export async function agentsAppsUninstallCommand(
  opts: AgentsAppsUninstallOptions,
  runtime: Pick<RuntimeEnv, "log">,
): Promise<void> {
  const cfg = loadConfig();
  const entry = cfg.aotui?.apps?.[opts.name];
  if (!entry) {
    throw new Error(`Unknown Agent App: ${opts.name}`);
  }

  const next = pruneAgentApp(cfg, opts.name);
  await writeConfigFile(next);
  const cleanedManagedArtifacts = await cleanupManagedAotuiAppArtifacts(entry.source);

  const lines = [
    `Uninstalled Agent App ${opts.name}.`,
    cleanedManagedArtifacts
      ? "Removed managed cached artifacts."
      : "No managed cached artifacts removed.",
    "Restart the gateway to apply the change.",
  ];
  logAgentsAppsResult(
    runtime,
    opts.json,
    {
      ok: true,
      name: opts.name,
      cleanedManagedArtifacts,
      message: lines.join(" "),
    },
    lines.join("\n"),
  );
}

function applyAgentAppSelection(
  cfg: OpenClawConfig,
  appName: string,
  agentId?: string,
): OpenClawConfig {
  if (!agentId) {
    const existing = cfg.agents?.defaults?.aotui?.apps ?? [];
    return {
      ...cfg,
      agents: {
        ...cfg.agents,
        defaults: {
          ...cfg.agents?.defaults,
          aotui: {
            ...cfg.agents?.defaults?.aotui,
            apps: appendUnique(existing, appName),
          },
        },
      },
    };
  }

  const normalizedAgentId = agentId.trim().toLowerCase();
  const list = listAgentEntries(cfg);
  const index = list.findIndex((entry) => entry.id.trim().toLowerCase() === normalizedAgentId);
  if (index < 0) {
    throw new Error(`Unknown agent: ${agentId}`);
  }
  const current = list[index];
  const nextList = [...list];
  nextList[index] = {
    ...current,
    aotui: {
      ...current.aotui,
      apps: appendUnique(current.aotui?.apps ?? [], appName),
    },
  };
  return {
    ...cfg,
    agents: {
      ...cfg.agents,
      list: nextList,
    },
  };
}

function pruneAgentApp(cfg: OpenClawConfig, appName: string): OpenClawConfig {
  const nextApps = { ...cfg.aotui?.apps };
  delete nextApps[appName];

  const defaultsApps = removeName(cfg.agents?.defaults?.aotui?.apps, appName);
  const nextList = listAgentEntries(cfg).map((entry) => ({
    ...entry,
    aotui: {
      ...entry.aotui,
      apps: removeName(entry.aotui?.apps, appName),
    },
  }));

  return {
    ...cfg,
    aotui: {
      ...cfg.aotui,
      apps: Object.keys(nextApps).length > 0 ? nextApps : undefined,
    },
    agents: {
      ...cfg.agents,
      defaults: {
        ...cfg.agents?.defaults,
        aotui: {
          ...cfg.agents?.defaults?.aotui,
          apps: defaultsApps,
        },
      },
      list: nextList,
    },
  };
}

function appendUnique(values: string[], nextValue: string): string[] {
  const normalized = nextValue.trim();
  return values.includes(normalized) ? values : [...values, normalized];
}

function removeName(values: string[] | undefined, target: string): string[] | undefined {
  if (!values) {
    return undefined;
  }
  const filtered = values.filter((value) => value !== target);
  return filtered.length > 0 ? filtered : [];
}

function resolveSelectionTargetLabel(cfg: OpenClawConfig, agentId?: string): string {
  return agentId
    ? `agent:${agentId}`
    : `agents.defaults (default agent: ${resolveDefaultAgentId(cfg)})`;
}

function logAgentsAppsResult(
  runtime: Pick<RuntimeEnv, "log">,
  asJson: boolean | undefined,
  payload: Record<string, unknown>,
  text: string,
): void {
  runtime.log(asJson ? JSON.stringify(payload, null, 2) : text);
}
