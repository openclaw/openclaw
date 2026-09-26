// Applies an onboarding auth choice through provider setup flows and legacy normalization.
import { formatCliCommand } from "../cli/command-format.js";
import { prepareAuthChoiceLoadedPluginProvider } from "../plugins/provider-auth-choice.js";
import type {
  ApplyAuthChoiceParams,
  ApplyAuthChoiceResult,
  PreparedAuthChoiceResult,
} from "./auth-choice.apply.types.js";
import type { AuthChoice } from "./onboard-types.js";

async function normalizeLegacyChoice(
  authChoice: AuthChoice | undefined,
  params: Pick<ApplyAuthChoiceParams, "config" | "env" | "workspaceDir">,
): Promise<AuthChoice | undefined> {
  if (authChoice === "oauth") {
    return "setup-token";
  }
  if (typeof authChoice !== "string") {
    return authChoice;
  }
  const { resolveLegacyOnboardAuthChoice } = await import("./auth-choice-legacy.js");
  return resolveLegacyOnboardAuthChoice(authChoice, params).authChoice;
}

async function normalizeTokenProviderChoice(
  authChoice: AuthChoice,
  params: ApplyAuthChoiceParams,
): Promise<AuthChoice> {
  if (!params.opts?.tokenProvider) {
    return authChoice;
  }
  if (authChoice !== "apiKey" && authChoice !== "token" && authChoice !== "setup-token") {
    return authChoice;
  }
  const { normalizeApiKeyTokenProviderAuthChoice } =
    await import("./auth-choice.apply.api-providers.js");
  return normalizeApiKeyTokenProviderAuthChoice({
    authChoice,
    tokenProvider: params.opts.tokenProvider,
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
  });
}

async function formatDeprecatedProviderChoiceError(
  authChoice: AuthChoice | undefined,
  params: Pick<ApplyAuthChoiceParams, "config" | "env" | "workspaceDir">,
): Promise<string | undefined> {
  if (typeof authChoice !== "string") {
    return undefined;
  }
  const { resolveManifestDeprecatedProviderAuthChoice } =
    await import("../plugins/provider-auth-choices.js");
  const deprecatedChoice =
    resolveManifestDeprecatedProviderAuthChoice(authChoice, params) ??
    (
      await import("../plugins/provider-install-catalog.js")
    ).resolveDeprecatedProviderInstallCatalogEntry(authChoice, {
      ...params,
      includeUntrustedWorkspacePlugins: false,
    });
  if (!deprecatedChoice) {
    return undefined;
  }
  return `Auth choice ${JSON.stringify(authChoice)} is no longer supported. Use ${JSON.stringify(deprecatedChoice.choiceId)} instead, or run ${formatCliCommand("openclaw onboard")} to choose interactively.`;
}

/** Prepare a selected auth choice without writing its returned provider profiles. */
export async function prepareAuthChoice(
  params: ApplyAuthChoiceParams,
): Promise<PreparedAuthChoiceResult> {
  const normalizedAuthChoice =
    (await normalizeLegacyChoice(params.authChoice, params)) ?? params.authChoice;
  const normalizedProviderAuthChoice = await normalizeTokenProviderChoice(
    normalizedAuthChoice,
    params,
  );
  const normalizedParams =
    normalizedProviderAuthChoice === params.authChoice
      ? params
      : { ...params, authChoice: normalizedProviderAuthChoice };
  const result = await prepareAuthChoiceLoadedPluginProvider(
    normalizedParams,
    (prepared) => prepared,
  );
  if (result) {
    return result;
  }

  const deprecatedProviderChoiceError = await formatDeprecatedProviderChoiceError(
    normalizedParams.authChoice,
    normalizedParams,
  );
  if (deprecatedProviderChoiceError) {
    throw new Error(deprecatedProviderChoiceError);
  }

  if (normalizedParams.authChoice === "token" || normalizedParams.authChoice === "setup-token") {
    throw new Error(
      [
        `Auth choice "${normalizedParams.authChoice}" was not matched to a provider setup flow.`,
        `Run ${formatCliCommand("openclaw models auth login --provider <provider>")} for provider auth, or rerun ${formatCliCommand("openclaw onboard")} to choose interactively.`,
      ].join("\n"),
    );
  }

  if (normalizedParams.authChoice === "oauth") {
    throw new Error(
      `Auth choice "oauth" is no longer supported directly. Use a provider-specific auth entry, or run ${formatCliCommand("openclaw models auth login --provider <provider>")}.`,
    );
  }

  return {
    config: normalizedParams.config,
    authProfiles: [],
    persistAuthProfiles: async () => {},
  };
}

/** Apply a selected auth choice, returning the mutated config or retry/model override signals. */
export async function applyAuthChoice(
  params: ApplyAuthChoiceParams,
): Promise<ApplyAuthChoiceResult> {
  const prepared = await prepareAuthChoice(params);
  await prepared.persistAuthProfiles();
  return {
    config: prepared.config,
    ...(prepared.utilityModelOverride
      ? { utilityModelOverride: prepared.utilityModelOverride, modelTarget: prepared.modelTarget }
      : {}),
    ...(prepared.agentModelOverride ? { agentModelOverride: prepared.agentModelOverride } : {}),
    ...(prepared.retrySelection ? { retrySelection: true } : {}),
  };
}
