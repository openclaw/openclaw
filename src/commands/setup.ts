/**
 * Minimal setup command.
 *
 * Ensures config, default workspace, and session directories exist without
 * running the full onboarding wizard.
 */
import fs from "node:fs/promises";
import {
  listAgentEntries,
  resolveAgentEntry,
  resolveAmbientOwnerAgentId,
  toAgentEntriesRecord,
} from "../agents/agent-scope-config.js";
import { formatCliCommand } from "../cli/command-format.js";
import {
  configIncludeOwnsAgentRoster,
  hasResolvedRosterBeforeMigrations,
} from "../config/agent-roster-provenance.js";
import { getConfigValueAtPath } from "../config/config-paths.js";
import { migratePersistedImplicitMainRoster } from "../config/legacy.js";
import type { OpenClawConfig } from "../config/types.js";
import { normalizeAgentId } from "../routing/session-key.js";
import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime, writeRuntimeJson } from "../runtime.js";
import { createLazyPromise } from "../shared/lazy-promise.js";
import { isRecord, shortenHomePath } from "../utils.js";

// Keep setup's cold path small; load each owner only when the command needs it.
const loadAgentWorkspaceModule = createLazyPromise(() => import("../agents/workspace.js"));
const loadConfigIOModule = createLazyPromise(() => import("../config/config.js"));
const loadConfigLoggingModule = createLazyPromise(() => import("../config/logging.js"));

/** Prepares config, workspace, and session directories for a usable installation. */
export async function setupCommand(
  opts?: { workspace?: string; skipBootstrap?: boolean; json?: boolean },
  runtime: RuntimeEnv = defaultRuntime,
) {
  const desiredWorkspace =
    typeof opts?.workspace === "string" && opts.workspace.trim()
      ? opts.workspace.trim()
      : undefined;

  const { createConfigIO, replaceConfigFile } = await loadConfigIOModule();
  const io = createConfigIO();
  const configPath = io.configPath;
  const prepared = await io.readConfigFileSnapshotForWrite();
  const snapshot = prepared.snapshot;
  if (snapshot.exists && !snapshot.valid) {
    if (opts?.json) {
      const { writeInvalidConfigCliJson } = await import("../cli/config-validation-output.js");
      writeInvalidConfigCliJson(runtime, snapshot);
    }
    const { formatConfigReadFailure } = await import("../config/io.invalid-config.js");
    runtime.error(
      formatConfigReadFailure(snapshot) ??
        `Config invalid at ${(await loadConfigLoggingModule()).formatConfigFilePath(configPath)}. Run \`${formatCliCommand("openclaw doctor --fix")}\` to apply supported repairs, then re-run setup.`,
    );
    runtime.exit(1);
    return;
  }

  const resolvedConfig = snapshot.config;
  const shouldPersistRoster =
    !snapshot.exists ||
    (!hasResolvedRosterBeforeMigrations(snapshot) && !configIncludeOwnsAgentRoster(snapshot));
  const cfg = shouldPersistRoster
    ? (migratePersistedImplicitMainRoster(snapshot.sourceConfig).config as OpenClawConfig)
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
    (await loadAgentWorkspaceModule()).DEFAULT_AGENT_WORKSPACE_DIR;
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

  // Keep the candidate runtime-shaped. replaceConfigFile persists only its
  // diff against snapshot.parsed, never resolved include/env values wholesale.
  let next: OpenClawConfig = snapshot.exists ? resolvedConfig : cfg;
  if (shouldPersistRoster) {
    const { list: _legacyList, ...agents } = next.agents ?? {};
    next = {
      ...next,
      agents: { ...agents, entries: toAgentEntriesRecord(listAgentEntries(cfg)) },
    };
  }
  if (shouldWriteWorkspace) {
    if (!writeInheritedWorkspaceOverride) {
      const roster = structuredClone(listAgentEntries(next));
      if (!snapshot.exists || Boolean(defaultEntryWorkspace)) {
        for (const entry of roster) {
          if (
            snapshot.exists &&
            defaultEntryWorkspace &&
            normalizeAgentId(entry.id) === selectedAgentId
          ) {
            // An explicit workspace follows the resolved setup owner. Fresh and inherited
            // workspaces stay in defaults so setup does not duplicate them into the roster.
            entry.workspace = workspace;
          }
        }
      }
      const entries = roster.length > 0 ? toAgentEntriesRecord(roster) : undefined;
      const { list: _legacyList, ...agents } = next.agents ?? {};
      next = {
        ...next,
        agents: {
          ...agents,
          defaults: { ...agents.defaults, workspace },
          ...(entries ? { entries } : {}),
        },
      };
    }
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

  let creationConfigHash: string | undefined;
  if (!snapshot.exists) {
    const { ensureOnboardingAgent } = await import("./onboard-agent.js");
    const onboardingAgent = await ensureOnboardingAgent({
      config: next,
      workspace,
      baseConfig: cfg,
      expectedConfigHash: snapshot.hash ?? null,
    });
    next = onboardingAgent.config;
    creationConfigHash = onboardingAgent.configHash;
    for (const warning of onboardingAgent.sessionMigrationWarnings ?? []) {
      runtime.log(`Warning: ${warning}`);
    }
  }

  const configChanged =
    !snapshot.exists ||
    shouldPersistRoster ||
    shouldWriteWorkspace ||
    shouldWriteGatewayMode ||
    shouldWriteSkipBootstrap;
  let configStatus: "created" | "updated" | "unchanged";
  if (configChanged) {
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
    // Preserve inherited values in the candidate; explicit leaves become local overrides.
    await replaceConfigFile({
      nextConfig: next,
      // Agent creation advanced the revision; keep rejecting foreign writes after it.
      ...(creationConfigHash ? { baseHash: creationConfigHash } : { snapshot }),
      afterWrite: { mode: "auto" },
      writeOptions: {
        ...prepared.writeOptions,
        explicitSetPaths,
        explicitSetValueSource: {
          ...(shouldWriteGatewayMode ? { gateway: { mode: "local" } } : {}),
          agents: {
            ...(snapshot.exists && shouldPersistRoster ? { entries: cfg.agents?.entries } : {}),
            defaults: {
              ...(writeInheritedWorkspaceOverride ? { workspace } : {}),
              ...(shouldWriteSkipBootstrap ? { skipBootstrap: true } : {}),
            },
          },
        },
        allowIncludeAncestorExplicitSetPaths:
          writeInheritedWorkspaceOverride || shouldWriteSkipBootstrap || shouldWriteGatewayMode,
      },
    });
    configStatus = snapshot.exists ? "updated" : "created";
    if (!opts?.json && !snapshot.exists) {
      runtime.log(`Wrote ${(await loadConfigLoggingModule()).formatConfigFilePath(configPath)}`);
    } else if (!opts?.json) {
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
      const suffix = updates.length > 0 ? `(${updates.join(", ")})` : undefined;
      (await loadConfigLoggingModule()).logConfigUpdated(runtime, {
        path: configPath,
        suffix,
      });
    }
  } else {
    configStatus = "unchanged";
    if (!opts?.json) {
      runtime.log(
        `Config OK: ${(await loadConfigLoggingModule()).formatConfigFilePath(configPath)}`,
      );
    }
  }

  const ws = await (
    await loadAgentWorkspaceModule()
  ).ensureAgentWorkspace({
    dir: workspace,
    ensureBootstrapFiles: !skipBootstrap,
    skipOptionalBootstrapFiles: resolvedDefaults.skipOptionalBootstrapFiles,
  });
  if (!opts?.json) {
    runtime.log(`Workspace OK: ${shortenHomePath(ws.dir)}`);
  }

  const { resolveSessionTranscriptsDirForAgent } = await import("../config/sessions.js");
  const sessionsDir = resolveSessionTranscriptsDirForAgent(selectedAgentId);
  await fs.mkdir(sessionsDir, { recursive: true });
  if (opts?.json) {
    writeRuntimeJson(runtime, {
      ok: true,
      configPath,
      configStatus,
      workspaceDir: ws.dir,
      sessionsDir,
    });
    return;
  }
  runtime.log(`Sessions OK: ${shortenHomePath(sessionsDir)}`);
  runtime.log("");
  runtime.log("Setup complete: config, workspace, and session directories are ready.");
  runtime.log(`Next guided path: ${formatCliCommand("openclaw onboard")}.`);
  runtime.log(
    `Next targeted changes: ${formatCliCommand("openclaw configure")} for models, channels, Gateway, plugins, skills, and health checks.`,
  );
  runtime.log(`Add a chat channel later: ${formatCliCommand("openclaw channels add")}.`);
}
