// Applies an onboarding auth choice through provider setup flows and legacy normalization.
import { formatCliCommand } from "../cli/command-format.js";
import { prepareAuthChoiceLoadedPluginProvider } from "../plugins/provider-auth-choice.js";
import type {
  ApplyAuthChoiceParams,
  ApplyAuthChoiceResult,
  PreparedAuthChoiceResult,
} from "./auth-choice.apply.types.js";

/** Prepare a selected auth choice without writing its returned provider profiles. */
export async function prepareAuthChoice(
  params: ApplyAuthChoiceParams,
): Promise<PreparedAuthChoiceResult> {
  let authChoice = params.authChoice;
  if (authChoice === "oauth") {
    authChoice = "setup-token";
  } else {
    const { resolveLegacyOnboardAuthChoice } = await import("./auth-choice-legacy.js");
    authChoice = resolveLegacyOnboardAuthChoice(authChoice, params).authChoice ?? authChoice;
  }
  if (
    params.opts?.tokenProvider &&
    (authChoice === "apiKey" || authChoice === "token" || authChoice === "setup-token")
  ) {
    const { normalizeApiKeyTokenProviderAuthChoice } =
      await import("./auth-choice.apply.api-providers.js");
    authChoice = normalizeApiKeyTokenProviderAuthChoice({
      authChoice,
      tokenProvider: params.opts.tokenProvider,
      config: params.config,
      workspaceDir: params.workspaceDir,
      env: params.env,
    });
  }
  const normalizedParams = authChoice === params.authChoice ? params : { ...params, authChoice };
  const result = await prepareAuthChoiceLoadedPluginProvider(
    normalizedParams,
    (prepared) => prepared,
  );
  if (result) {
    return result;
  }

  const { resolveManifestDeprecatedProviderAuthChoice } =
    await import("../plugins/provider-auth-choices.js");
  const deprecatedChoice =
    resolveManifestDeprecatedProviderAuthChoice(authChoice, normalizedParams) ??
    (
      await import("../plugins/provider-install-catalog.js")
    ).resolveDeprecatedProviderInstallCatalogEntry(authChoice, {
      ...normalizedParams,
      includeUntrustedWorkspacePlugins: false,
    });
  if (deprecatedChoice) {
    throw new Error(
      `Auth choice ${JSON.stringify(authChoice)} is no longer supported. Use ${JSON.stringify(deprecatedChoice.choiceId)} instead, or run ${formatCliCommand("openclaw onboard")} to choose interactively.`,
    );
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
