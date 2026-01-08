import {
  loginAnthropic,
  loginOpenAICodex,
  type OAuthCredentials,
  type OAuthProvider,
} from "@mariozechner/pi-ai";
import { resolveAgentConfig } from "../agents/agent-scope.js";
import {
  CLAUDE_CLI_PROFILE_ID,
  CODEX_CLI_PROFILE_ID,
  ensureAuthProfileStore,
  listProfilesForProvider,
} from "../agents/auth-profiles.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../agents/defaults.js";
import {
  getCustomProviderApiKey,
  resolveEnvApiKey,
} from "../agents/model-auth.js";
import { loadModelCatalog } from "../agents/model-catalog.js";
import { resolveConfiguredModelRef } from "../agents/model-selection.js";
import type { ClawdbotConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import {
  isRemoteEnvironment,
  loginAntigravityVpsAware,
} from "./antigravity-oauth.js";
import {
  applyAuthProfileConfig,
  applyMinimaxConfig,
  applyMinimaxProviderConfig,
  setAnthropicApiKey,
  writeOAuthCredentials,
} from "./onboard-auth.js";
import { openUrl } from "./onboard-helpers.js";
import type { AuthChoice } from "./onboard-types.js";
import {
  applyOpenAICodexModelDefault,
  OPENAI_CODEX_DEFAULT_MODEL,
} from "./openai-codex-model-default.js";

export async function warnIfModelConfigLooksOff(
  config: ClawdbotConfig,
  prompter: WizardPrompter,
  options?: { agentId?: string; agentDir?: string },
) {
  const agentModelOverride = options?.agentId
    ? resolveAgentConfig(config, options.agentId)?.model?.trim()
    : undefined;
  const configWithModel =
    agentModelOverride && agentModelOverride.length > 0
      ? {
          ...config,
          agent: {
            ...config.agent,
            model: {
              ...(typeof config.agent?.model === "object"
                ? config.agent.model
                : undefined),
              primary: agentModelOverride,
            },
          },
        }
      : config;
  const ref = resolveConfiguredModelRef({
    cfg: configWithModel,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });
  const warnings: string[] = [];
  const catalog = await loadModelCatalog({
    config: configWithModel,
    useCache: false,
  });
  if (catalog.length > 0) {
    const known = catalog.some(
      (entry) => entry.provider === ref.provider && entry.id === ref.model,
    );
    if (!known) {
      warnings.push(
        `Model not found: ${ref.provider}/${ref.model}. Update agent.model or run /models list.`,
      );
    }
  }

  const store = ensureAuthProfileStore(options?.agentDir);
  const hasProfile = listProfilesForProvider(store, ref.provider).length > 0;
  const envKey = resolveEnvApiKey(ref.provider);
  const customKey = getCustomProviderApiKey(config, ref.provider);
  if (!hasProfile && !envKey && !customKey) {
    warnings.push(
      `No auth configured for provider "${ref.provider}". The agent may fail until credentials are added.`,
    );
  }

  if (ref.provider === "openai") {
    const hasCodex = listProfilesForProvider(store, "openai-codex").length > 0;
    if (hasCodex) {
      warnings.push(
        `Detected OpenAI Codex OAuth. Consider setting agent.model to ${OPENAI_CODEX_DEFAULT_MODEL}.`,
      );
    }
  }

  if (warnings.length > 0) {
    await prompter.note(warnings.join("\n"), "Model check");
  }
}

export async function applyAuthChoice(params: {
  authChoice: AuthChoice;
  config: ClawdbotConfig;
  prompter: WizardPrompter;
  runtime: RuntimeEnv;
  agentDir?: string;
  setDefaultModel: boolean;
  agentId?: string;
}): Promise<{ config: ClawdbotConfig; agentModelOverride?: string }> {
  let nextConfig = params.config;
  let agentModelOverride: string | undefined;

  const noteAgentModel = async (model: string) => {
    if (!params.agentId) return;
    await params.prompter.note(
      `Default model set to ${model} for agent "${params.agentId}".`,
      "Model configured",
    );
  };

  if (params.authChoice === "oauth") {
    await params.prompter.note(
      "Browser will open. Paste the code shown after login (code#state).",
      "Anthropic OAuth",
    );
    const spin = params.prompter.progress("Waiting for authorization…");
    let oauthCreds: OAuthCredentials | null = null;
    try {
      oauthCreds = await loginAnthropic(
        async (url) => {
          await openUrl(url);
          params.runtime.log(`Open: ${url}`);
        },
        async () => {
          const code = await params.prompter.text({
            message: "Paste authorization code (code#state)",
            validate: (value) => (value?.trim() ? undefined : "Required"),
          });
          return String(code);
        },
      );
      spin.stop("OAuth complete");
      if (oauthCreds) {
        await writeOAuthCredentials("anthropic", oauthCreds, params.agentDir);
        const profileId = `anthropic:${oauthCreds.email ?? "default"}`;
        nextConfig = applyAuthProfileConfig(nextConfig, {
          profileId,
          provider: "anthropic",
          mode: "oauth",
          email: oauthCreds.email ?? undefined,
        });
      }
    } catch (err) {
      spin.stop("OAuth failed");
      params.runtime.error(String(err));
      await params.prompter.note(
        "Trouble with OAuth? See https://docs.clawd.bot/start/faq",
        "OAuth help",
      );
    }
  } else if (params.authChoice === "claude-cli") {
    const store = ensureAuthProfileStore(params.agentDir, {
      allowKeychainPrompt: false,
    });
    const hasClaudeCli = Boolean(store.profiles[CLAUDE_CLI_PROFILE_ID]);
    if (!hasClaudeCli && process.platform === "darwin") {
      await params.prompter.note(
        [
          "macOS will show a Keychain prompt next.",
          'Choose "Always Allow" so the launchd gateway can start without prompts.',
          'If you choose "Allow" or "Deny", each restart will block on a Keychain alert.',
        ].join("\n"),
        "Claude CLI Keychain",
      );
      const proceed = await params.prompter.confirm({
        message: "Check Keychain for Claude CLI credentials now?",
        initialValue: true,
      });
      if (!proceed) {
        return { config: nextConfig, agentModelOverride };
      }
    }

    const storeWithKeychain = hasClaudeCli
      ? store
      : ensureAuthProfileStore(params.agentDir, {
          allowKeychainPrompt: true,
        });

    if (!storeWithKeychain.profiles[CLAUDE_CLI_PROFILE_ID]) {
      await params.prompter.note(
        process.platform === "darwin"
          ? 'No Claude CLI credentials found in Keychain ("Claude Code-credentials") or ~/.claude/.credentials.json.'
          : "No Claude CLI credentials found at ~/.claude/.credentials.json.",
        "Claude CLI OAuth",
      );
      return { config: nextConfig, agentModelOverride };
    }
    nextConfig = applyAuthProfileConfig(nextConfig, {
      profileId: CLAUDE_CLI_PROFILE_ID,
      provider: "anthropic",
      mode: "oauth",
    });
  } else if (params.authChoice === "openai-codex") {
    const isRemote = isRemoteEnvironment();
    await params.prompter.note(
      isRemote
        ? [
            "You are running in a remote/VPS environment.",
            "A URL will be shown for you to open in your LOCAL browser.",
            "After signing in, paste the redirect URL back here.",
          ].join("\n")
        : [
            "Browser will open for OpenAI authentication.",
            "If the callback doesn't auto-complete, paste the redirect URL.",
            "OpenAI OAuth uses localhost:1455 for the callback.",
          ].join("\n"),
      "OpenAI Codex OAuth",
    );
    const spin = params.prompter.progress("Starting OAuth flow…");
    let manualCodePromise: Promise<string> | undefined;
    try {
      const creds = await loginOpenAICodex({
        onAuth: async ({ url }) => {
          if (isRemote) {
            spin.stop("OAuth URL ready");
            params.runtime.log(
              `\nOpen this URL in your LOCAL browser:\n\n${url}\n`,
            );
            manualCodePromise = params.prompter
              .text({
                message: "Paste the redirect URL (or authorization code)",
                validate: (value) => (value?.trim() ? undefined : "Required"),
              })
              .then((value) => String(value));
          } else {
            spin.update("Complete sign-in in browser…");
            await openUrl(url);
            params.runtime.log(`Open: ${url}`);
          }
        },
        onPrompt: async (prompt) => {
          if (manualCodePromise) {
            return manualCodePromise;
          }
          const code = await params.prompter.text({
            message: prompt.message,
            placeholder: prompt.placeholder,
            validate: (value) => (value?.trim() ? undefined : "Required"),
          });
          return String(code);
        },
        onProgress: (msg) => spin.update(msg),
      });
      spin.stop("OpenAI OAuth complete");
      if (creds) {
        await writeOAuthCredentials(
          "openai-codex" as unknown as OAuthProvider,
          creds,
          params.agentDir,
        );
        nextConfig = applyAuthProfileConfig(nextConfig, {
          profileId: "openai-codex:default",
          provider: "openai-codex",
          mode: "oauth",
        });
        if (params.setDefaultModel) {
          const applied = applyOpenAICodexModelDefault(nextConfig);
          nextConfig = applied.next;
          if (applied.changed) {
            await params.prompter.note(
              `Default model set to ${OPENAI_CODEX_DEFAULT_MODEL}`,
              "Model configured",
            );
          }
        } else {
          agentModelOverride = OPENAI_CODEX_DEFAULT_MODEL;
          await noteAgentModel(OPENAI_CODEX_DEFAULT_MODEL);
        }
      }
    } catch (err) {
      spin.stop("OpenAI OAuth failed");
      params.runtime.error(String(err));
      await params.prompter.note(
        "Trouble with OAuth? See https://docs.clawd.bot/start/faq",
        "OAuth help",
      );
    }
  } else if (params.authChoice === "codex-cli") {
    const store = ensureAuthProfileStore(params.agentDir);
    if (!store.profiles[CODEX_CLI_PROFILE_ID]) {
      await params.prompter.note(
        "No Codex CLI credentials found at ~/.codex/auth.json.",
        "Codex CLI OAuth",
      );
      return { config: nextConfig, agentModelOverride };
    }
    nextConfig = applyAuthProfileConfig(nextConfig, {
      profileId: CODEX_CLI_PROFILE_ID,
      provider: "openai-codex",
      mode: "oauth",
    });
    if (params.setDefaultModel) {
      const applied = applyOpenAICodexModelDefault(nextConfig);
      nextConfig = applied.next;
      if (applied.changed) {
        await params.prompter.note(
          `Default model set to ${OPENAI_CODEX_DEFAULT_MODEL}`,
          "Model configured",
        );
      }
    } else {
      agentModelOverride = OPENAI_CODEX_DEFAULT_MODEL;
      await noteAgentModel(OPENAI_CODEX_DEFAULT_MODEL);
    }
  } else if (params.authChoice === "antigravity") {
    const isRemote = isRemoteEnvironment();
    await params.prompter.note(
      isRemote
        ? [
            "You are running in a remote/VPS environment.",
            "A URL will be shown for you to open in your LOCAL browser.",
            "After signing in, copy the redirect URL and paste it back here.",
          ].join("\n")
        : [
            "Browser will open for Google authentication.",
            "Sign in with your Google account that has Antigravity access.",
            "The callback will be captured automatically on localhost:51121.",
          ].join("\n"),
      "Google Antigravity OAuth",
    );
    const spin = params.prompter.progress("Starting OAuth flow…");
    let oauthCreds: OAuthCredentials | null = null;
    try {
      oauthCreds = await loginAntigravityVpsAware(
        async (url) => {
          if (isRemote) {
            spin.stop("OAuth URL ready");
            params.runtime.log(
              `\nOpen this URL in your LOCAL browser:\n\n${url}\n`,
            );
          } else {
            spin.update("Complete sign-in in browser…");
            await openUrl(url);
            params.runtime.log(`Open: ${url}`);
          }
        },
        (msg) => spin.update(msg),
      );
      spin.stop("Antigravity OAuth complete");
      if (oauthCreds) {
        await writeOAuthCredentials(
          "google-antigravity",
          oauthCreds,
          params.agentDir,
        );
        nextConfig = applyAuthProfileConfig(nextConfig, {
          profileId: `google-antigravity:${oauthCreds.email ?? "default"}`,
          provider: "google-antigravity",
          mode: "oauth",
        });
        const modelKey = "google-antigravity/claude-opus-4-5-thinking";
        nextConfig = {
          ...nextConfig,
          agent: {
            ...nextConfig.agent,
            models: {
              ...nextConfig.agent?.models,
              [modelKey]: nextConfig.agent?.models?.[modelKey] ?? {},
            },
          },
        };
        if (params.setDefaultModel) {
          nextConfig = {
            ...nextConfig,
            agent: {
              ...nextConfig.agent,
              model: {
                ...(nextConfig.agent?.model &&
                "fallbacks" in
                  (nextConfig.agent.model as Record<string, unknown>)
                  ? {
                      fallbacks: (
                        nextConfig.agent.model as { fallbacks?: string[] }
                      ).fallbacks,
                    }
                  : undefined),
                primary: modelKey,
              },
            },
          };
          await params.prompter.note(
            `Default model set to ${modelKey}`,
            "Model configured",
          );
        } else {
          agentModelOverride = modelKey;
          await noteAgentModel(modelKey);
        }
      }
    } catch (err) {
      spin.stop("Antigravity OAuth failed");
      params.runtime.error(String(err));
      await params.prompter.note(
        "Trouble with OAuth? See https://docs.clawd.bot/start/faq",
        "OAuth help",
      );
    }
  } else if (params.authChoice === "apiKey") {
    const key = await params.prompter.text({
      message: "Enter Anthropic API key",
      validate: (value) => (value?.trim() ? undefined : "Required"),
    });
    await setAnthropicApiKey(String(key).trim(), params.agentDir);
    nextConfig = applyAuthProfileConfig(nextConfig, {
      profileId: "anthropic:default",
      provider: "anthropic",
      mode: "api_key",
    });
  } else if (params.authChoice === "minimax") {
    if (params.setDefaultModel) {
      nextConfig = applyMinimaxConfig(nextConfig);
    } else {
      nextConfig = applyMinimaxProviderConfig(nextConfig);
      agentModelOverride = "lmstudio/minimax-m2.1-gs32";
      await noteAgentModel("lmstudio/minimax-m2.1-gs32");
    }
  }

  return { config: nextConfig, agentModelOverride };
}
