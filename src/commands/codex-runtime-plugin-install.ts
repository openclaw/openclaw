import { existsSync } from "node:fs";
import path from "node:path";
import { modelSelectionShouldEnsureCodexPlugin } from "../agents/openai-codex-routing.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { enablePluginInConfig } from "../plugins/enable.js";
import { loadInstalledPluginIndexInstallRecords } from "../plugins/installed-plugin-index-records.js";
import type { RuntimeEnv } from "../runtime.js";
import { resolveUserPath } from "../utils.js";
import type { WizardPrompter } from "../wizard/prompts.js";

export const CODEX_RUNTIME_PLUGIN_ID = "codex";
const CODEX_RUNTIME_PLUGIN_LABEL = "Codex";
const CODEX_RUNTIME_PLUGIN_NPM_SPEC = "@openclaw/codex";

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

export type CodexRuntimePluginInstallResult = {
  cfg: OpenClawConfig;
  required: boolean;
  installed: boolean;
  status?: "installed" | "skipped" | "failed" | "timed_out";
};

export function selectedModelShouldEnsureCodexRuntimePlugin(params: {
  cfg: OpenClawConfig;
  model?: string;
}): boolean {
  return modelSelectionShouldEnsureCodexPlugin({
    config: params.cfg,
    model: params.model,
  });
}

export async function ensureCodexRuntimePluginForModelSelection(params: {
  cfg: OpenClawConfig;
  model?: string;
  prompter: WizardPrompter;
  runtime: RuntimeEnv;
  workspaceDir?: string;
}): Promise<CodexRuntimePluginInstallResult> {
  if (!selectedModelShouldEnsureCodexRuntimePlugin({ cfg: params.cfg, model: params.model })) {
    return {
      cfg: params.cfg,
      required: false,
      installed: false,
    };
  }
  const existingRecords = await loadInstalledPluginIndexInstallRecords({ env: process.env });
  if (isInstalledRecordPresentOnDisk(existingRecords[CODEX_RUNTIME_PLUGIN_ID], process.env)) {
    const repair = await repairCodexRuntimePluginInstallForModelSelection({
      cfg: params.cfg,
      model: params.model,
      env: process.env,
    });
    for (const change of repair.changes) {
      params.runtime.log?.(change);
    }
    for (const warning of repair.warnings) {
      params.runtime.log?.(`Codex update warning: ${warning}`);
    }
    const enableResult = enablePluginInConfig(params.cfg, CODEX_RUNTIME_PLUGIN_ID);
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
      pluginId: CODEX_RUNTIME_PLUGIN_ID,
      label: CODEX_RUNTIME_PLUGIN_LABEL,
      install: {
        npmSpec: CODEX_RUNTIME_PLUGIN_NPM_SPEC,
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

export async function ensureCodexRuntimePluginForGatewayStartup(params: {
  cfg: OpenClawConfig;
  log: (message: string) => void;
  env?: NodeJS.ProcessEnv;
}): Promise<OpenClawConfig> {
  const { collectConfiguredModelRefs } = await import("../config/model-refs.js");
  const needsCodex = collectConfiguredModelRefs(params.cfg).some(({ value }) =>
    modelSelectionShouldEnsureCodexPlugin({ model: value, config: params.cfg }),
  );
  if (!needsCodex) {
    return params.cfg;
  }
  const env = params.env ?? process.env;
  const existingRecords = await loadInstalledPluginIndexInstallRecords({ env });
  if (isInstalledRecordPresentOnDisk(existingRecords[CODEX_RUNTIME_PLUGIN_ID], env)) {
    const enableResult = enablePluginInConfig(params.cfg, CODEX_RUNTIME_PLUGIN_ID);
    return enableResult.enabled ? enableResult.config : params.cfg;
  }
  params.log(
    `gateway: codex runtime plugin required by configured models but not installed — installing ${CODEX_RUNTIME_PLUGIN_NPM_SPEC}`,
  );
  const { ensureOnboardingPluginInstalled } = await import("./onboarding-plugin-install.js");
  const result = await ensureOnboardingPluginInstalled({
    cfg: params.cfg,
    entry: {
      pluginId: CODEX_RUNTIME_PLUGIN_ID,
      label: CODEX_RUNTIME_PLUGIN_LABEL,
      install: { npmSpec: CODEX_RUNTIME_PLUGIN_NPM_SPEC, defaultChoice: "npm" },
      trustedSourceLinkedOfficialInstall: true,
      preferRemoteInstall: true,
    },
    prompter: createGatewayStartupPrompter(params.log),
    runtime: {
      log: (...args) => {
        params.log(args.map(String).join(" "));
      },
      error: (...args) => {
        params.log(args.map(String).join(" "));
      },
      exit: () => {
        throw new Error("codex startup install attempted process exit");
      },
    },
    promptInstall: false,
    autoConfirmSingleSource: true,
  });
  if (result.installed) {
    params.log(`gateway: codex runtime plugin installed`);
  }
  return result.cfg;
}

function createGatewayStartupPrompter(log: (message: string) => void): WizardPrompter {
  const abort = (method: string): never => {
    throw new Error(`codex startup install triggered unexpected interactive prompt: ${method}`);
  };
  return {
    intro: async (title) => {
      log(`[codex-install] ${title}`);
    },
    outro: async (message) => {
      log(`[codex-install] ${message}`);
    },
    note: async (message, title) => {
      log(`[codex-install] ${title != null ? `${title}: ` : ""}${message}`);
    },
    plain: async (message) => {
      log(`[codex-install] ${message}`);
    },
    select: async () => abort("select"),
    multiselect: async () => abort("multiselect"),
    text: async () => abort("text"),
    confirm: async () => abort("confirm"),
    progress: () => abort("progress"),
  };
}

export async function repairCodexRuntimePluginInstallForModelSelection(params: {
  cfg: OpenClawConfig;
  model?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{ required: boolean; changes: string[]; warnings: string[] }> {
  if (!selectedModelShouldEnsureCodexRuntimePlugin({ cfg: params.cfg, model: params.model })) {
    return { required: false, changes: [], warnings: [] };
  }
  const { repairMissingPluginInstallsForIds } =
    await import("./doctor/shared/missing-configured-plugin-install.js");
  const result = await repairMissingPluginInstallsForIds({
    cfg: params.cfg,
    pluginIds: [CODEX_RUNTIME_PLUGIN_ID],
    ...(params.env !== undefined ? { env: params.env } : {}),
  });
  return {
    required: true,
    changes: result.changes,
    warnings: result.warnings,
  };
}
