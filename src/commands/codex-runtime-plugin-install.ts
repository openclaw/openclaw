// Codex runtime plugin auto-install/repair helpers for OpenAI model selections.
import { modelSelectionShouldEnsureCodexPlugin } from "../agents/openai-routing.js";
<<<<<<< HEAD
import { createRuntimePluginModelSelectionHelpers } from "./runtime-plugin-install.js";
=======
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  createRuntimePluginModelSelectionHelpers,
  type RuntimePluginInstallResult,
} from "./runtime-plugin-install.js";
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df

export const CODEX_RUNTIME_PLUGIN_ID = "codex";
const CODEX_RUNTIME_PLUGIN_LABEL = "Codex";
const CODEX_RUNTIME_PLUGIN_NPM_SPEC = "@openclaw/codex";
const CODEX_RUNTIME_PLUGIN_DESCRIPTOR = {
  pluginId: CODEX_RUNTIME_PLUGIN_ID,
  label: CODEX_RUNTIME_PLUGIN_LABEL,
  npmSpec: CODEX_RUNTIME_PLUGIN_NPM_SPEC,
  warningLabel: CODEX_RUNTIME_PLUGIN_LABEL,
};

<<<<<<< HEAD
const codexRuntimePluginInstall = createRuntimePluginModelSelectionHelpers({
  descriptor: CODEX_RUNTIME_PLUGIN_DESCRIPTOR,
  shouldEnsure: ({ cfg, model }) =>
    modelSelectionShouldEnsureCodexPlugin({
      config: cfg,
      model,
    }),
=======
export type CodexRuntimePluginInstallResult = RuntimePluginInstallResult;

/** Return true when a selected model requires the Codex runtime plugin to be installed. */
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
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
});

export const ensureCodexRuntimePluginForModelSelection = codexRuntimePluginInstall.ensure;
export const repairCodexRuntimePluginInstallForModelSelection = codexRuntimePluginInstall.repair;
