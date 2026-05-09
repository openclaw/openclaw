import fs from "node:fs/promises";
import path from "node:path";
import {
  importLegacyAcpEventLedgerFileToSqlite,
  legacyAcpEventLedgerFileExists,
} from "../acp/event-ledger.js";
import {
  discoverLegacyAuthProfileStateAgentDirs,
  importLegacyAuthProfileStateFileToSqlite,
} from "../agents/auth-profiles/state.js";
import {
  importLegacyOpenRouterModelCapabilitiesCacheToSqlite,
  legacyOpenRouterModelCapabilitiesCacheExists,
} from "../agents/pi-embedded-runner/openrouter-model-capabilities.js";
import {
  importLegacySubagentRegistryFileToSqlite,
  legacySubagentRegistryFileExists,
} from "../agents/subagent-registry.store.js";
import {
  importLegacyCommitmentStoreFileToSqlite,
  legacyCommitmentStoreFileExists,
} from "../commitments/store.js";
import type { OpenClawConfig } from "../config/config.js";
import { writeConfigHealthStateToSqlite, type ConfigHealthState } from "../config/health-state.js";
import { resolveStateDir } from "../config/paths.js";
import {
  importLegacyManagedOutgoingImageRecordFilesToSqlite,
  legacyManagedOutgoingImageRecordFilesExist,
} from "../gateway/managed-image-attachments.js";
import {
  importLegacyDeviceAuthFileToSqlite,
  legacyDeviceAuthFileExists,
} from "../infra/device-auth-store.js";
import {
  importLegacyDeviceBootstrapFileToSqlite,
  legacyDeviceBootstrapFileExists,
} from "../infra/device-bootstrap.js";
import {
  importLegacyDeviceIdentityFileToSqlite,
  legacyDeviceIdentityFileExists,
} from "../infra/device-identity.js";
import {
  importLegacyExecApprovalsFileToSqlite,
  legacyExecApprovalsFileExists,
} from "../infra/exec-approvals-migration.js";
import {
  importLegacyPairingStateFilesToSqlite,
  legacyPairingStateFilesExist,
} from "../infra/pairing-files.js";
import {
  importLegacyApnsRegistrationFileToSqlite,
  legacyApnsRegistrationFileExists,
} from "../infra/push-apns.js";
import { importLegacyWebPushFilesToSqlite, legacyWebPushFilesExist } from "../infra/push-web.js";
import {
  importLegacyUpdateCheckFileToSqlite,
  legacyUpdateCheckFileExists,
} from "../infra/update-startup.js";
import {
  importLegacyVoiceWakeRoutingConfigFileToSqlite,
  legacyVoiceWakeRoutingConfigFileExists,
} from "../infra/voicewake-routing.js";
import {
  importLegacyVoiceWakeConfigFileToSqlite,
  legacyVoiceWakeConfigFileExists,
} from "../infra/voicewake.js";
import { importLegacyMediaFilesToSqlite, legacyMediaFilesExist } from "../media/store.js";
import {
  importLegacyMemoryCoreDreamingStateFilesToSqlite,
  legacyMemoryCoreDreamingStateFilesExist,
} from "../memory-host-sdk/dreaming-state-migration.js";
import {
  importLegacyNodeHostConfigFileToSqlite,
  legacyNodeHostConfigFileExists,
} from "../node-host/config.js";
import {
  importLegacyChannelPairingFilesToSqlite,
  legacyChannelPairingFilesExist,
} from "../pairing/pairing-store.js";
import {
  importLegacyPluginBindingApprovalFileToSqlite,
  legacyPluginBindingApprovalFileExists,
} from "../plugins/conversation-binding.js";
import {
  importLegacyInstalledPluginIndexFileToSqlite,
  legacyInstalledPluginIndexFileExists,
} from "../plugins/installed-plugin-index-legacy-migration.js";
import { note } from "../terminal/note.js";
import {
  importLegacyTuiLastSessionStoreToSqlite,
  legacyTuiLastSessionFileExists,
} from "../tui/tui-last-session.js";
import type { DoctorPrompter } from "./doctor-prompter.js";

type LegacyStateProbe = {
  deviceIdentity: boolean;
  deviceAuth: boolean;
  deviceBootstrap: boolean;
  devicePairing: boolean;
  execApprovals: boolean;
  nodePairing: boolean;
  nodeHostConfig: boolean;
  channelPairing: boolean;
  commitments: boolean;
  webPush: boolean;
  apns: boolean;
  updateCheck: boolean;
  configHealth: boolean;
  managedImages: boolean;
  mediaFiles: boolean;
  pluginBindingApprovals: boolean;
  installedPluginIndex: boolean;
  subagents: boolean;
  tuiLastSession: boolean;
  acpEventLedger: boolean;
  voiceWake: boolean;
  voiceWakeRouting: boolean;
  authProfileStateAgentDirs: string[];
  openRouterModelCache: boolean;
  memoryCoreDreamingState: boolean;
};

function resolveLegacyConfigHealthPath(baseDir: string): string {
  return path.join(baseDir, "logs", "config-health.json");
}

async function legacyConfigHealthFileExists(baseDir: string): Promise<boolean> {
  try {
    return (await fs.stat(resolveLegacyConfigHealthPath(baseDir))).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function importLegacyConfigHealthFileToSqlite(params: {
  env: NodeJS.ProcessEnv;
  baseDir: string;
}): Promise<{ imported: boolean; entries: number }> {
  const filePath = resolveLegacyConfigHealthPath(params.baseDir);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return { imported: false, entries: 0 };
    }
    throw error;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { imported: false, entries: 0 };
  }
  const state = parsed as ConfigHealthState;
  writeConfigHealthStateToSqlite(params.env, () => params.baseDir, state);
  await fs.rm(filePath, { force: true }).catch(() => undefined);
  return {
    imported: true,
    entries:
      state.entries && typeof state.entries === "object" && !Array.isArray(state.entries)
        ? Object.keys(state.entries).length
        : 0,
  };
}

async function probeLegacyRuntimeStateFiles(params: {
  env: NodeJS.ProcessEnv;
  cfg?: OpenClawConfig;
}): Promise<LegacyStateProbe> {
  const env = params.env;
  const baseDir = resolveStateDir(env);
  return {
    deviceIdentity: legacyDeviceIdentityFileExists(env),
    deviceAuth: legacyDeviceAuthFileExists(env),
    deviceBootstrap: await legacyDeviceBootstrapFileExists(baseDir),
    devicePairing: await legacyPairingStateFilesExist({ baseDir, subdir: "devices" }),
    execApprovals: legacyExecApprovalsFileExists(env),
    nodePairing: await legacyPairingStateFilesExist({ baseDir, subdir: "nodes" }),
    nodeHostConfig: await legacyNodeHostConfigFileExists(env),
    channelPairing: await legacyChannelPairingFilesExist(env),
    commitments: await legacyCommitmentStoreFileExists(env),
    webPush: await legacyWebPushFilesExist(baseDir),
    apns: await legacyApnsRegistrationFileExists(baseDir),
    updateCheck: await legacyUpdateCheckFileExists(env),
    configHealth: await legacyConfigHealthFileExists(baseDir),
    managedImages: await legacyManagedOutgoingImageRecordFilesExist(baseDir),
    mediaFiles: await legacyMediaFilesExist(env),
    pluginBindingApprovals: legacyPluginBindingApprovalFileExists(),
    installedPluginIndex: legacyInstalledPluginIndexFileExists({ env, stateDir: baseDir }),
    subagents: legacySubagentRegistryFileExists(env),
    tuiLastSession: await legacyTuiLastSessionFileExists({ stateDir: baseDir }),
    acpEventLedger: legacyAcpEventLedgerFileExists(env),
    voiceWake: await legacyVoiceWakeConfigFileExists(baseDir),
    voiceWakeRouting: await legacyVoiceWakeRoutingConfigFileExists(baseDir),
    authProfileStateAgentDirs: discoverLegacyAuthProfileStateAgentDirs(env),
    openRouterModelCache: legacyOpenRouterModelCapabilitiesCacheExists(env),
    memoryCoreDreamingState: params.cfg
      ? await legacyMemoryCoreDreamingStateFilesExist({ cfg: params.cfg })
      : false,
  };
}

function hasLegacyRuntimeStateFiles(probe: LegacyStateProbe): boolean {
  return Object.values(probe).some((value) => (Array.isArray(value) ? value.length > 0 : value));
}

export async function maybeRepairLegacyRuntimeStateFiles(params: {
  prompter: Pick<DoctorPrompter, "shouldRepair">;
  env?: NodeJS.ProcessEnv;
  cfg?: OpenClawConfig;
}): Promise<void> {
  const env = params.env ?? process.env;
  const baseDir = resolveStateDir(env);
  const probe = await probeLegacyRuntimeStateFiles({ env, cfg: params.cfg });
  if (!hasLegacyRuntimeStateFiles(probe)) {
    return;
  }
  if (!params.prompter.shouldRepair) {
    note(
      "Legacy runtime state files detected. Run `openclaw doctor --fix` to import commitments, device, bootstrap, exec approvals, channel pairing, node pairing, node host config, push, media, plugin binding approvals, installed plugin index, subagent, TUI, ACP event ledger, Voice Wake, memory-core dreaming checkpoints, auth routing, OpenRouter cache, and update-check state into SQLite.",
      "SQLite state",
    );
    return;
  }

  const changes: string[] = [];
  const warnings: string[] = [];
  const runImport = async (label: string, operation: () => Promise<void> | void) => {
    try {
      await operation();
    } catch (error) {
      warnings.push(`- ${label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  if (probe.deviceIdentity) {
    await runImport("Device identity", () => {
      const result = importLegacyDeviceIdentityFileToSqlite(env);
      if (result.imported) {
        changes.push("- Imported device identity into SQLite.");
      }
    });
  }
  if (probe.deviceAuth) {
    await runImport("Device auth", () => {
      const result = importLegacyDeviceAuthFileToSqlite(env);
      if (result.imported) {
        changes.push(`- Imported ${result.tokens} device auth token(s) into SQLite.`);
      }
    });
  }
  if (probe.deviceBootstrap) {
    await runImport("Device bootstrap", async () => {
      const result = await importLegacyDeviceBootstrapFileToSqlite(baseDir);
      if (result.imported) {
        changes.push(`- Imported ${result.tokens} device bootstrap token(s) into SQLite.`);
      }
    });
  }
  if (probe.devicePairing) {
    await runImport("Device pairing", async () => {
      const result = await importLegacyPairingStateFilesToSqlite({ baseDir, subdir: "devices" });
      if (result.files > 0) {
        changes.push(
          `- Imported ${result.pending} pending device pairing request(s) and ${result.paired} paired device record(s) into SQLite.`,
        );
      }
    });
  }
  if (probe.execApprovals) {
    await runImport("Exec approvals", () => {
      const result = importLegacyExecApprovalsFileToSqlite(env);
      if (result.imported) {
        changes.push("- Imported exec approvals into SQLite.");
      }
    });
  }
  if (probe.nodePairing) {
    await runImport("Node pairing", async () => {
      const result = await importLegacyPairingStateFilesToSqlite({ baseDir, subdir: "nodes" });
      if (result.files > 0) {
        changes.push(
          `- Imported ${result.pending} pending node pairing request(s) and ${result.paired} paired node record(s) into SQLite.`,
        );
      }
    });
  }
  if (probe.nodeHostConfig) {
    await runImport("Node host config", async () => {
      const result = await importLegacyNodeHostConfigFileToSqlite(env);
      if (result.imported) {
        changes.push("- Imported node host config into SQLite.");
      }
    });
  }
  if (probe.channelPairing) {
    await runImport("Channel pairing", async () => {
      const result = await importLegacyChannelPairingFilesToSqlite(env);
      if (result.files > 0) {
        changes.push(
          `- Imported ${result.requests} channel pairing request(s) and ${result.allowFrom} channel allowlist entr${result.allowFrom === 1 ? "y" : "ies"} into SQLite.`,
        );
      }
    });
  }
  if (probe.commitments) {
    await runImport("Commitments", async () => {
      const result = await importLegacyCommitmentStoreFileToSqlite(env);
      if (result.imported) {
        changes.push(`- Imported ${result.commitments} commitment record(s) into SQLite.`);
      }
    });
  }
  if (probe.webPush) {
    await runImport("Web push", async () => {
      const result = await importLegacyWebPushFilesToSqlite(baseDir);
      if (result.files > 0) {
        changes.push(
          `- Imported ${result.subscriptions} web push subscription(s)${result.importedVapidKeys ? " and VAPID keys" : ""} into SQLite.`,
        );
      }
    });
  }
  if (probe.apns) {
    await runImport("APNs push", async () => {
      const result = await importLegacyApnsRegistrationFileToSqlite(baseDir);
      if (result.imported) {
        changes.push(`- Imported ${result.registrations} APNs registration(s) into SQLite.`);
      }
    });
  }
  if (probe.updateCheck) {
    await runImport("Update check", async () => {
      const result = await importLegacyUpdateCheckFileToSqlite(env);
      if (result.imported) {
        changes.push("- Imported update-check state into SQLite.");
      }
    });
  }
  if (probe.configHealth) {
    await runImport("Config health", async () => {
      const result = await importLegacyConfigHealthFileToSqlite({ env, baseDir });
      if (result.imported) {
        changes.push(
          `- Imported ${result.entries} config health entr${result.entries === 1 ? "y" : "ies"} into SQLite.`,
        );
      }
    });
  }
  if (probe.managedImages) {
    await runImport("Managed outgoing image records", async () => {
      const result = await importLegacyManagedOutgoingImageRecordFilesToSqlite(baseDir);
      if (result.files > 0) {
        changes.push(`- Imported ${result.records} managed outgoing image record(s) into SQLite.`);
      }
    });
  }
  if (probe.mediaFiles) {
    await runImport("Media files", async () => {
      const result = await importLegacyMediaFilesToSqlite(env);
      if (result.imported > 0 || result.removed > 0) {
        changes.push(
          `- Imported ${result.imported} media attachment file(s) into SQLite${result.skipped > 0 ? `; skipped ${result.skipped}.` : "."}`,
        );
      }
    });
  }
  if (probe.pluginBindingApprovals) {
    await runImport("Plugin binding approvals", () => {
      const result = importLegacyPluginBindingApprovalFileToSqlite();
      if (result.imported) {
        changes.push(`- Imported ${result.approvals} plugin binding approval(s) into SQLite.`);
      }
    });
  }
  if (probe.installedPluginIndex) {
    await runImport("Installed plugin index", () => {
      const result = importLegacyInstalledPluginIndexFileToSqlite({ env, stateDir: baseDir });
      if (result.imported) {
        changes.push(
          `- Imported installed plugin index with ${result.plugins} plugin record(s) and ${result.installRecords} install record(s) into SQLite.`,
        );
      }
    });
  }
  if (probe.subagents) {
    await runImport("Subagent registry", () => {
      const result = importLegacySubagentRegistryFileToSqlite(env);
      if (result.imported) {
        changes.push(`- Imported ${result.runs} subagent run record(s) into SQLite.`);
      }
    });
  }
  if (probe.tuiLastSession) {
    await runImport("TUI last-session", async () => {
      const result = await importLegacyTuiLastSessionStoreToSqlite({ stateDir: baseDir });
      if (result.imported) {
        changes.push(`- Imported ${result.pointers} TUI last-session pointer(s) into SQLite.`);
      }
    });
  }
  if (probe.acpEventLedger) {
    await runImport("ACP event ledger", async () => {
      const result = await importLegacyAcpEventLedgerFileToSqlite(env);
      if (result.imported) {
        changes.push(
          `- Imported ${result.sessions} ACP event ledger session(s) and ${result.events} event(s) into SQLite.`,
        );
      }
    });
  }
  if (probe.voiceWake) {
    await runImport("Voice Wake config", async () => {
      const result = await importLegacyVoiceWakeConfigFileToSqlite(baseDir);
      if (result.imported) {
        changes.push(`- Imported ${result.triggers} Voice Wake trigger(s) into SQLite.`);
      }
    });
  }
  if (probe.voiceWakeRouting) {
    await runImport("Voice Wake routing config", async () => {
      const result = await importLegacyVoiceWakeRoutingConfigFileToSqlite(baseDir);
      if (result.imported) {
        changes.push(`- Imported ${result.routes} Voice Wake routing rule(s) into SQLite.`);
      }
    });
  }
  if (probe.authProfileStateAgentDirs.length > 0) {
    await runImport("Auth profile runtime state", () => {
      let imported = 0;
      for (const agentDir of probe.authProfileStateAgentDirs) {
        const result = importLegacyAuthProfileStateFileToSqlite(agentDir);
        if (result.imported) {
          imported += 1;
        }
      }
      if (imported > 0) {
        changes.push(`- Imported ${imported} auth profile runtime state file(s) into SQLite.`);
      }
    });
  }
  if (probe.openRouterModelCache) {
    await runImport("OpenRouter model cache", () => {
      const result = importLegacyOpenRouterModelCapabilitiesCacheToSqlite(env);
      if (result.imported) {
        changes.push(
          `- Imported ${result.models} OpenRouter model cache entr${result.models === 1 ? "y" : "ies"} into SQLite.`,
        );
      }
    });
  }
  if (probe.memoryCoreDreamingState && params.cfg) {
    await runImport("Memory-core dreaming state", async () => {
      const result = await importLegacyMemoryCoreDreamingStateFilesToSqlite({
        cfg: params.cfg as OpenClawConfig,
        env,
      });
      if (result.files > 0 || result.removedLocks > 0) {
        changes.push(
          `- Imported ${result.rows} memory-core dreaming checkpoint row(s) from ${result.files} legacy file(s) into SQLite${result.removedLocks > 0 ? ` and removed ${result.removedLocks} stale lock file(s)` : ""}.`,
        );
      }
      warnings.push(
        ...result.warnings.map((warning) => `- Memory-core dreaming state: ${warning}`),
      );
    });
  }

  if (changes.length > 0) {
    note(changes.join("\n"), "Doctor changes");
  }
  if (warnings.length > 0) {
    note(warnings.join("\n"), "Doctor warnings");
  }
}
