import { describe, expect, it } from "vitest";
import { resolveConfigSetMode, type ConfigSetOptions } from "./config-set-input.js";

describe("config set input modes", () => {
  it.each<{ options: ConfigSetOptions; mode: string }>([
    { options: {}, mode: "value" },
    { options: { strictJson: true }, mode: "json" },
    { options: { json: true }, mode: "json" },
    { options: { refProvider: "default" }, mode: "ref_builder" },
    { options: { providerSource: "env" }, mode: "provider_builder" },
    { options: { batchJson: "[]" }, mode: "batch" },
    { options: { batchFile: "" }, mode: "batch" },
  ])("selects $mode for $options", ({ options, mode }) => {
    expect(resolveConfigSetMode(options)).toBe(mode);
  });

  it("rejects ref-builder and provider-builder collisions", () => {
    expect(() => resolveConfigSetMode({ refProvider: "default", providerSource: "env" })).toThrow(
      "config set mode error: choose exactly one mode: ref builder (--ref-provider/--ref-source/--ref-id) or provider builder (--provider-*), not both.",
    );
  });

  it("rejects mixing batch mode with builder flags", () => {
    expect(() => resolveConfigSetMode({ batchJson: "[]", refProvider: "default" })).toThrow(
      "config set mode error: batch mode (--batch-json/--batch-file) cannot be combined with ref builder (--ref-*) or provider builder (--provider-*) flags.",
    );
  });
});
