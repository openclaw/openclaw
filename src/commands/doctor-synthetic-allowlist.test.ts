import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../agents/model-catalog.js", () => ({
  loadModelCatalog: vi.fn(),
}));
vi.mock("../agents/model-selection.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, buildAllowedModelSet: vi.fn() };
});
vi.mock("../terminal/note.js", () => ({ note: vi.fn() }));

import type { OpenClawConfig } from "../config/config.js";
import { loadModelCatalog } from "../agents/model-catalog.js";
import { buildAllowedModelSet } from "../agents/model-selection.js";
import { note } from "../terminal/note.js";
import { noteSyntheticAllowlistGaps } from "./doctor-synthetic-allowlist.js";

const mockLoadModelCatalog = vi.mocked(loadModelCatalog);
const mockBuildAllowedModelSet = vi.mocked(buildAllowedModelSet);
const mockNote = vi.mocked(note);

function makeCfg(models?: Record<string, unknown>): OpenClawConfig {
  return {
    agents: { defaults: { models: models as OpenClawConfig["agents"]["defaults"]["models"] } },
  } as OpenClawConfig;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("noteSyntheticAllowlistGaps", () => {
  it("skips when no allowlist is configured", async () => {
    await noteSyntheticAllowlistGaps(makeCfg());
    expect(mockLoadModelCatalog).not.toHaveBeenCalled();
    expect(mockNote).not.toHaveBeenCalled();
  });

  it("skips when allowlist is empty", async () => {
    await noteSyntheticAllowlistGaps(makeCfg({}));
    expect(mockNote).not.toHaveBeenCalled();
  });

  it("does not warn when all synthetic models are allowlisted", async () => {
    const catalog = [
      { id: "gpt-5.4", name: "gpt-5.4", provider: "openai-codex" },
      { id: "claude-opus-4-6", name: "Claude Opus 4.6", provider: "anthropic" },
    ];
    mockLoadModelCatalog.mockResolvedValue(catalog);
    mockBuildAllowedModelSet.mockReturnValue({
      allowAny: false,
      allowedCatalog: catalog,
      allowedKeys: new Set(["openai-codex/gpt-5.4", "anthropic/claude-opus-4-6"]),
    });

    await noteSyntheticAllowlistGaps(
      makeCfg({ "openai-codex/gpt-5.4": {}, "anthropic/claude-opus-4-6": {} }),
    );
    expect(mockNote).not.toHaveBeenCalled();
  });

  it("warns about synthetic models missing from allowlist", async () => {
    const catalog = [
      { id: "gpt-5.4", name: "gpt-5.4", provider: "openai-codex" },
      { id: "gpt-5.4", name: "gpt-5.4", provider: "openai" },
      { id: "gpt-5.4-pro", name: "gpt-5.4-pro", provider: "openai" },
      { id: "claude-opus-4-6", name: "Claude Opus 4.6", provider: "anthropic" },
    ];
    mockLoadModelCatalog.mockResolvedValue(catalog);
    mockBuildAllowedModelSet.mockReturnValue({
      allowAny: false,
      allowedCatalog: [catalog[0]!, catalog[3]!],
      allowedKeys: new Set(["openai-codex/gpt-5.4", "anthropic/claude-opus-4-6"]),
    });

    await noteSyntheticAllowlistGaps(
      makeCfg({ "openai-codex/gpt-5.4": {}, "anthropic/claude-opus-4-6": {} }),
    );

    expect(mockNote).toHaveBeenCalledTimes(1);
    const noteText = mockNote.mock.calls[0]![0] as string;
    expect(noteText).toContain("2 synthetic model");
    expect(noteText).toContain("openai/gpt-5.4");
    expect(noteText).toContain("openai/gpt-5.4-pro");
  });

  it("ignores non-synthetic providers", async () => {
    const catalog = [
      { id: "gemini-3-flash", name: "Gemini 3 Flash", provider: "google" },
      { id: "claude-opus-4-6", name: "Claude Opus 4.6", provider: "anthropic" },
    ];
    mockLoadModelCatalog.mockResolvedValue(catalog);
    mockBuildAllowedModelSet.mockReturnValue({
      allowAny: false,
      allowedCatalog: [catalog[1]!],
      allowedKeys: new Set(["anthropic/claude-opus-4-6"]),
    });

    await noteSyntheticAllowlistGaps(makeCfg({ "anthropic/claude-opus-4-6": {} }));
    expect(mockNote).not.toHaveBeenCalled();
  });

  it("handles single synthetic gap with correct grammar", async () => {
    const catalog = [{ id: "gpt-5.4", name: "gpt-5.4", provider: "openai" }];
    mockLoadModelCatalog.mockResolvedValue(catalog);
    mockBuildAllowedModelSet.mockReturnValue({
      allowAny: false,
      allowedCatalog: [],
      allowedKeys: new Set(["anthropic/claude-opus-4-6"]),
    });

    await noteSyntheticAllowlistGaps(makeCfg({ "anthropic/claude-opus-4-6": {} }));
    const noteText = mockNote.mock.calls[0]![0] as string;
    expect(noteText).toContain("1 synthetic model available");
    expect(noteText).not.toContain("models available");
  });
});
