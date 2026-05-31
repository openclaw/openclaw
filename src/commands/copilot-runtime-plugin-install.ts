import { modelSelectionShouldEnsureCopilotRuntimePlugin } from "../agents/copilot-routing.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  createRuntimePluginModelSelectionHelpers,
  type RuntimePluginInstallResult,
} from "./runtime-plugin-install.js";

export const COPILOT_RUNTIME_PLUGIN_ID = "copilot";
const COPILOT_RUNTIME_PLUGIN_LABEL = "GitHub Copilot agent runtime";
const COPILOT_RUNTIME_PLUGIN_NPM_SPEC = "@openclaw/copilot";
const COPILOT_RUNTIME_PLUGIN_DESCRIPTOR = {
  pluginId: COPILOT_RUNTIME_PLUGIN_ID,
  label: COPILOT_RUNTIME_PLUGIN_LABEL,
  npmSpec: COPILOT_RUNTIME_PLUGIN_NPM_SPEC,
  warningLabel: "GitHub Copilot",
};

export type CopilotRuntimePluginInstallResult = RuntimePluginInstallResult;

/** Returns true when the selected model requires the GitHub Copilot runtime plugin. */
export function selectedModelShouldEnsureCopilotRuntimePlugin(params: {
  cfg: OpenClawConfig;
  model?: string;
}): boolean {
  return modelSelectionShouldEnsureCopilotRuntimePlugin({
    config: params.cfg,
    model: params.model,
  });
}

const copilotRuntimePluginInstall = createRuntimePluginModelSelectionHelpers({
  descriptor: COPILOT_RUNTIME_PLUGIN_DESCRIPTOR,
  shouldEnsure: selectedModelShouldEnsureCopilotRuntimePlugin,
});

/** Installs/enables the Copilot runtime plugin when a model selection needs it. */
export const ensureCopilotRuntimePluginForModelSelection = copilotRuntimePluginInstall.ensure;
/** Repairs an existing Copilot runtime plugin install when model selection exposes a broken setup. */
export const repairCopilotRuntimePluginInstallForModelSelection =
  copilotRuntimePluginInstall.repair;
