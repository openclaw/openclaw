import { existsSync } from "node:fs";
import path from "node:path";
import { modelSelectionShouldEnsureCopilotRuntimePlugin } from "../agents/copilot-routing.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { enablePluginInConfig } from "../plugins/enable.js";
import { loadInstalledPluginIndexInstallRecords } from "../plugins/installed-plugin-index-records.js";
import type { RuntimeEnv } from "../runtime.js";
import { resolveUserPath } from "../utils.js";
import type { WizardPrompter } from "../wizard/prompts.js";

export const COPILOT_RUNTIME_PLUGIN_ID = "copilot";
const COPILOT_RUNTIME_PLUGIN_LABEL = "GitHub Copilot agent runtime";
const COPILOT_RUNTIME_PLUGIN_NPM_SPEC = "@openclaw/copilot";

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

export type CopilotRuntimePluginInstallResult = {
  cfg: OpenClawConfig;
  required: boolean;
  installed: boolean;
  status?: "installed" | "skipped" | "failed" | "timed_out";
};

export function selectedModelShouldEnsureCopilotRuntimePlugin(params: {
  cfg: OpenClawConfig;
  model?: string;
}): boolean {
  return modelSelectionShouldEnsureCopilotRuntimePlugin({
    config: params.cfg,
    model: params.model,
  });
}

export async function ensureCopilotRuntimePluginForModelSelection(params: {
  cfg: OpenClawConfig;
  model?: string;
  prompter: WizardPrompter;
  runtime: RuntimeEnv;
  workspaceDir?: string;
}): Promise<CopilotRuntimePluginInstallResult> {
  if (!selectedModelShouldEnsureCopilotRuntimePlugin({ cfg: params.cfg, model: params.model })) {
    return {
      cfg: params.cfg,
      required: false,
      installed: false,
    };
  }
  const existingRecords = await loadInstalledPluginIndexInstallRecords({ env: process.env });
  if (isInstalledRecordPresentOnDisk(existingRecords[COPILOT_RUNTIME_PLUGIN_ID], process.env)) {
    const repair = await repairCopilotRuntimePluginInstallForModelSelection({
      cfg: params.cfg,
      model: params.model,
      env: process.env,
    });
    for (const change of repair.changes) {
      params.runtime.log?.(change);
    }
    for (const warning of repair.warnings) {
      params.runtime.log?.(`GitHub Copilot update warning: ${warning}`);
    }
    const enableResult = enablePluginInConfig(params.cfg, COPILOT_RUNTIME_PLUGIN_ID);
    return {
      cfg: enableResult.enabled ? enableResult.config : params.cfg,
      required: true,
      installed: true,
      status: "installed",
    };
  }
  const { ensureOnboardingPluginInstalled } = await import("./onboarding-plugin-install.js");
  const result = await ensureOnboardingPluginInstalled({
    cfg: params.cfg,
    entry: {
      pluginId: COPILOT_RUNTIME_PLUGIN_ID,
      label: COPILOT_RUNTIME_PLUGIN_LABEL,
      install: {
        npmSpec: COPILOT_RUNTIME_PLUGIN_NPM_SPEC,
        defaultChoice: "npm",
      },
      trustedSourceLinkedOfficialInstall: true,
      preferRemoteInstall: true,
    },
    prompter: params.prompter,
    runtime: params.runtime,
    ...(params.workspaceDir !== undefined ? { workspaceDir: params.workspaceDir } : {}),
    promptInstall: false,
    autoConfirmSingleSource: true,
  });
  return {
    cfg: result.cfg,
    required: true,
    installed: result.installed,
    status: result.status,
  };
}

export async function repairCopilotRuntimePluginInstallForModelSelection(params: {
  cfg: OpenClawConfig;
  model?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{ required: boolean; changes: string[]; warnings: string[] }> {
  if (!selectedModelShouldEnsureCopilotRuntimePlugin({ cfg: params.cfg, model: params.model })) {
    return { required: false, changes: [], warnings: [] };
  }
  const { repairMissingPluginInstallsForIds } =
    await import("./doctor/shared/missing-configured-plugin-install.js");
  const result = await repairMissingPluginInstallsForIds({
    cfg: params.cfg,
    pluginIds: [COPILOT_RUNTIME_PLUGIN_ID],
    ...(params.env !== undefined ? { env: params.env } : {}),
  });
  return {
    required: true,
    changes: result.changes,
    warnings: result.warnings,
  };
}
