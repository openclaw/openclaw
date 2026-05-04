import { describe, expect, it } from "vitest";
import { formatCheckConfigResults, type CheckConfigResult } from "./doctor-check-config.js";

describe("formatCheckConfigResults", () => {
  it("formats ok results with checkmark", () => {
    const results: CheckConfigResult[] = [
      { category: "schema", label: "Config schema", status: "ok" },
    ];
    const lines = formatCheckConfigResults(results);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("\u2705");
    expect(lines[0]).toContain("Config schema");
  });

  it("formats fail results with cross mark", () => {
    const results: CheckConfigResult[] = [
      {
        category: "model",
        label: "Primary model",
        status: "fail",
        message: "could not resolve",
      },
    ];
    const lines = formatCheckConfigResults(results);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("\u274C");
    expect(lines[0]).toContain("Primary model");
    expect(lines[0]).toContain("could not resolve");
  });

  it("formats warn results with warning sign", () => {
    const results: CheckConfigResult[] = [
      {
        category: "tts",
        label: "TTS provider",
        status: "warn",
        message: 'will fall back to "edge"',
      },
    ];
    const lines = formatCheckConfigResults(results);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("\u26A0");
    expect(lines[0]).toContain("TTS provider");
    expect(lines[0]).toContain("fall back");
  });

  it("formats results without message", () => {
    const results: CheckConfigResult[] = [
      { category: "schema", label: "Config schema", status: "ok" },
    ];
    const lines = formatCheckConfigResults(results);
    expect(lines[0]).not.toContain("\u2014");
  });

  it("formats multiple results including fallback validation", () => {
    const results: CheckConfigResult[] = [
      { category: "schema", label: "Config schema", status: "ok" },
      {
        category: "model",
        label: "Primary model",
        status: "ok",
        message: "anthropic/claude-opus-4-6",
      },
      {
        category: "model",
        label: "Model fallbacks",
        status: "ok",
        message: "2 fallbacks validated",
      },
      { category: "tts", label: "TTS", status: "ok", message: "disabled" },
      { category: "channels", label: "Channel: telegram", status: "ok", message: "enabled" },
    ];
    const lines = formatCheckConfigResults(results);
    expect(lines).toHaveLength(5);
    expect(lines.every((line) => line.includes("\u2705"))).toBe(true);
  });

  it("formats fallback validation failure", () => {
    const results: CheckConfigResult[] = [
      {
        category: "model",
        label: "Model fallbacks",
        status: "fail",
        message: 'agents.defaults.model.fallbacks: could not parse fallback "kimi-coding/k2p5"',
      },
    ];
    const lines = formatCheckConfigResults(results);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("\u274C");
    expect(lines[0]).toContain("Model fallbacks");
    expect(lines[0]).toContain("kimi-coding/k2p5");
  });

  it("returns empty array for empty results", () => {
    const lines = formatCheckConfigResults([]);
    expect(lines).toEqual([]);
  });
});
