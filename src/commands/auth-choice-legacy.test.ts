import { describe, expect, it } from "vitest";
import {
  resolveLegacyAuthChoiceAliasesForCli,
  formatDeprecatedNonInteractiveAuthChoiceError,
  normalizeLegacyOnboardAuthChoice,
  resolveDeprecatedAuthChoiceReplacement,
} from "./auth-choice-legacy.js";

describe("auth choice legacy aliases", () => {
  it("maps codex-cli to the plugin-backed Codex choice", () => {
    expect(normalizeLegacyOnboardAuthChoice("codex-cli")).toBe("openai-codex");
    expect(resolveDeprecatedAuthChoiceReplacement("codex-cli")).toEqual({
      normalized: "openai-codex",
      message:
        'Auth choice "codex-cli" is deprecated; using OpenAI Codex (ChatGPT OAuth) setup instead.',
    });
    expect(formatDeprecatedNonInteractiveAuthChoiceError("codex-cli")).toBe(
      'Auth choice "codex-cli" is deprecated.\nUse "--auth-choice openai-codex".',
    );
  });

  it("sources deprecated cli aliases from plugin manifests", () => {
    expect(resolveLegacyAuthChoiceAliasesForCli()).toEqual(["codex-cli"]);
  });
});
