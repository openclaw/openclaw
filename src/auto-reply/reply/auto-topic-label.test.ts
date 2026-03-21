import { describe, expect, it } from "vitest";
import { resolveAutoTopicLabelConfig } from "./auto-topic-label-config.js";

describe("resolveAutoTopicLabelConfig", () => {
  const DEFAULT_PROMPT_SUBSTRING = "Generate a short topic label";

  it("returns enabled with default prompt when both configs are undefined", () => {
    const result = resolveAutoTopicLabelConfig(undefined, undefined);
    expect(result).not.toBeNull();
    expect(result!.enabled).toBe(true);
    expect(result!.prompt).toContain(DEFAULT_PROMPT_SUBSTRING);
  });

  it("returns enabled with default prompt when config is true (boolean shorthand)", () => {
    const result = resolveAutoTopicLabelConfig(true, undefined);
    expect(result).not.toBeNull();
    expect(result!.enabled).toBe(true);
    expect(result!.prompt).toContain(DEFAULT_PROMPT_SUBSTRING);
  });

  it("returns null when config is false", () => {
    const result = resolveAutoTopicLabelConfig(false, undefined);
    expect(result).toBeNull();
  });

  it("returns enabled with custom prompt (object form)", () => {
    const result = resolveAutoTopicLabelConfig(
      { enabled: true, prompt: "Custom prompt" },
      undefined,
    );
    expect(result).not.toBeNull();
    expect(result!.enabled).toBe(true);
    expect(result!.prompt).toBe("Custom prompt");
  });

  it("returns null when object form has enabled: false", () => {
    const result = resolveAutoTopicLabelConfig({ enabled: false }, undefined);
    expect(result).toBeNull();
  });

  it("returns default prompt when object form has no prompt", () => {
    const result = resolveAutoTopicLabelConfig({ enabled: true }, undefined);
    expect(result).not.toBeNull();
    expect(result!.prompt).toContain(DEFAULT_PROMPT_SUBSTRING);
  });

  it("returns default prompt when object form has empty prompt", () => {
    const result = resolveAutoTopicLabelConfig({ enabled: true, prompt: "  " }, undefined);
    expect(result).not.toBeNull();
    expect(result!.prompt).toContain(DEFAULT_PROMPT_SUBSTRING);
  });

  it("per-DM config takes priority over account config", () => {
    const result = resolveAutoTopicLabelConfig(false, true);
    expect(result).toBeNull();
  });

  it("falls back to account config when direct config is undefined", () => {
    const result = resolveAutoTopicLabelConfig(undefined, {
      enabled: true,
      prompt: "Account prompt",
    });
    expect(result).not.toBeNull();
    expect(result!.prompt).toBe("Account prompt");
  });

  it("per-DM disabled overrides account enabled", () => {
    const result = resolveAutoTopicLabelConfig(false, { enabled: true, prompt: "Account prompt" });
    expect(result).toBeNull();
  });

  it("per-DM custom prompt overrides account prompt", () => {
    const result = resolveAutoTopicLabelConfig(
      { prompt: "DM prompt" },
      { prompt: "Account prompt" },
    );
    expect(result).not.toBeNull();
    expect(result!.prompt).toBe("DM prompt");
  });

  it("object form without enabled field defaults to enabled", () => {
    const result = resolveAutoTopicLabelConfig({ prompt: "Test" }, undefined);
    expect(result).not.toBeNull();
    expect(result!.enabled).toBe(true);
    expect(result!.prompt).toBe("Test");
  });
});
