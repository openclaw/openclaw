import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { MsgContext } from "../templating.js";

// Mock dependencies
vi.mock("../../agents/model-catalog.js", () => ({
  loadModelCatalog: vi.fn(),
  findModelInCatalog: vi.fn(),
  modelSupportsVision: vi.fn(),
}));

vi.mock("../../agents/model-selection.js", () => ({
  resolveModelRefFromString: vi.fn(),
}));

vi.mock("../../config/model-input.js", () => ({
  resolveAgentModelPrimaryValue: vi.fn(),
}));

import {
  findModelInCatalog,
  loadModelCatalog,
  modelSupportsVision,
} from "../../agents/model-catalog.js";
import { resolveModelRefFromString } from "../../agents/model-selection.js";
import { resolveAgentModelPrimaryValue } from "../../config/model-input.js";
import { resolveImageModelAutoSwitch } from "./get-reply.js";

describe("resolveImageModelAutoSwitch", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  const baseCtx: MsgContext = {
    MediaPath: undefined,
    MediaPaths: undefined,
  };

  const baseCfg = {} as OpenClawConfig;
  const emptyAliasIndex = { byKey: new Map(), byAlias: new Map() };

  it("returns original provider/model when no images are present", async () => {
    vi.mocked(loadModelCatalog).mockResolvedValue([]);
    vi.mocked(modelSupportsVision).mockReturnValue(false);

    const result = await resolveImageModelAutoSwitch({
      provider: "deepseek",
      model: "deepseek-r1",
      ctx: baseCtx,
      cfg: baseCfg,
      hasResolvedHeartbeatModelOverride: false,
      hasSessionModelOverride: false,
      hasChannelModelOverride: false,
      aliasIndex: emptyAliasIndex,
    });

    expect(result).toEqual({ provider: "deepseek", model: "deepseek-r1" });
  });

  it("returns original provider/model when heartbeat model override is active", async () => {
    const ctxWithImage = { ...baseCtx, MediaPath: "/tmp/image.png" };
    vi.mocked(loadModelCatalog).mockResolvedValue([]);

    const result = await resolveImageModelAutoSwitch({
      provider: "deepseek",
      model: "deepseek-r1",
      ctx: ctxWithImage,
      cfg: baseCfg,
      hasResolvedHeartbeatModelOverride: true,
      hasSessionModelOverride: false,
      hasChannelModelOverride: false,
      aliasIndex: emptyAliasIndex,
    });

    expect(result).toEqual({ provider: "deepseek", model: "deepseek-r1" });
    expect(findModelInCatalog).not.toHaveBeenCalled();
  });

  it("returns original provider/model when session model override is active", async () => {
    const ctxWithImage = { ...baseCtx, MediaPath: "/tmp/image.png" };
    vi.mocked(loadModelCatalog).mockResolvedValue([]);

    const result = await resolveImageModelAutoSwitch({
      provider: "deepseek",
      model: "deepseek-r1",
      ctx: ctxWithImage,
      cfg: baseCfg,
      hasResolvedHeartbeatModelOverride: false,
      hasSessionModelOverride: true,
      hasChannelModelOverride: false,
      aliasIndex: emptyAliasIndex,
    });

    expect(result).toEqual({ provider: "deepseek", model: "deepseek-r1" });
    expect(findModelInCatalog).not.toHaveBeenCalled();
  });

  it("returns original provider/model when channel model override is active", async () => {
    const ctxWithImage = { ...baseCtx, MediaPath: "/tmp/image.png" };
    vi.mocked(loadModelCatalog).mockResolvedValue([]);

    const result = await resolveImageModelAutoSwitch({
      provider: "deepseek",
      model: "deepseek-r1",
      ctx: ctxWithImage,
      cfg: baseCfg,
      hasResolvedHeartbeatModelOverride: false,
      hasSessionModelOverride: false,
      hasChannelModelOverride: true,
      aliasIndex: emptyAliasIndex,
    });

    expect(result).toEqual({ provider: "deepseek", model: "deepseek-r1" });
    expect(findModelInCatalog).not.toHaveBeenCalled();
  });

  it("returns original provider/model when current model supports vision", async () => {
    const ctxWithImage = { ...baseCtx, MediaPath: "/tmp/image.png" };
    const textOnlyModel = { provider: "deepseek", id: "deepseek-r1", input: [] };
    const visionModel = { provider: "anthropic", id: "claude-opus-4-1", input: ["text", "image"] };
    vi.mocked(loadModelCatalog).mockResolvedValue([textOnlyModel, visionModel] as never);
    vi.mocked(findModelInCatalog).mockReturnValue(visionModel as never);
    vi.mocked(modelSupportsVision).mockReturnValue(true);

    const result = await resolveImageModelAutoSwitch({
      provider: "anthropic",
      model: "claude-opus-4-1",
      ctx: ctxWithImage,
      cfg: baseCfg,
      hasResolvedHeartbeatModelOverride: false,
      hasSessionModelOverride: false,
      hasChannelModelOverride: false,
      aliasIndex: emptyAliasIndex,
    });

    expect(result).toEqual({ provider: "anthropic", model: "claude-opus-4-1" });
  });

  it("returns original provider/model when no imageModel.primary is configured", async () => {
    const ctxWithImage = { ...baseCtx, MediaPath: "/tmp/image.png" };
    const textOnlyModel = { provider: "deepseek", id: "deepseek-r1", input: ["text"] };
    vi.mocked(loadModelCatalog).mockResolvedValue([textOnlyModel] as never);
    vi.mocked(findModelInCatalog).mockReturnValue(textOnlyModel as never);
    vi.mocked(modelSupportsVision).mockReturnValue(false);
    vi.mocked(resolveAgentModelPrimaryValue).mockReturnValue(undefined);

    const result = await resolveImageModelAutoSwitch({
      provider: "deepseek",
      model: "deepseek-r1",
      ctx: ctxWithImage,
      cfg: baseCfg,
      hasResolvedHeartbeatModelOverride: false,
      hasSessionModelOverride: false,
      hasChannelModelOverride: false,
      aliasIndex: emptyAliasIndex,
    });

    expect(result).toEqual({ provider: "deepseek", model: "deepseek-r1" });
  });

  it("switches to imageModel.primary when current model doesn't support vision", async () => {
    const ctxWithImage = { ...baseCtx, MediaPath: "/tmp/image.png" };
    const textOnlyModel = { provider: "deepseek", id: "deepseek-r1", input: ["text"] };
    const visionModel = { provider: "anthropic", id: "claude-opus-4-1", input: ["text", "image"] };
    const cfg = {
      agents: {
        defaults: {
          imageModel: { primary: "anthropic/claude-opus-4-1" },
        },
      },
    } as OpenClawConfig;

    vi.mocked(loadModelCatalog).mockResolvedValue([textOnlyModel, visionModel] as never);
    vi.mocked(findModelInCatalog)
      .mockReturnValueOnce(textOnlyModel as never)
      .mockReturnValueOnce(visionModel as never);
    vi.mocked(modelSupportsVision)
      .mockReturnValueOnce(false) // current model doesn't support vision
      .mockReturnValueOnce(true); // imageModel does support vision
    vi.mocked(resolveAgentModelPrimaryValue).mockReturnValue("anthropic/claude-opus-4-1");
    vi.mocked(resolveModelRefFromString).mockReturnValue({
      ref: { provider: "anthropic", model: "claude-opus-4-1" },
    } as never);

    const result = await resolveImageModelAutoSwitch({
      provider: "deepseek",
      model: "deepseek-r1",
      ctx: ctxWithImage,
      cfg,
      hasResolvedHeartbeatModelOverride: false,
      hasSessionModelOverride: false,
      hasChannelModelOverride: false,
      aliasIndex: emptyAliasIndex,
    });

    expect(result).toEqual({ provider: "anthropic", model: "claude-opus-4-1" });
  });

  it("returns original provider/model when imageModel.primary doesn't support vision either", async () => {
    const ctxWithImage = { ...baseCtx, MediaPath: "/tmp/image.png" };
    const textOnlyModel = { provider: "deepseek", id: "deepseek-r1", input: ["text"] };
    const anotherTextOnlyModel = { provider: "openai", id: "gpt-4o-mini", input: ["text"] };
    const cfg = {
      agents: {
        defaults: {
          imageModel: { primary: "openai/gpt-4o-mini" },
        },
      },
    } as OpenClawConfig;

    vi.mocked(loadModelCatalog).mockResolvedValue([textOnlyModel, anotherTextOnlyModel] as never);
    vi.mocked(findModelInCatalog)
      .mockReturnValueOnce(textOnlyModel as never)
      .mockReturnValueOnce(anotherTextOnlyModel as never);
    vi.mocked(modelSupportsVision).mockReturnValue(false);
    vi.mocked(resolveAgentModelPrimaryValue).mockReturnValue("openai/gpt-4o-mini");
    vi.mocked(resolveModelRefFromString).mockReturnValue({
      ref: { provider: "openai", model: "gpt-4o-mini" },
    } as never);

    const result = await resolveImageModelAutoSwitch({
      provider: "deepseek",
      model: "deepseek-r1",
      ctx: ctxWithImage,
      cfg,
      hasResolvedHeartbeatModelOverride: false,
      hasSessionModelOverride: false,
      hasChannelModelOverride: false,
      aliasIndex: emptyAliasIndex,
    });

    expect(result).toEqual({ provider: "deepseek", model: "deepseek-r1" });
  });

  it("detects images from MediaPaths array", async () => {
    const ctxWithImages = { ...baseCtx, MediaPaths: ["/tmp/a.png", "/tmp/b.png"] };
    const textOnlyModel = { provider: "deepseek", id: "deepseek-r1", input: ["text"] };
    const visionModel = { provider: "anthropic", id: "claude-opus-4-1", input: ["text", "image"] };
    const cfg = {
      agents: {
        defaults: {
          imageModel: { primary: "anthropic/claude-opus-4-1" },
        },
      },
    } as OpenClawConfig;

    vi.mocked(loadModelCatalog).mockResolvedValue([textOnlyModel, visionModel] as never);
    vi.mocked(findModelInCatalog)
      .mockReturnValueOnce(textOnlyModel as never)
      .mockReturnValueOnce(visionModel as never);
    vi.mocked(modelSupportsVision).mockReturnValueOnce(false).mockReturnValueOnce(true);
    vi.mocked(resolveAgentModelPrimaryValue).mockReturnValue("anthropic/claude-opus-4-1");
    vi.mocked(resolveModelRefFromString).mockReturnValue({
      ref: { provider: "anthropic", model: "claude-opus-4-1" },
    } as never);

    const result = await resolveImageModelAutoSwitch({
      provider: "deepseek",
      model: "deepseek-r1",
      ctx: ctxWithImages,
      cfg,
      hasResolvedHeartbeatModelOverride: false,
      hasSessionModelOverride: false,
      hasChannelModelOverride: false,
      aliasIndex: emptyAliasIndex,
    });

    expect(result).toEqual({ provider: "anthropic", model: "claude-opus-4-1" });
  });

  it("resolves bare model names using aliasIndex", async () => {
    const ctxWithImage = { ...baseCtx, MediaPath: "/tmp/image.png" };
    const textOnlyModel = { provider: "deepseek", id: "deepseek-r1", input: ["text"] };
    const visionModel = {
      provider: "anthropic",
      id: "claude-opus-4-1",
      name: "Claude Opus",
      input: ["text", "image"],
    };
    const cfg = {
      agents: {
        defaults: {
          imageModel: { primary: "claude-opus" },
          models: {
            "anthropic/claude-opus-4-1": { alias: "claude-opus" },
          },
        },
      },
    } as OpenClawConfig;

    const aliasIndex = {
      byKey: new Map([["anthropic/claude-opus-4-1", ["claude-opus"]]]),
      byAlias: new Map([
        [
          "claude-opus",
          { alias: "claude-opus", ref: { provider: "anthropic", model: "claude-opus-4-1" } },
        ],
      ]),
    };

    vi.mocked(loadModelCatalog).mockResolvedValue([textOnlyModel, visionModel] as never);
    vi.mocked(findModelInCatalog)
      .mockReturnValueOnce(textOnlyModel as never)
      .mockReturnValueOnce(visionModel as never);
    vi.mocked(modelSupportsVision).mockReturnValueOnce(false).mockReturnValueOnce(true);
    vi.mocked(resolveAgentModelPrimaryValue).mockReturnValue("claude-opus");
    vi.mocked(resolveModelRefFromString).mockReturnValue({
      ref: { provider: "anthropic", model: "claude-opus-4-1" },
      alias: "claude-opus",
    } as never);

    const result = await resolveImageModelAutoSwitch({
      provider: "deepseek",
      model: "deepseek-r1",
      ctx: ctxWithImage,
      cfg,
      hasResolvedHeartbeatModelOverride: false,
      hasSessionModelOverride: false,
      hasChannelModelOverride: false,
      aliasIndex,
    });

    expect(result).toEqual({ provider: "anthropic", model: "claude-opus-4-1" });
  });
});
