import type { ApiKeyCredential } from "../../../agents/auth-profiles/types.js";
import { formatCliCommand } from "../../../cli/command-format.js";
import { quoteCliArg } from "../../../cli/quote-cli-arg.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { SecretInput } from "../../../config/types.secrets.js";
import { formatErrorMessage } from "../../../infra/errors.js";
import { resolveManifestDeprecatedProviderAuthChoice } from "../../../plugins/provider-auth-choices.js";
import type {
  ProviderNonInteractiveApiKeyCredentialParams,
  ProviderNonInteractiveApiKeyResult,
  ProviderResolveNonInteractiveApiKeyParams,
} from "../../../plugins/provider-authentication.types.js";
import { resolveDeprecatedProviderInstallCatalogEntry } from "../../../plugins/provider-install-catalog.js";
import { ExitError, type RuntimeEnv } from "../../../runtime.js";
import { resolveDefaultSecretProviderAlias } from "../../../secrets/ref-contract.js";
import { resolveLegacyOnboardAuthChoice } from "../../auth-choice-legacy.js";
import { formatAuthChoiceChoicesForCli } from "../../auth-choice-options.js";
import { normalizeApiKeyTokenProviderAuthChoice } from "../../auth-choice.apply.api-providers.js";
import type { OnboardingAgentTarget } from "../../onboard-agent-target.js";
import {
  applyCustomApiConfig,
  CustomApiError,
  parseNonInteractiveCustomApiFlags,
  resolveCustomProviderId,
} from "../../onboard-custom-config.js";
import { rejectOnboardingOption } from "../../onboard-options.js";
import type { AuthChoice, OnboardOptions } from "../../onboard-types.js";
import { resolveNonInteractiveApiKey } from "../api-keys.js";
import { applyNonInteractivePluginProviderChoice } from "./auth-choice.plugin-providers.js";

/** Applies a local non-interactive auth choice to the pending OpenClaw config. */
export async function applyNonInteractiveAuthChoice(params: {
  nextConfig: OpenClawConfig;
  authChoice: AuthChoice;
  opts: OnboardOptions;
  runtime: RuntimeEnv;
  baseConfig: OpenClawConfig;
  target: OnboardingAgentTarget;
}): Promise<OpenClawConfig | null> {
  const { opts, runtime, baseConfig } = params;
  const reject = (message: string): null => {
    rejectOnboardingOption(opts, runtime, message);
    return null;
  };
  let authChoice = normalizeApiKeyTokenProviderAuthChoice({
    authChoice: params.authChoice,
    tokenProvider: opts.tokenProvider,
    config: params.nextConfig,
    workspaceDir: params.target.workspaceDir,
    env: process.env,
  });
  const nextConfig = params.nextConfig;
  const toStoredSecretInput = (paramsLocal: {
    resolved: ProviderNonInteractiveApiKeyResult;
    provider: string;
    envVarName?: string;
  }): SecretInput | null => {
    const { resolved } = paramsLocal;
    if (opts.secretInputMode !== "ref") {
      return resolved.key;
    }
    if (resolved.source !== "env" || !resolved.envVarName) {
      // Existing profiles may be reused, but neither serializer may turn their
      // resolved secret or a literal flag into plaintext when refs were requested.
      const envHint = paramsLocal.envVarName
        ? `Set ${paramsLocal.envVarName} in env and retry`
        : "Set the provider API key env var and retry";
      return reject(
        [
          `--secret-input-mode ref requires an explicit environment variable for provider "${paramsLocal.provider}".`,
          `${envHint}, or use --secret-input-mode plaintext.`,
        ].join("\n"),
      );
    }
    return {
      source: "env",
      provider: resolveDefaultSecretProviderAlias(baseConfig, "env", {
        preferFirstProviderForSource: true,
      }),
      id: resolved.envVarName,
    };
  };
  const resolveApiKey = (input: ProviderResolveNonInteractiveApiKeyParams) =>
    resolveNonInteractiveApiKey({
      ...input,
      cfg: nextConfig,
      runtime,
      agentDir: params.target.agentDir,
      workspaceDir: params.target.workspaceDir,
      secretInputMode: opts.secretInputMode,
      json: opts.json,
    });
  const toApiKeyCredential = (
    paramsLocal: ProviderNonInteractiveApiKeyCredentialParams,
  ): ApiKeyCredential | null => {
    const stored = toStoredSecretInput({
      resolved: paramsLocal.resolved,
      provider: paramsLocal.provider,
    });
    if (!stored) {
      return null;
    }
    return {
      type: "api_key",
      provider: paramsLocal.provider,
      ...(typeof stored === "string" ? { key: stored } : { keyRef: stored }),
      ...(paramsLocal.email ? { email: paramsLocal.email } : {}),
      ...(paramsLocal.metadata ? { metadata: paramsLocal.metadata } : {}),
    };
  };
  const providerLookup = {
    config: nextConfig,
    workspaceDir: params.target.workspaceDir,
    env: process.env,
  };
  const legacyChoice = resolveLegacyOnboardAuthChoice(authChoice, providerLookup);
  if (legacyChoice.deprecated) {
    // Only provider aliases normalize here; the onboarding entry point owns
    // the separate oauth spelling before local dispatch.
    runtime.log(legacyChoice.deprecated.message);
    authChoice = legacyChoice.authChoice;
  }

  const deprecatedChoice = resolveManifestDeprecatedProviderAuthChoice(authChoice, providerLookup);
  const deprecatedInstallChoice = deprecatedChoice
    ? undefined
    : resolveDeprecatedProviderInstallCatalogEntry(authChoice, {
        ...providerLookup,
        includeUntrustedWorkspacePlugins: false,
      });
  const replacementChoiceId = deprecatedChoice?.choiceId ?? deprecatedInstallChoice?.choiceId;
  if (replacementChoiceId) {
    return reject(
      `${JSON.stringify(authChoice)} is no longer supported. Use --auth-choice ${JSON.stringify(replacementChoiceId)} instead.`,
    );
  }

  const validAuthChoices = formatAuthChoiceChoicesForCli(providerLookup).split("|");
  if (!validAuthChoices.includes(authChoice) && !authChoice.startsWith("provider-plugin:")) {
    return reject(
      `Unknown --auth-choice ${JSON.stringify(authChoice)}. Valid choices: ${validAuthChoices.join(", ")}.`,
    );
  }

  const pluginProviderChoice = await applyNonInteractivePluginProviderChoice({
    nextConfig,
    authChoice,
    opts,
    runtime,
    baseConfig,
    target: params.target,
    resolveApiKey,
    toApiKeyCredential,
  });
  if (pluginProviderChoice !== undefined) {
    // null means the plugin path handled an error and requested exit; undefined
    // means no trusted plugin matched and core choices should continue.
    return pluginProviderChoice;
  }

  if (authChoice === "setup-token" || authChoice === "token") {
    return reject(
      [
        `Auth choice "${params.authChoice}" was not matched to a provider setup flow.`,
        'For Anthropic legacy token auth, use "--auth-choice setup-token --token-provider anthropic --token <token>" or pass "--auth-choice token --token-provider anthropic".',
      ].join("\n"),
    );
  }

  if (authChoice === "custom-api-key") {
    try {
      // Custom provider setup can be optional-key: some local endpoints do not
      // require auth, but flags and env refs still need validation if present.
      const customAuth = parseNonInteractiveCustomApiFlags({
        baseUrl: opts.customBaseUrl,
        modelId: opts.customModelId,
        compatibility: opts.customCompatibility,
        apiKey: opts.customApiKey,
        providerId: opts.customProviderId,
        supportsImageInput: opts.customImageInput,
      });
      const resolvedProviderId = resolveCustomProviderId({
        config: nextConfig,
        baseUrl: customAuth.baseUrl,
        providerId: customAuth.providerId,
      });
      const resolvedCustomApiKey = await resolveApiKey({
        provider: resolvedProviderId.providerId,
        flagValue: customAuth.apiKey,
        flagName: "--custom-api-key",
        envVar: "CUSTOM_API_KEY",
        envVarName: "CUSTOM_API_KEY",
        required: false,
      });
      let customApiKeyInput: SecretInput | undefined;
      if (
        resolvedCustomApiKey &&
        (opts.secretInputMode !== "ref" || resolvedCustomApiKey.source !== "profile")
      ) {
        // Profile ownership stays in the auth store; serializing its resolved
        // value would expose plaintext and overwrite an existing SecretRef.
        const stored = toStoredSecretInput({
          resolved: resolvedCustomApiKey,
          provider: resolvedProviderId.providerId,
          envVarName: "CUSTOM_API_KEY",
        });
        if (!stored) {
          return null;
        }
        customApiKeyInput = stored;
      }
      const result = applyCustomApiConfig({
        config: nextConfig,
        baseUrl: customAuth.baseUrl,
        modelId: customAuth.modelId,
        compatibility: customAuth.compatibility,
        apiKey: customApiKeyInput,
        providerId: customAuth.providerId,
        supportsImageInput: customAuth.supportsImageInput,
        target: params.target,
      });
      if (result.providerIdRenamedFrom && result.providerId) {
        runtime.log(
          `Custom provider ID "${result.providerIdRenamedFrom}" already exists for a different base URL. Using "${result.providerId}".`,
        );
      }
      if (customApiKeyInput !== undefined && resolvedCustomApiKey?.source !== "profile") {
        const { isSetupCredentialReplacement, saveSetupCredential } =
          await import("../../../system-agent/setup-inference-credentials.js");
        if (
          await isSetupCredentialReplacement({
            provider: result.providerId,
            baseConfig,
            agentDir: params.target.agentDir,
          })
        ) {
          const { prepareCustomSetupCredentials } =
            await import("../../../system-agent/setup-inference-custom.js");
          const prepared = prepareCustomSetupCredentials(result);
          const saved = await saveSetupCredential({
            profile: prepared.profiles[0]!,
            config: prepared.config,
            baseConfig,
            agentDir: params.target.agentDir,
            modelRef: `${result.providerId}/${result.modelId}`,
          });
          return reject(
            `Replacement credential saved but inactive. Your connection is unchanged. Test and activate it with:\n${formatCliCommand(`openclaw models auth activate ${quoteCliArg(saved.profile.profileId)} --agent ${quoteCliArg(params.target.agentId)}`)}`,
          );
        }
      }
      return result.config;
    } catch (err) {
      if (err instanceof ExitError) {
        throw err;
      }
      const message =
        err instanceof CustomApiError &&
        (err.code === "missing_required" || err.code === "invalid_compatibility")
          ? err.message
          : `Invalid custom provider config: ${err instanceof CustomApiError ? err.message : formatErrorMessage(err)}`;
      return reject(message);
    }
  }

  if (
    authChoice === "chutes" ||
    authChoice === "minimax-global-oauth" ||
    authChoice === "minimax-cn-oauth"
  ) {
    return reject("OAuth requires interactive mode.");
  }

  return nextConfig;
}
