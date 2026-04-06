import {
  describeCodexNativeWebSearch,
  isCodexNativeWebSearchRelevant,
} from "../agents/codex-native-web-search.js";
import type { OpenClawConfig } from "../config/config.js";
import type { WizardPrompter } from "../wizard/prompts.js";

export type CodexNativeWebSearchSetupResult = {
  config: OpenClawConfig;
  configureManagedProvider: boolean;
};

export async function promptCodexNativeWebSearchSetup(params: {
  config: OpenClawConfig;
  prompter: WizardPrompter;
}): Promise<CodexNativeWebSearchSetupResult> {
  if (!isCodexNativeWebSearchRelevant({ config: params.config })) {
    return {
      config: params.config,
      configureManagedProvider: true,
    };
  }

  const existingSearch = params.config.tools?.web?.search;
  const codexSearchDescription = describeCodexNativeWebSearch(params.config);

  await params.prompter.note(
    [
      "Codex-capable models can optionally use native Codex web search.",
      "Managed web_search still controls non-Codex models.",
      "If no managed provider is configured, non-Codex models still rely on provider auto-detect and may have no search available.",
      ...(codexSearchDescription ? [codexSearchDescription] : ["Recommended mode: cached."]),
    ].join("\n"),
    "Codex native search",
  );

  const enableCodexNative = await params.prompter.confirm({
    message: "Enable native Codex web search for Codex-capable models?",
    initialValue: existingSearch?.openaiCodex?.enabled === true,
  });

  if (!enableCodexNative) {
    return {
      config: {
        ...params.config,
        tools: {
          ...params.config.tools,
          web: {
            ...params.config.tools?.web,
            search: {
              ...existingSearch,
              openaiCodex: {
                ...existingSearch?.openaiCodex,
                enabled: false,
              },
            },
          },
        },
      },
      configureManagedProvider: true,
    };
  }

  const codexMode = await params.prompter.select({
    message: "Codex native web search mode",
    options: [
      {
        value: "cached" as const,
        label: "cached (recommended)",
        hint: "Uses cached web content",
      },
      {
        value: "live" as const,
        label: "live",
        hint: "Allows live external web access",
      },
    ],
    initialValue: existingSearch?.openaiCodex?.mode ?? "cached",
  });

  const config = {
    ...params.config,
    tools: {
      ...params.config.tools,
      web: {
        ...params.config.tools?.web,
        search: {
          ...existingSearch,
          enabled: true,
          openaiCodex: {
            ...existingSearch?.openaiCodex,
            enabled: true,
            mode: codexMode,
          },
        },
      },
    },
  };

  const configureManagedProvider = await params.prompter.confirm({
    message: "Configure or change a managed web search provider now?",
    initialValue: Boolean(existingSearch?.provider),
  });

  return {
    config,
    configureManagedProvider,
  };
}
