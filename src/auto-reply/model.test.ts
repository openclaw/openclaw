import { describe, expect, it } from "vitest";
import { extractModelDirective } from "./model.js";

describe("extractModelDirective", () => {
  it.each([
    ["/model -s opus", { hasDirective: true, rawModel: undefined, cleaned: "opus" }],
    ...["--runtime codex", "runtime=codex", "harness=codex"].map(
      (option) =>
        [
          `/model ${option}`,
          { hasDirective: true, rawModel: undefined, rawRuntime: "codex", cleaned: "" },
        ] as const,
    ),
    [
      "/model --runtime --session",
      {
        hasDirective: true,
        rawModel: undefined,
        rawRuntime: undefined,
        cleaned: "--runtime --session",
      },
    ],
    [
      "/model openai/gpt-5.6-luna runtime-extra=codex",
      {
        rawModel: "openai/gpt-5.6-luna",
        rawRuntime: undefined,
        cleaned: "runtime-extra=codex",
      },
    ],
    [
      "/model openrouter/@preset/kimi-2-5@work",
      {
        hasDirective: true,
        rawModel: "openrouter/@preset/kimi-2-5",
        rawProfile: "work",
      },
    ],
  ] as const)("parses model options without consuming ordinary text: %s", (body, expected) => {
    expect(extractModelDirective(body)).toMatchObject(expected);
  });

  it.each([
    ...["--runtime codex -s", "-s --runtime codex"].map(
      (options) =>
        [
          `/gpt ${options}`,
          ["gpt"],
          { rawModel: "gpt", rawRuntime: "codex", cleaned: "" },
        ] as const,
    ),
    [
      "/gpt: --session",
      ["gpt", "sonnet", "opus"],
      {
        hasDirective: true,
        rawModel: "gpt",
        cleaned: "",
      },
    ],
    [
      "switch to /OPUS please",
      ["opus"],
      {
        hasDirective: true,
        source: "alias",
        rawModel: "OPUS",
        rawRuntime: undefined,
        cleaned: "switch to please",
      },
    ],
    [
      "/model status /gpt",
      ["gpt"],
      {
        hasDirective: true,
        source: "model",
        rawModel: "status",
        cleaned: "/gpt",
      },
    ],
    ["/gpt-turbo", ["gpt"], { hasDirective: false }],
    ["", ["gpt"], { hasDirective: false, cleaned: "" }],
  ] as const)(
    "recognizes complete aliases and literal model precedence: %s",
    (body, aliases, expected) => {
      expect(extractModelDirective(body, { aliases: [...aliases] })).toMatchObject(expected);
    },
  );

  it("preserves duplicate alias runtime and session options for validation", () => {
    expect(
      extractModelDirective("/gpt --runtime codex --runtime acp", { aliases: ["gpt"] }),
    ).toMatchObject({ rawRuntime: "codex", cleaned: "--runtime acp" });
    expect(extractModelDirective("/gpt -s --session", { aliases: ["gpt"] })).toMatchObject({
      scopeConflict: true,
      cleaned: "--session",
    });
  });
});
