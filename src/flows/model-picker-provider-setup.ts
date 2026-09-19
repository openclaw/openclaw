import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveManifestProviderAuthChoice } from "../plugins/provider-auth-choices.js";
import { buildProviderPluginMethodChoice } from "../plugins/provider-plugin-choice.js";
import type { ProviderPlugin } from "../plugins/types.js";
import type { RuntimeEnv } from "../runtime.js";
import { createLazyRuntimeSurface } from "../shared/lazy-runtime.js";
import { t } from "../wizard/i18n/index.js";
import type { WizardPrompter, WizardSelectOption } from "../wizard/prompts.js";

async function loadModelPickerRuntime() {
  return import("../commands/model-picker.runtime.js");
}

export const loadResolvedModelPickerRuntime = createLazyRuntimeSurface(
  loadModelPickerRuntime,
  ({ modelPickerRuntime }) => modelPickerRuntime,
);

export async function resolveProviderPluginSetupOptions(params: {
  cfg: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<WizardSelectOption[]> {
  const runtime = await loadResolvedModelPickerRuntime();
  const providerModelPickerOptions =
    "resolveProviderModelPickerContributions" in runtime &&
    typeof runtime.resolveProviderModelPickerContributions === "function"
      ? runtime
          .resolveProviderModelPickerContributions({
            config: params.cfg,
            workspaceDir: params.workspaceDir,
            env: params.env,
          })
          .map((contribution) => contribution.option)
      : runtime.resolveProviderModelPickerEntries({
          config: params.cfg,
          workspaceDir: params.workspaceDir,
          env: params.env,
        });
  return providerModelPickerOptions.map((entry) =>
    Object.assign(
      { value: entry.value, label: entry.label },
      entry.hint ? { hint: entry.hint } : {},
    ),
  );
}

export async function maybeHandleProviderPluginSelection(params: {
  selection: string;
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
  agentDir?: string;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  runtime?: RuntimeEnv;
}): Promise<{ model?: string; config?: OpenClawConfig } | null> {
  let pluginResolution: string | null = null;
  let pluginProviders: ProviderPlugin[] = [];
  if (params.selection.startsWith("provider-plugin:")) {
    pluginResolution = params.selection;
  } else if (!params.selection.includes("/")) {
    const { resolvePluginProviders } = await loadResolvedModelPickerRuntime();
    pluginProviders = resolvePluginProviders({
      config: params.cfg,
      workspaceDir: params.workspaceDir,
      env: params.env,
      mode: "setup",
    });
    pluginResolution = pluginProviders.some(
      (provider) => normalizeProviderId(provider.id) === normalizeProviderId(params.selection),
    )
      ? params.selection
      : null;
  }
  if (!pluginResolution) {
    return null;
  }
  if (!params.agentDir || !params.runtime) {
    await params.prompter.note(
      t("wizard.model.providerSetupUnavailable"),
      t("wizard.model.providerSetupUnavailableTitle"),
    );
    return {};
  }
  const {
    resolvePluginProviders,
    resolveProviderPluginChoice,
    runProviderModelSelectedHook,
    runProviderPluginAuthMethod,
  } = await loadResolvedModelPickerRuntime();
  if (pluginProviders.length === 0) {
    pluginProviders = resolvePluginProviders({
      config: params.cfg,
      workspaceDir: params.workspaceDir,
      env: params.env,
      mode: "setup",
    });
  }
  const resolved = resolveProviderPluginChoice({
    providers: pluginProviders,
    choice: pluginResolution,
    resolveManifestMethodChoice: (provider, method) =>
      provider.pluginId
        ? resolveManifestProviderAuthChoice(
            buildProviderPluginMethodChoice(provider.id, method.id),
            {
              config: params.cfg,
              workspaceDir: params.workspaceDir,
              env: params.env,
              pluginId: provider.pluginId,
              includeUntrustedWorkspacePlugins: false,
            },
          )
        : undefined,
    manifestChoice: resolveManifestProviderAuthChoice(pluginResolution, {
      config: params.cfg,
      workspaceDir: params.workspaceDir,
      env: params.env,
      includeUntrustedWorkspacePlugins: false,
    }),
  });
  if (!resolved) {
    return {};
  }
  if (
    resolved.wizard?.modelTarget === "utility" ||
    resolved.method.wizard?.modelTarget === "utility"
  ) {
    await params.prompter.note(
      "This provider configures utility inference. Select it in onboarding; choose a regular model here.",
      "Utility model",
    );
    return {};
  }
  const applied = await runProviderPluginAuthMethod({
    config: params.cfg,
    runtime: params.runtime,
    prompter: params.prompter,
    method: resolved.method,
    agentDir: params.agentDir,
    workspaceDir: params.workspaceDir,
  });
  if (applied.defaultModel) {
    await runProviderModelSelectedHook({
      config: applied.config,
      model: applied.defaultModel,
      prompter: params.prompter,
      agentDir: params.agentDir,
      workspaceDir: params.workspaceDir,
      env: params.env,
    });
  }
  return { model: applied.defaultModel, config: applied.config };
}
