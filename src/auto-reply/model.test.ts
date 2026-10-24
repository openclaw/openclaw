import { describe, expect, it } from "vitest";
import { extractModelDirective } from "./model.js";

describe("extractModelDirective", () => {
  it.each([
    ["-s opus", undefined, undefined, "opus"],
    ["--runtime codex", undefined, "codex", ""],
    ["runtime=codex", undefined, "codex", ""],
    ["harness=codex", undefined, "codex", ""],
    ["--runtime --session", undefined, undefined, "--runtime --session"],
    [
      "openai/gpt-5.6-luna runtime-extra=codex",
      "openai/gpt-5.6-luna",
      undefined,
      "runtime-extra=codex",
    ],
  ] as const)("parses model options: %s", (args, rawModel, rawRuntime, cleaned) => {
    const parsed = extractModelDirective(`/model ${args}`);
    expect(parsed).toMatchObject({ hasDirective: true, rawModel, rawRuntime, cleaned });
  });

  it("parses a quoted model ID", () => {
    expect(extractModelDirective('/model "openrouter/free"')).toMatchObject({
      hasDirective: true,
      rawModel: "openrouter/free",
      cleaned: "",
    });
  });

  it("allows profile overrides after OpenRouter preset paths", () => {
    expect(extractModelDirective("/model openrouter/@preset/kimi-2-5@work")).toMatchObject({
      hasDirective: true,
      rawModel: "openrouter/@preset/kimi-2-5",
      rawProfile: "work",
    });
  });

  it.each(["--runtime codex -s", "-s --runtime codex"])("parses alias options: %s", (options) => {
    const parsed = extractModelDirective(`/gpt ${options}`, { aliases: ["gpt"] });
    expect(parsed).toMatchObject({ rawModel: "gpt", rawRuntime: "codex", cleaned: "" });
  });

  it.each([
    ["/gpt: --session", ["gpt", "sonnet", "opus"], "gpt", "alias", ""],
    ["switch to /OPUS please", ["opus"], "OPUS", "alias", "switch to please"],
    ["/model status /gpt", ["gpt"], "status", "model", "/gpt"],
  ] as const)(
    "recognizes aliases and literal model precedence: %s",
    (body, aliases, rawModel, source, cleaned) => {
      expect(extractModelDirective(body, { aliases: [...aliases] })).toMatchObject({
        hasDirective: true,
        rawModel,
        source,
        cleaned,
        rawRuntime: undefined,
      });
    },
  );

  it("preserves duplicate alias options for validation", () => {
    expect(
      extractModelDirective("/gpt --runtime codex --runtime acp", { aliases: ["gpt"] }),
    ).toMatchObject({ rawRuntime: "codex", cleaned: "--runtime acp" });
    expect(extractModelDirective("/gpt -s --session", { aliases: ["gpt"] })).toMatchObject({
      scopeConflict: true,
      cleaned: "--session",
    });
  });

  it.each(["/gpt-turbo", ""])("rejects partial or absent aliases: %j", (body) => {
    const parsed = extractModelDirective(body, { aliases: ["gpt"] });
    expect(parsed).toMatchObject({ hasDirective: false, cleaned: body });
  });
});
