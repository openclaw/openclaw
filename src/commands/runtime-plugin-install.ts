import { existsSync } from "node:fs";
import path from "node:path";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { modelSelectionShouldEnsureCopilotRuntimePlugin } from "../agents/copilot-routing.js";
import { modelSelectionShouldEnsureCodexPlugin } from "../agents/openai-routing.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { redactToolPayloadText } from "../logging/redact.js";
import type { PluginCapabilityConsentHandler } from "../plugins/capability-consent.js";
import { enablePluginWithCapabilityConsent } from "../plugins/enable.js";
import { loadInstalledPluginIndexInstallRecords } from "../plugins/installed-plugin-index-records.js";
import type { RuntimeEnv } from "../runtime.js";
import { resolveUserPath } from "../utils.js";
import { createPluginCapabilityConsentPrompter } from "../wizard/plugin-capability-consent.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { createNonInteractiveLoggingPrompter } from "./non-interactive-prompter.js";

type RuntimePluginInstallDescriptor = {
  pluginId: string;
  label: string;
  npmSpec: string;
  warningLabel: string;
  shouldEnsure: (params: RuntimePluginRepairParams) => boolean;
  /** Keep this official runtime package on the same release cohort as OpenClaw. */
  versionBoundToOpenClaw?: boolean;
};

type RuntimePluginInstallResult =
  | { ok: true; cfg: OpenClawConfig; required: boolean }
  | { ok: false; status: "skipped" | "failed" | "timed_out"; message: string };

type ModelSelectionRuntimePluginsResult =
  | { ok: true; cfg: OpenClawConfig; codexInstalled: boolean }
  | { ok: false; message: string };

type RuntimePluginEnsureParams = {
  cfg: OpenClawConfig;
  model?: string;
  agentId?: string;
  prompter: WizardPrompter;
  runtime: RuntimeEnv;
  workspaceDir?: string;
  output?: "interactive" | "silent";
  beforePersistentEffect?: () => void | Promise<void>;
  onCapabilityConsent?: PluginCapabilityConsentHandler;
  recordOfficialCapabilities?: boolean;
};

type RuntimePluginRepairParams = {
  cfg: OpenClawConfig;
  model?: string;
  agentId?: string;
  env?: NodeJS.ProcessEnv;
  onCapabilityConsent?: PluginCapabilityConsentHandler;
};

export const CODEX_RUNTIME_PLUGIN_ID = "codex";
const CODEX_RUNTIME_PLUGIN_DESCRIPTOR: RuntimePluginInstallDescriptor = {
  pluginId: CODEX_RUNTIME_PLUGIN_ID,
  label: "Codex",
  npmSpec: "@openclaw/codex",
  warningLabel: "Codex",
  versionBoundToOpenClaw: true,
  shouldEnsure: ({ cfg, model, agentId }) =>
    modelSelectionShouldEnsureCodexPlugin({ config: cfg, model, agentId }),
};
const COPILOT_RUNTIME_PLUGIN_DESCRIPTOR: RuntimePluginInstallDescriptor = {
  pluginId: "copilot",
  label: "GitHub Copilot agent runtime",
  npmSpec: "@openclaw/copilot",
  warningLabel: "GitHub Copilot",
  shouldEnsure: ({ cfg, model }) =>
    modelSelectionShouldEnsureCopilotRuntimePlugin({ config: cfg, model }),
};

function isInstalledRecordPresentOnDisk(
  record: PluginInstallRecord | undefined,
  env: NodeJS.ProcessEnv,
): boolean {
  const installPath = record?.installPath?.trim();
  if (!installPath) {
    return false;
  }
  return existsSync(path.join(resolveUserPath(installPath, env), "package.json"));
}

function finalizeRequiredRuntimePluginInstall(
  descriptor: RuntimePluginInstallDescriptor,
  result: {
    cfg: OpenClawConfig;
    installed: boolean;
    status: "installed" | "skipped" | "failed" | "timed_out";
    reason?: string;
  },
): RuntimePluginInstallResult {
  if (result.installed) {
    return { ok: true, cfg: result.cfg, required: true };
  }
  const status = result.status === "installed" ? "failed" : result.status;
  const runtimeLabel = `${descriptor.label}${/runtime$/iu.test(descriptor.label) ? "" : " runtime"}`;
  const reason =
    redactToolPayloadText(sanitizeTerminalText(result.reason ?? "")).trim() ||
    "The installer did not return a failure reason.";
  return {
    ok: false,
    status,
    message: `${runtimeLabel} is required but unavailable (status: ${status}). Reason: ${reason} ${
      status === "failed" || status === "timed_out"
        ? `Retry setup after checking npm connectivity and the configured registry; install ${descriptor.npmSpec} first if it is still unavailable.`
        : `Retry setup and allow ${runtimeLabel} to install, or select a model that does not require it.`
    }`,
  };
}

function adaptRuntimePluginInstallIo(params: RuntimePluginEnsureParams): {
  prompter: WizardPrompter;
  runtime: RuntimeEnv;
} {
  const silent = params.output === "silent";
  const runtime = {
    ...params.runtime,
    error: () => {},
    ...(silent ? { log: () => {} } : {}),
  };
  return {
    prompter: silent
      ? createNonInteractiveLoggingPrompter(
          runtime,
          (message) => `Runtime plugin install unexpectedly prompted: ${message}`,
        )
      : { ...params.prompter, note: async () => {} },
    runtime,
  };
}

async function ensureRuntimePluginForModelSelection(
  params: RuntimePluginEnsureParams,
  descriptor: RuntimePluginInstallDescriptor,
): Promise<RuntimePluginInstallResult> {
  if (!descriptor.shouldEnsure(params)) {
    return { ok: true, cfg: params.cfg, required: false };
  }
  const io = adaptRuntimePluginInstallIo(params);
  const onCapabilityConsent =
    params.onCapabilityConsent ??
    (params.output === "silent"
      ? async () => undefined
      : createPluginCapabilityConsentPrompter(params.prompter));
  const existingRecords = await loadInstalledPluginIndexInstallRecords({ env: process.env });
  if (isInstalledRecordPresentOnDisk(existingRecords[descriptor.pluginId], process.env)) {
    // A recorded install with package.json on disk can be repaired/enabled
    // without re-downloading the plugin during setup.
    const repair = await repairRequiredRuntimePluginInstall(
      {
        cfg: params.cfg,
        env: process.env,
        onCapabilityConsent,
        beforePersistentEffect: params.beforePersistentEffect,
      },
      descriptor.pluginId,
    );
    for (const change of repair.changes) {
      io.runtime.log?.(change);
    }
    for (const warning of repair.warnings) {
      io.runtime.log?.(`${descriptor.warningLabel} update warning: ${warning}`);
    }
    const enableResult = await enablePluginWithCapabilityConsent(params.cfg, descriptor.pluginId, {
      workspaceDir: params.workspaceDir,
      onCapabilityConsent,
      recordOfficialCapabilities: params.recordOfficialCapabilities,
      beforePersistentEffect: params.beforePersistentEffect,
    });
    return finalizeRequiredRuntimePluginInstall(descriptor, {
      cfg: enableResult.config,
      installed: enableResult.enabled,
      status: enableResult.enabled ? "installed" : "failed",
      ...(enableResult.reason ? { reason: enableResult.reason } : {}),
    });
  }
  const { ensureOnboardingPluginInstalled } = await import("./onboarding-plugin-install.js");
  // Defer to the onboarding plugin installer so runtime plugin installs get the
  // same trust, record, timeout, and progress handling as channel/provider setup.
  const result = await ensureOnboardingPluginInstalled({
    cfg: params.cfg,
    entry: {
      pluginId: descriptor.pluginId,
      label: descriptor.label,
      install: {
        npmSpec: descriptor.npmSpec,
        defaultChoice: "npm",
      },
      trustedSourceLinkedOfficialInstall: true,
      ...(descriptor.versionBoundToOpenClaw ? { versionBoundToOpenClaw: true } : {}),
    },
    prompter: io.prompter,
    runtime: io.runtime,
    ...(params.workspaceDir !== undefined ? { workspaceDir: params.workspaceDir } : {}),
    promptInstall: false,
    autoConfirmSingleSource: true,
    onCapabilityConsent,
    recordOfficialCapabilities: params.recordOfficialCapabilities,
    beforePersistentEffect: params.beforePersistentEffect,
  });
  return finalizeRequiredRuntimePluginInstall(descriptor, {
    cfg: result.cfg,
    installed: result.installed,
    status: result.status,
    ...(result.error ? { reason: result.error } : {}),
  });
}

/** Repairs missing install records for runtime plugins required by model selection. */
async function repairRequiredRuntimePluginInstall(
  params: RuntimePluginRepairParams & { beforePersistentEffect?: () => void | Promise<void> },
  pluginId: string,
): Promise<{ changes: string[]; warnings: string[] }> {
  const { repairMissingPluginInstallsForIds } =
    await import("./doctor/shared/missing-configured-plugin-install.js");
  const result = await repairMissingPluginInstallsForIds({
    cfg: params.cfg,
    pluginIds: [pluginId],
    ...(params.env !== undefined ? { env: params.env } : {}),
    ...(params.onCapabilityConsent ? { onCapabilityConsent: params.onCapabilityConsent } : {}),
    beforePersistentEffect: params.beforePersistentEffect,
  });
  return {
    changes: result.changes,
    warnings: [...result.warnings, ...(result.notices ?? [])],
  };
}

export const ensureCodexRuntimePluginForModelSelection = (params: RuntimePluginEnsureParams) =>
  ensureRuntimePluginForModelSelection(params, CODEX_RUNTIME_PLUGIN_DESCRIPTOR);
export const ensureCodexRuntimePluginForSupervision = (params: RuntimePluginEnsureParams) =>
  ensureRuntimePluginForModelSelection(params, {
    ...CODEX_RUNTIME_PLUGIN_DESCRIPTOR,
    shouldEnsure: () => true,
  });

export async function repairModelSelectionRuntimePlugins(
  params: RuntimePluginRepairParams,
): Promise<string[]> {
  const warnings: string[] = [];
  for (const descriptor of [CODEX_RUNTIME_PLUGIN_DESCRIPTOR, COPILOT_RUNTIME_PLUGIN_DESCRIPTOR]) {
    if (descriptor.shouldEnsure(params)) {
      const repaired = await repairRequiredRuntimePluginInstall(params, descriptor.pluginId);
      warnings.push(...repaired.warnings);
    }
  }
  return warnings;
}

export async function ensureModelSelectionRuntimePlugins(
  params: RuntimePluginEnsureParams,
): Promise<ModelSelectionRuntimePluginsResult> {
  const codex = await ensureCodexRuntimePluginForModelSelection(params);
  if (!codex.ok) {
    return { ok: false, message: codex.message };
  }
  const copilot = await ensureRuntimePluginForModelSelection(
    { ...params, cfg: codex.cfg },
    COPILOT_RUNTIME_PLUGIN_DESCRIPTOR,
  );
  return copilot.ok
    ? { ok: true, cfg: copilot.cfg, codexInstalled: codex.required }
    : { ok: false, message: copilot.message };
}
