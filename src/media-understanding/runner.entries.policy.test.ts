// Runner entry policy tests cover resolveImageCompressionPolicyFromConfig merge
// precedence between agents.defaults, configured model metadata, and the shared
// model-aware compression resolver. The shared resolver is mocked so the merge
// contract is proved without coupling to shipped catalog contents.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ImageCompressionModelPolicy } from "../media/web-media.js";
import type { OpenClawConfig } from "../config/types.js";

const { resolveCompressionModelPolicyMock } = vi.hoisted(() => ({
  resolveCompressionModelPolicyMock: vi.fn<() => Promise<ImageCompressionModelPolicy>>(),
}));

vi.mock("../agents/tools/image-tool.js", () => ({
  resolveCompressionModelPolicy: resolveCompressionModelPolicyMock,
}));

import { resolveImageCompressionPolicyFromConfig } from "./runner.entries.js";

function makeCfg(overrides: unknown): OpenClawConfig {
  return overrides as OpenClawConfig;
}

beforeEach(() => {
  resolveCompressionModelPolicyMock.mockReset();
  resolveCompressionModelPolicyMock.mockResolvedValue({});
});

describe("media-understanding resolveImageCompressionPolicyFromConfig", () => {
  it("returns quality-only policy without imageMaxDimensionPx or provider/model", async () => {
    const cfg = makeCfg({ agents: { defaults: { imageQuality: "high" } } });
    await expect(resolveImageCompressionPolicyFromConfig(cfg)).resolves.toEqual({ quality: "high" });
  });

  it("emits agents.defaults.imageMaxDimensionPx as a preferredSidePx entry", async () => {
    const cfg = makeCfg({
      agents: { defaults: { imageQuality: "balanced", imageMaxDimensionPx: 1024 } },
    });
    await expect(resolveImageCompressionPolicyFromConfig(cfg)).resolves.toEqual({
      quality: "balanced",
      models: [{ preferredSidePx: 1024 }],
    });
  });

  it("skips model merge when only provider is given (no model id)", async () => {
    const cfg = makeCfg({});
    await expect(
      resolveImageCompressionPolicyFromConfig(cfg, { provider: "anthropic" }),
    ).resolves.toEqual({});
  });

  it("skips model merge when only model is given (no provider)", async () => {
    const cfg = makeCfg({});
    await expect(
      resolveImageCompressionPolicyFromConfig(cfg, { model: "claude-sonnet-5" }),
    ).resolves.toEqual({});
  });

  it("includes shared resolver policy when provider+model are given", async () => {
    resolveCompressionModelPolicyMock.mockResolvedValue({
      maxSidePx: 4096,
      maxBytes: 5_000_000,
    });
    const cfg = makeCfg({
      agents: { defaults: { imageQuality: "balanced" } },
    });
    const policy = await resolveImageCompressionPolicyFromConfig(cfg, {
      provider: "my-vendor",
      model: "vision-9000",
    });
    expect(policy.models).toContainEqual({ maxSidePx: 4096, maxBytes: 5_000_000 });
  });

  it("merges defaults preferredSidePx with shared resolver model policy", async () => {
    resolveCompressionModelPolicyMock.mockResolvedValue({
      maxSidePx: 2576,
      preferredSidePx: 2576,
      maxPixels: 1_000_000,
      maxBytes: 8_000_000,
    });
    const cfg = makeCfg({
      agents: { defaults: { imageQuality: "balanced", imageMaxDimensionPx: 1024 } },
    });
    const policy = await resolveImageCompressionPolicyFromConfig(cfg, {
      provider: "anthropic",
      model: "claude-sonnet-5",
    });
    // Two model entries: [defaults preferredSidePx] then shared resolver policy.
    expect(policy.models).toEqual([
      { preferredSidePx: 1024 },
      {
        maxSidePx: 2576,
        preferredSidePx: 2576,
        maxPixels: 1_000_000,
        maxBytes: 8_000_000,
      },
    ]);
  });

  it("skips empty shared resolver policy", async () => {
    resolveCompressionModelPolicyMock.mockResolvedValue({});
    const cfg = makeCfg({
      agents: { defaults: { imageQuality: "balanced" } },
    });
    const policy = await resolveImageCompressionPolicyFromConfig(cfg, {
      provider: "anthropic",
      model: "claude-sonnet-5",
    });
    expect(policy).toEqual({ quality: "balanced" });
  });
});
