import { resolveConfiguredAgentId } from "../agents/agent-scope-config.js";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { getRegisteredAgentHarness } from "../agents/harness/registry.js";
import { requestNativeRuntimeConsent } from "../agents/harness/setup-consent.js";
import { applyMergePatch } from "../config/merge-patch.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { validateConfigObjectRaw } from "../config/validation-core.js";
import { isPlainObject } from "../infra/plain-object.js";
import { createPluginCache } from "../plugins/plugin-cache.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { readSetupConfigFileSnapshot, writeWizardConfigFile } from "../wizard/setup.shared.js";
import { loadSetupInferencePluginGeneration } from "./setup-inference-turn.js";

/** Enable an installed runtime without selecting a model or running inference. */
export async function setupNativeRuntime(params: {
  agentId: string;
  runtimeId: string;
  configPatch: Record<string, unknown>;
  prompter: WizardPrompter;
  signal: AbortSignal;
  assertCurrent: () => void;
  onCommitStarted: () => void;
}): Promise<void> {
  const assertCurrent = () => {
    params.signal.throwIfAborted();
    params.assertCurrent();
  };
  assertCurrent();
  const snapshot = await readSetupConfigFileSnapshot();
  assertCurrent();
  if (!snapshot.valid) {
    throw new Error("Config is invalid. Run `openclaw doctor` before enabling a runtime.");
  }
  const config = snapshot.exists ? snapshot.sourceConfig : {};
  resolveConfiguredAgentId(config, params.agentId);
  // Only the runtime owner's plugin configuration may change. In particular this
  // request cannot grant consent itself or change model/runtime defaults.
  const plugins = params.configPatch.plugins;
  const entries = isPlainObject(plugins) ? plugins.entries : undefined;
  if (
    Object.keys(params.configPatch).length !== 1 ||
    !isPlainObject(plugins) ||
    Object.keys(plugins).length !== 1 ||
    !isPlainObject(entries) ||
    Object.keys(entries).length !== 1
  ) {
    throw new Error("Runtime enablement requires one plugin configuration patch.");
  }
  const [pluginId] = Object.keys(entries);
  const entry = entries[pluginId!];
  if (!isPlainObject(entry) || Object.keys(entry).length !== 1 || !isPlainObject(entry.config)) {
    throw new Error("Runtime enablement may only change the runtime owner's configuration.");
  }
  const validated = validateConfigObjectRaw(applyMergePatch(config, params.configPatch));
  if (!validated.ok) {
    throw new Error(
      "The runtime configuration is invalid. Review its settings before enabling it.",
    );
  }
  const staged: OpenClawConfig = {
    ...config,
    plugins: {
      ...config.plugins,
      entries: {
        ...config.plugins?.entries,
        [pluginId!]: validated.config.plugins!.entries![pluginId!]!,
      },
    },
  };
  const workspaceDir = resolveAgentWorkspaceDir(config, params.agentId, process.env);
  await using cache = createPluginCache();
  const generation = await loadSetupInferencePluginGeneration({
    cache,
    config: staged,
    workspaceDir,
    selection: { provider: "", modelId: "", runtime: params.runtimeId, agentId: params.agentId },
    pendingPluginInstalls: staged.plugins?.installs,
  });
  assertCurrent();
  await withPluginRuntimeGenerationScope(generation, async () => {
    const registration = getRegisteredAgentHarness(params.runtimeId);
    if (!registration?.ownerPluginId || registration.ownerPluginId !== pluginId) {
      throw new Error("The runtime does not own the requested plugin configuration.");
    }
    const assertOwnerCurrent = () => {
      assertCurrent();
      const current = getRegisteredAgentHarness(params.runtimeId);
      if (
        current?.harness !== registration.harness ||
        current.ownerPluginId !== registration.ownerPluginId
      ) {
        throw new Error("The runtime owner changed during permission setup.");
      }
    };
    const consented = await requestNativeRuntimeConsent({
      config: staged,
      agentId: params.agentId,
      harness: registration.harness,
      prompter: params.prompter,
      assertCurrent: assertOwnerCurrent,
    });
    assertOwnerCurrent();
    await writeWizardConfigFile(consented, {
      baseSnapshot: snapshot,
      writeOptions: {
        assertCurrent: assertOwnerCurrent,
        beforeCommit: () => {
          assertOwnerCurrent();
          params.onCommitStarted();
        },
      },
    });
  });
}
