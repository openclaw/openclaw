/**
 * MemoryRouter onboarding wizard step
 *
 * Prompts user to enable persistent AI memory during onboarding.
 */

import open from "open";
import type { OpenClawConfig } from "../config/config.js";
import type { WizardPrompter } from "../wizard/prompts.js";

/**
 * Setup MemoryRouter during onboarding wizard.
 * Called after model selection, before gateway config.
 */
export async function setupMemoryRouter(
  config: OpenClawConfig,
  prompter: WizardPrompter,
): Promise<OpenClawConfig> {
  const enableMemory = await prompter.select({
    message: "Enable persistent AI memory?",
    options: [
      { value: "yes", label: "Yes — I have a MemoryRouter key", hint: "memoryrouter.ai" },
      { value: "signup", label: "Yes — Sign up now", hint: "Opens memoryrouter.ai/signup" },
      { value: "skip", label: "No — Skip for now" },
    ],
  });

  if (enableMemory === "skip") {
    return config;
  }

  if (enableMemory === "signup") {
    await prompter.note(
      [
        "Opening memoryrouter.ai/signup in your browser.",
        "",
        "Create an account and generate a memory key (mk_...).",
        "Come back here when you have it.",
      ].join("\n"),
      "MemoryRouter",
    );
    await open("https://memoryrouter.ai/signup");

    const hasKey = await prompter.confirm({
      message: "Got your key?",
      initialValue: true,
    });

    if (!hasKey) {
      await prompter.note(
        "No problem. Run `openclaw memoryrouter setup` later to enable memory.",
        "Skipped",
      );
      return config;
    }
  }

  const mrKey = await prompter.text({
    message: "MemoryRouter API key",
    placeholder: "mk_...",
    validate: (v) => {
      if (!v?.trim()) {
        return "Key is required";
      }
      if (!v.startsWith("mk_") && !v.startsWith("mk-")) {
        return "Key must start with mk_";
      }
      return undefined;
    },
  });

  return {
    ...config,
    memoryRouter: {
      enabled: true,
      key: mrKey.trim(),
    },
  };
}
