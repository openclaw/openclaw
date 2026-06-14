/** Resolves preferred provider auth choices from config and plugin metadata. */
import { normalizeLegacyOnboardAuthChoice } from "../commands/auth-choice-legacy.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveManifestProviderAuthChoice } from "./provider-auth-choices.js";
import type {
  ProviderAuthMethod,
  ProviderPlugin,
  ProviderPluginWizard,
  ProviderPluginWizardSetup,
} from "./types.js";

function normalizeLegacyAuthChoice(choice: string, env?: NodeJS.ProcessEnv): string {
  return normalizeLegacyOnboardAuthChoice(choice, { env }) ?? choice;
}

function readResolvedProviderId(provider: { id: unknown }): string | undefined {
  try {
    return typeof provider.id === "string" && provider.id.trim().length > 0
      ? provider.id
      : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readProperty(record: Record<string, unknown>, key: string): unknown {
  try {
    return record[key];
  } catch {
    return undefined;
  }
}

function readStringProperty(record: Record<string, unknown>, key: string): string | undefined {
  const value = readProperty(record, key);
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function readArrayProperty(record: Record<string, unknown>, key: string): unknown[] {
  const value = readProperty(record, key);
  return Array.isArray(value) ? value : [];
}

function readWizardSetup(rawSetup: unknown): ProviderPluginWizardSetup | undefined {
  if (!isRecord(rawSetup)) {
    return undefined;
  }
  const choiceId = readStringProperty(rawSetup, "choiceId");
  const methodId = readStringProperty(rawSetup, "methodId");
  if (!choiceId && !methodId) {
    return undefined;
  }
  return {
    ...(choiceId ? { choiceId } : {}),
    ...(methodId ? { methodId } : {}),
  };
}

function readProviderWizard(rawWizard: unknown): ProviderPluginWizard | undefined {
  if (!isRecord(rawWizard)) {
    return undefined;
  }
  const setup = readWizardSetup(readProperty(rawWizard, "setup"));
  return setup ? { setup } : undefined;
}

const noopProviderAuthMethodRun: ProviderAuthMethod["run"] = async () => ({ profiles: [] });

function toChoiceResolverAuthMethod(rawMethod: unknown): ProviderAuthMethod | undefined {
  if (!isRecord(rawMethod)) {
    return undefined;
  }
  const id = readStringProperty(rawMethod, "id");
  if (!id) {
    return undefined;
  }
  const wizard = readWizardSetup(readProperty(rawMethod, "wizard"));
  return {
    id,
    label: id,
    kind: "custom",
    run: noopProviderAuthMethodRun,
    ...(wizard ? { wizard } : {}),
  };
}

function toChoiceResolverProvider(provider: ProviderPlugin): ProviderPlugin | undefined {
  const rawProvider = provider as unknown;
  if (!isRecord(rawProvider)) {
    return undefined;
  }
  const id = readStringProperty(rawProvider, "id");
  if (!id) {
    return undefined;
  }
  const auth = readArrayProperty(rawProvider, "auth")
    .map(toChoiceResolverAuthMethod)
    .filter((method): method is ProviderAuthMethod => Boolean(method));
  const wizard = readProviderWizard(readProperty(rawProvider, "wizard"));
  return {
    id,
    label: id,
    auth,
    ...(wizard ? { wizard } : {}),
  };
}

function toChoiceResolverProviders(providers: ProviderPlugin[]): ProviderPlugin[] {
  return providers
    .map(toChoiceResolverProvider)
    .filter((provider): provider is ProviderPlugin => Boolean(provider));
}

export async function resolvePreferredProviderForAuthChoice(params: {
  choice: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  includeUntrustedWorkspacePlugins?: boolean;
}): Promise<string | undefined> {
  const choice = normalizeLegacyAuthChoice(params.choice, params.env) ?? params.choice;
  const manifestResolved = resolveManifestProviderAuthChoice(choice, params);
  if (manifestResolved) {
    return manifestResolved.providerId;
  }

  const { resolveProviderPluginChoice, resolvePluginProviders } =
    await import("./provider-auth-choice.runtime.js");
  const providers = resolvePluginProviders({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
    mode: "setup",
    includeUntrustedWorkspacePlugins: params.includeUntrustedWorkspacePlugins,
  });
  const pluginResolved = resolveProviderPluginChoice({
    providers: toChoiceResolverProviders(providers),
    choice,
  });
  if (pluginResolved) {
    return readResolvedProviderId(pluginResolved.provider);
  }

  if (choice === "custom-api-key") {
    return "custom";
  }
  return undefined;
}
