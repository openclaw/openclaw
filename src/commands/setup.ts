import fs from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import {
  listAgentEntries,
  resolveAgentEntry,
  resolveAmbientOwnerAgentId,
  toAgentEntriesRecord,
} from "../agents/agent-scope-config.js";
import { formatCliCommand } from "../cli/command-format.js";
import { runWithLocalStateOwner, type OwnerRequest } from "../cli/local-state-owner.js";
import {
  configIncludeOwnsAgentRoster,
  hasResolvedRosterBeforeMigrations,
} from "../config/agent-roster-provenance.js";
import { getConfigValueAtPath } from "../config/config-paths.js";
import { applyImplicitAgentRosterDefaults } from "../config/implicit-agent-roster.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../config/types.js";
import { normalizeAgentId } from "../routing/session-key.js";
import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime, writeRuntimeJson } from "../runtime.js";
import { isRecord, resolveUserPath, shortenHomePath } from "../utils.js";

type SetupOptions = { workspace?: string; skipBootstrap?: boolean; json?: boolean };

export async function setupCommand(
  opts?: SetupOptions,
  runtime: RuntimeEnv = defaultRuntime,
): Promise<void> {
  return await runWithLocalStateOwner({
    method: "setup",
    params: {},
    target: "agent roster and workspace",
    onForeignOwner: (scope) => setupWithGatewayOwner(opts, runtime, scope),
    runLocal: () => setupUnderOwner(opts, runtime),
  });
}

async function readSetupConfig(
  opts: SetupOptions | undefined,
  runtime: RuntimeEnv,
  read?: { observe: false },
) {
  const { createConfigIO } = await import("../config/config.js");
  const io = createConfigIO();
  const prepared = await io.readConfigFileSnapshotForWrite(read);
  const snapshot = prepared.snapshot;
  if (!snapshot.exists || snapshot.valid) {
    return { ...prepared, configPath: io.configPath };
  }
  if (opts?.json) {
    const [{ formatCliJsonFailure }, { normalizeConfigIssues }] = await Promise.all([
      import("../cli/failure-output.js"),
      import("../config/issue-format.js"),
    ]);
    writeRuntimeJson(runtime, {
      ...formatCliJsonFailure(`OpenClaw config is invalid: ${shortenHomePath(io.configPath)}`),
      issues: normalizeConfigIssues(snapshot.issues),
    });
  }
  runtime.error(
    `Config invalid at ${(await import("../config/logging.js")).formatConfigFilePath(io.configPath)}. Run \`${formatCliCommand("openclaw doctor --fix")}\` to apply supported repairs, then re-run setup.`,
  );
  runtime.exit(1);
  return undefined;
}

/** The config change setup owns, shared by the offline writer and the Gateway-routed patch. */
async function planSetupConfig(snapshot: ConfigFileSnapshot, opts: SetupOptions | undefined) {
  const desiredWorkspace =
    typeof opts?.workspace === "string" && opts.workspace.trim()
      ? opts.workspace.trim()
      : undefined;
  const resolvedConfig = snapshot.config;
  const shouldPersistRoster =
    !snapshot.exists ||
    (!hasResolvedRosterBeforeMigrations(snapshot) && !configIncludeOwnsAgentRoster(snapshot));
  const cfg = shouldPersistRoster
    ? (applyImplicitAgentRosterDefaults(snapshot.sourceConfig) as OpenClawConfig)
    : snapshot.sourceConfig;
  const authoredDefaults = cfg.agents?.defaults ?? {};
  const resolvedDefaults = resolvedConfig.agents?.defaults ?? authoredDefaults;
  const skipBootstrap = opts?.skipBootstrap === true || resolvedDefaults.skipBootstrap === true;
  const shouldWriteSkipBootstrap =
    opts?.skipBootstrap === true && resolvedDefaults.skipBootstrap !== true;
  const skipBootstrapPath = ["agents", "defaults", "skipBootstrap"];
  if (
    shouldWriteSkipBootstrap &&
    snapshot.includeProvenance?.some(
      ({ path }) =>
        path.length === skipBootstrapPath.length &&
        path.every((part, index) => part === skipBootstrapPath[index]),
    )
  ) {
    throw new Error(
      "Baseline setup cannot override an included agents.defaults.skipBootstrap value. Edit the included file directly.",
    );
  }
  const isInheritedPath = (defaultPath: string[]) => {
    return (
      isRecord(snapshot.parsed) &&
      getConfigValueAtPath(snapshot.parsed, defaultPath) === undefined &&
      snapshot.includeProvenance?.some(
        ({ path }) =>
          path.length < defaultPath.length &&
          path.every((part, index) => part === defaultPath[index]),
      ) === true
    );
  };
  const writeInheritedSkipBootstrapOverride =
    shouldWriteSkipBootstrap && isInheritedPath(skipBootstrapPath);
  const selectedAgentId = resolveAmbientOwnerAgentId(resolvedConfig, undefined, {
    surface: "baseline setup",
    hint: "Set agents.defaults.systemAgent.agentId.",
  });
  const defaultEntry = resolveAgentEntry(resolvedConfig, selectedAgentId);
  const defaultEntryWorkspace = defaultEntry?.workspace?.trim();
  const configuredWorkspace = defaultEntryWorkspace || resolvedDefaults.workspace;

  const workspace =
    desiredWorkspace ??
    configuredWorkspace ??
    (await import("../agents/workspace.js")).DEFAULT_AGENT_WORKSPACE_DIR;
  // Bare setup is observational for an established roster. Only a caller
  // override or fresh bootstrap owns a persisted workspace change.
  const shouldWriteWorkspace =
    !snapshot.exists || (desiredWorkspace !== undefined && configuredWorkspace !== workspace);
  const shouldWriteGatewayMode = resolvedConfig.gateway?.mode === undefined;
  const writeInheritedGatewayModeOverride =
    shouldWriteGatewayMode && isInheritedPath(["gateway", "mode"]);
  const writeInheritedWorkspaceOverride =
    snapshot.exists &&
    shouldWriteWorkspace &&
    !defaultEntryWorkspace &&
    isInheritedPath(["agents", "defaults", "workspace"]);

  // Inherited include values become local overrides through explicit paths, not the candidate.
  const applyWrites = (base: OpenClawConfig): OpenClawConfig => {
    let next = base;
    if (shouldPersistRoster) {
      next = {
        ...next,
        agents: { ...next.agents, entries: toAgentEntriesRecord(listAgentEntries(cfg)) },
      };
    }
    if (shouldWriteWorkspace && !writeInheritedWorkspaceOverride) {
      const roster = listAgentEntries(next);
      const entries = roster.length > 0 ? toAgentEntriesRecord(roster) : undefined;
      if (snapshot.exists && defaultEntryWorkspace && entries) {
        for (const [id, entry] of Object.entries(entries)) {
          if (normalizeAgentId(id) === selectedAgentId) {
            // The converter owns this row; fresh and inherited workspaces stay in defaults.
            entry.workspace = workspace;
          }
        }
      }
      next = {
        ...next,
        agents: {
          ...next.agents,
          defaults: { ...next.agents?.defaults, workspace },
          ...(entries ? { entries } : {}),
        },
      };
    }
    if (shouldWriteGatewayMode && !writeInheritedGatewayModeOverride) {
      next = { ...next, gateway: { ...next.gateway, mode: "local" } };
    }
    if (shouldWriteSkipBootstrap && !writeInheritedSkipBootstrapOverride) {
      next = {
        ...next,
        agents: { ...next.agents, defaults: { ...next.agents?.defaults, skipBootstrap: true } },
      };
    }
    return next;
  };

  const explicitSetPaths: string[][] = [];
  if (snapshot.exists && shouldPersistRoster) {
    explicitSetPaths.push(["agents", "entries"]);
  }
  if (writeInheritedWorkspaceOverride) {
    explicitSetPaths.push(["agents", "defaults", "workspace"]);
  }
  if (shouldWriteSkipBootstrap) {
    explicitSetPaths.push(skipBootstrapPath);
  }
  if (shouldWriteGatewayMode) {
    explicitSetPaths.push(["gateway", "mode"]);
  }
  const updates: string[] = [];
  if (shouldWriteWorkspace) {
    updates.push("set agents.defaults.workspace");
  }
  if (shouldWriteGatewayMode) {
    updates.push("set gateway.mode");
  }
  if (shouldWriteSkipBootstrap) {
    updates.push("set agents.defaults.skipBootstrap");
  }
  return {
    cfg,
    workspace,
    selectedAgentId,
    skipBootstrap,
    skipOptionalBootstrapFiles: resolvedDefaults.skipOptionalBootstrapFiles,
    applyWrites,
    configChanged:
      !snapshot.exists ||
      shouldPersistRoster ||
      shouldWriteWorkspace ||
      shouldWriteGatewayMode ||
      shouldWriteSkipBootstrap,
    updateSuffix: updates.length > 0 ? `(${updates.join(", ")})` : undefined,
    explicitSetPaths,
    writesInheritedOverride:
      writeInheritedWorkspaceOverride ||
      writeInheritedGatewayModeOverride ||
      writeInheritedSkipBootstrapOverride,
    explicitSetValueSource: {
      ...(shouldWriteGatewayMode ? { gateway: { mode: "local" } } : {}),
      agents: {
        ...(snapshot.exists && shouldPersistRoster ? { entries: cfg.agents?.entries } : {}),
        defaults: {
          ...(writeInheritedWorkspaceOverride ? { workspace } : {}),
          ...(shouldWriteSkipBootstrap ? { skipBootstrap: true } : {}),
        },
      },
    } satisfies OpenClawConfig,
    allowIncludeAncestorExplicitSetPaths:
      writeInheritedWorkspaceOverride || shouldWriteSkipBootstrap || shouldWriteGatewayMode,
  };
}

async function setupUnderOwner(opts: SetupOptions | undefined, runtime: RuntimeEnv): Promise<void> {
  const prepared = await readSetupConfig(opts, runtime);
  if (!prepared) {
    return;
  }
  const { snapshot, configPath } = prepared;
  const plan = await planSetupConfig(snapshot, opts);
  const { workspace, selectedAgentId } = plan;

  // Keep the candidate runtime-shaped. replaceConfigFile persists only its
  // diff against snapshot.parsed, never resolved include/env values wholesale.
  let next = plan.applyWrites(snapshot.exists ? snapshot.config : plan.cfg);

  let creationConfigHash: string | undefined;
  if (!snapshot.exists) {
    const { ensureOnboardingAgent } = await import("./onboard-agent.js");
    const onboardingAgent = await ensureOnboardingAgent({
      config: next,
      workspace,
      baseConfig: plan.cfg,
      expectedConfigHash: snapshot.hash ?? null,
    });
    next = onboardingAgent.config;
    creationConfigHash = onboardingAgent.configHash;
    for (const warning of onboardingAgent.sessionMigrationWarnings ?? []) {
      runtime.log(`Warning: ${warning}`);
    }
  }

  if (plan.configChanged) {
    const { replaceConfigFile } = await import("../config/config.js");
    // Preserve inherited values in the candidate; explicit leaves become local overrides.
    await replaceConfigFile({
      nextConfig: next,
      // Agent creation advanced the revision; keep rejecting foreign writes after it.
      ...(creationConfigHash ? { baseHash: creationConfigHash } : { snapshot }),
      afterWrite: { mode: "auto" },
      writeOptions: {
        ...prepared.writeOptions,
        explicitSetPaths: plan.explicitSetPaths,
        explicitSetValueSource: plan.explicitSetValueSource,
        allowIncludeAncestorExplicitSetPaths: plan.allowIncludeAncestorExplicitSetPaths,
      },
    });
    if (!opts?.json && !snapshot.exists) {
      runtime.log(
        `Wrote ${(await import("../config/logging.js")).formatConfigFilePath(configPath)}`,
      );
    } else if (!opts?.json) {
      (await import("../config/logging.js")).logConfigUpdated(runtime, {
        path: configPath,
        suffix: plan.updateSuffix,
      });
    }
  } else if (!opts?.json) {
    runtime.log(
      `Config OK: ${(await import("../config/logging.js")).formatConfigFilePath(configPath)}`,
    );
  }

  const ws = await (
    await import("../agents/workspace.js")
  ).ensureAgentWorkspace({
    dir: workspace,
    ensureBootstrapFiles: !plan.skipBootstrap,
    skipOptionalBootstrapFiles: plan.skipOptionalBootstrapFiles,
  });
  if (!opts?.json) {
    runtime.log(`Workspace OK: ${shortenHomePath(ws.dir)}`);
  }

  const sessionsDir = await ensureSessionsDir(selectedAgentId);
  const { provisionDefaultProactiveJob } = await import("../cron/default-proactive-job.js");
  await provisionDefaultProactiveJob(next, selectedAgentId);
  const { initializeFreshDaemonRuntimePinMigration } =
    await import("../infra/state-migrations.daemon-runtime-pins.js");
  initializeFreshDaemonRuntimePinMigration(process.env);
  finishSetup(opts, runtime, {
    configPath,
    configStatus: plan.configChanged ? (snapshot.exists ? "updated" : "created") : "unchanged",
    workspaceDir: ws.dir,
    sessionsDir,
  });
}

/**
 * A running Gateway owns config, the state database and workspace setup state. Setup sends
 * only its config change, as the offline writer would save it, through config.patch. The
 * Gateway seeds the workspace when the agent first runs; its startup already completed the
 * runtime-pin migration, and agent creation provisioned the proactive job.
 */
async function setupWithGatewayOwner(
  opts: SetupOptions | undefined,
  runtime: RuntimeEnv,
  scope: { env: NodeJS.ProcessEnv; requestOwner: OwnerRequest },
): Promise<void> {
  const { bindConfigOwner, prepareConfigOwnerChange } =
    await import("../cli/config-cli-owner-patch.js");
  const commit = await bindConfigOwner(scope.requestOwner, scope.env);
  const prepared = await readSetupConfig(opts, runtime, { observe: false });
  if (!prepared) {
    return;
  }
  const { snapshot, configPath, writeOptions } = prepared;
  const offlineOnly = (reason: string) =>
    new Error(
      `${reason} Nothing was sent and no settings were saved. Stop the Gateway through its service owner, wait for ownership to release, then rerun this exact command.`,
    );
  if (!snapshot.exists) {
    throw offlineOnly("The running Gateway has no config file, so setup must create it offline.");
  }
  const plan = await planSetupConfig(snapshot, opts);
  if (plan.writesInheritedOverride) {
    throw offlineOnly("Setup would override a value inherited from an included config file.");
  }
  let configChanged = plan.configChanged;
  let restartHint: string | undefined;
  if (configChanged) {
    const [{ assertConfigWriteAllowedInCurrentMode }, { prepareConfigWriteValues }] =
      await Promise.all([
        import("../config/config-write-guard.js"),
        import("../config/io.write-prepare.js"),
      ]);
    assertConfigWriteAllowedInCurrentMode({ configPath: snapshot.path });
    const env = writeOptions.envSnapshotForRestore ?? process.env;
    const author = (nextConfig: OpenClawConfig, explicitSetPaths?: string[][]) =>
      prepareConfigWriteValues({ snapshot, nextConfig, explicitSetPaths, env }).authoredConfig;
    const change = await prepareConfigOwnerChange({
      snapshot,
      pluginMetadataSnapshot: writeOptions.basePluginMetadataSnapshot,
      previous: author(snapshot.resolved),
      next: author(plan.applyWrites(snapshot.resolved), plan.explicitSetPaths),
      explicitSetPaths: plan.explicitSetPaths,
      unsetPaths: [],
      env,
    });
    configChanged = !isDeepStrictEqual(change.previous, change.next);
    if (configChanged) {
      restartHint = await commit(change);
    }
  }
  if (!opts?.json) {
    const logging = await import("../config/logging.js");
    if (configChanged) {
      logging.logConfigUpdated(runtime, { path: configPath, suffix: plan.updateSuffix });
    } else {
      runtime.log(`Config OK: ${logging.formatConfigFilePath(configPath)}`);
    }
    if (restartHint) {
      runtime.log(restartHint);
    }
    runtime.log(
      `Workspace: ${shortenHomePath(resolveUserPath(plan.workspace))} (owned by the running Gateway, which seeds missing files on the agent's first run)`,
    );
  }
  finishSetup(opts, runtime, {
    configPath,
    configStatus: configChanged ? "updated" : "unchanged",
    workspaceDir: resolveUserPath(plan.workspace),
    sessionsDir: await ensureSessionsDir(plan.selectedAgentId),
  });
}

async function ensureSessionsDir(agentId: string): Promise<string> {
  const { resolveSessionTranscriptsDirForAgent } = await import("../config/sessions.js");
  const sessionsDir = resolveSessionTranscriptsDirForAgent(agentId);
  await fs.mkdir(sessionsDir, { recursive: true });
  return sessionsDir;
}

function finishSetup(
  opts: SetupOptions | undefined,
  runtime: RuntimeEnv,
  result: {
    configPath: string;
    configStatus: "created" | "updated" | "unchanged";
    workspaceDir: string;
    sessionsDir: string;
  },
): void {
  if (opts?.json) {
    writeRuntimeJson(runtime, { ok: true, ...result });
    return;
  }
  runtime.log(`Sessions OK: ${shortenHomePath(result.sessionsDir)}`);
  runtime.log("");
  runtime.log("Setup complete: config, workspace, and session directories are ready.");
  runtime.log(`Next guided path: ${formatCliCommand("openclaw onboard")}.`);
  runtime.log(
    `Next targeted changes: ${formatCliCommand("openclaw configure")} for models, channels, Gateway, plugins, skills, and health checks.`,
  );
  runtime.log(`Add a chat channel later: ${formatCliCommand("openclaw channels add")}.`);
}
