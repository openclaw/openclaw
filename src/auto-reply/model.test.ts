/** Tests model reference formatting and parsing helpers used by auto-reply. */
import { describe, expect, it } from "vitest";
import { extractModelDirective } from "./model.js";

describe("extractModelDirective", () => {
  describe("basic /model command", () => {
    it("parses a leading -s as a model-less session option", () => {
      const result = extractModelDirective("/model -s opus");
      expect(result.hasDirective).toBe(true);
      expect(result.rawModel).toBeUndefined();
      expect(result.cleaned).toBe("opus");
    });

    it.each(["--runtime codex", "runtime=codex", "harness=codex"])(
      "parses model-less runtime option %s",
      (option) => {
        const result = extractModelDirective(`/model ${option}`);
        expect(result.hasDirective).toBe(true);
        expect(result.rawModel).toBeUndefined();
        expect(result.rawRuntime).toBe("codex");
        expect(result.cleaned).toBe("");
      },
    );

    it("does not consume a reserved option as a missing runtime value", () => {
      const result = extractModelDirective("/model --runtime --session");
      expect(result.hasDirective).toBe(true);
      expect(result.rawModel).toBeUndefined();
      expect(result.rawRuntime).toBeUndefined();
      expect(result.cleaned).toBe("--runtime --session");
    });

    it("keeps partial runtime option names as ordinary text", () => {
      const result = extractModelDirective("/model openai/gpt-5.6-luna runtime-extra=codex");
      expect(result.rawModel).toBe("openai/gpt-5.6-luna");
      expect(result.rawRuntime).toBeUndefined();
      expect(result.cleaned).toBe("runtime-extra=codex");
    });

    it("keeps OpenRouter preset paths that include @ in the model name", () => {
      const result = extractModelDirective("/model openrouter/@preset/kimi-2-5");
      expect(result.hasDirective).toBe(true);
      expect(result.rawModel).toBe("openrouter/@preset/kimi-2-5");
      expect(result.rawProfile).toBeUndefined();
    });

    it("still allows profile overrides after OpenRouter preset paths", () => {
      const result = extractModelDirective("/model openrouter/@preset/kimi-2-5@work");
      expect(result.hasDirective).toBe(true);
      expect(result.rawModel).toBe("openrouter/@preset/kimi-2-5");
      expect(result.rawProfile).toBe("work");
    });
  });

  describe("alias shortcuts", () => {
    it("recognizes /gpt as model directive when alias is configured", () => {
      const result = extractModelDirective("/gpt", {
        aliases: ["gpt", "sonnet", "opus"],
      });
      expect(result.hasDirective).toBe(true);
      expect(result.source).toBe("alias");
      expect(result.rawModel).toBe("gpt");
      expect(result.rawRuntime).toBeUndefined();
      expect(result.cleaned).toBe("");
    });

    it.each(["--runtime codex -s", "-s --runtime codex"])(
      "applies runtime and session alias options from %s",
      (options) => {
        const result = extractModelDirective(`/gpt ${options}`, {
          aliases: ["gpt"],
        });
        expect(result.rawModel).toBe("gpt");
        expect(result.rawRuntime).toBe("codex");
        expect(result.cleaned).toBe("");
      },
    );

    it("recognizes alias options after an optional colon", () => {
      const result = extractModelDirective("/gpt: --session", {
        aliases: ["gpt", "sonnet", "opus"],
      });
      expect(result.hasDirective).toBe(true);
      expect(result.rawModel).toBe("gpt");
      expect(result.cleaned).toBe("");
    });

    it("preserves duplicate alias runtime and session options for validation", () => {
      const runtime = extractModelDirective("/gpt --runtime codex --runtime acp", {
        aliases: ["gpt"],
      });
      expect(runtime.rawRuntime).toBe("codex");
      expect(runtime.cleaned).toBe("--runtime acp");

      const session = extractModelDirective("/gpt -s --session", {
        aliases: ["gpt"],
      });
      expect(session.scopeConflict).toBe(true);
      expect(session.cleaned).toBe("--session");
    });

    it("recognizes alias mid-message", () => {
      const result = extractModelDirective("switch to /opus please", {
        aliases: ["opus"],
      });
      expect(result.hasDirective).toBe(true);
      expect(result.rawModel).toBe("opus");
      expect(result.cleaned).toBe("switch to please");
    });

    it("is case-insensitive for aliases", () => {
      const result = extractModelDirective("/GPT", { aliases: ["gpt"] });
      expect(result.hasDirective).toBe(true);
      expect(result.rawModel).toBe("GPT");
    });

    it("does not match alias without leading slash", () => {
      const result = extractModelDirective("gpt is great", {
        aliases: ["gpt"],
      });
      expect(result.hasDirective).toBe(false);
    });

    it("attributes a literal /model directive when alias text follows it", () => {
      const result = extractModelDirective("/model status /gpt", {
        aliases: ["gpt"],
      });
      expect(result.hasDirective).toBe(true);
      expect(result.source).toBe("model");
      expect(result.rawModel).toBe("status");
      expect(result.cleaned).toBe("/gpt");
    });
  });

  describe("edge cases", () => {
    it("does not match partial alias", () => {
      const result = extractModelDirective("/gpt-turbo", { aliases: ["gpt"] });
      expect(result.hasDirective).toBe(false);
    });

    it("handles empty body", () => {
      const result = extractModelDirective("", { aliases: ["gpt"] });
      expect(result.hasDirective).toBe(false);
      expect(result.cleaned).toBe("");
    });
  });
});
