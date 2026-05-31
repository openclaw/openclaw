import { modelSelectionShouldEnsureCodexPlugin } from "../agents/openai-routing.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  createRuntimePluginModelSelectionHelpers,
  type RuntimePluginInstallResult,
} from "./runtime-plugin-install.js";

export const CODEX_RUNTIME_PLUGIN_ID = "codex";
const CODEX_RUNTIME_PLUGIN_LABEL = "Codex";
const CODEX_RUNTIME_PLUGIN_NPM_SPEC = "@openclaw/codex";
const CODEX_RUNTIME_PLUGIN_DESCRIPTOR = {
  pluginId: CODEX_RUNTIME_PLUGIN_ID,
  label: CODEX_RUNTIME_PLUGIN_LABEL,
  npmSpec: CODEX_RUNTIME_PLUGIN_NPM_SPEC,
  warningLabel: CODEX_RUNTIME_PLUGIN_LABEL,
};

export type CodexRuntimePluginInstallResult = RuntimePluginInstallResult;

/** Returns true when the selected model requires the bundled Codex runtime plugin. */
export function selectedModelShouldEnsureCodexRuntimePlugin(params: {
  cfg: OpenClawConfig;
  model?: string;
}): boolean {
  return modelSelectionShouldEnsureCodexPlugin({
    config: params.cfg,
    model: params.model,
  });
}

const codexRuntimePluginInstall = createRuntimePluginModelSelectionHelpers({
  descriptor: CODEX_RUNTIME_PLUGIN_DESCRIPTOR,
  shouldEnsure: selectedModelShouldEnsureCodexRuntimePlugin,
});

/** Installs/enables the Codex runtime plugin when a model selection needs it. */
export const ensureCodexRuntimePluginForModelSelection = codexRuntimePluginInstall.ensure;
/** Repairs an existing Codex runtime plugin install when model selection exposes a broken setup. */
export const repairCodexRuntimePluginInstallForModelSelection = codexRuntimePluginInstall.repair;
