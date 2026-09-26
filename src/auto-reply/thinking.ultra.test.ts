import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderThinkingProfile } from "../plugins/provider-thinking.types.js";

const mocks = vi.hoisted(() => ({ profile: vi.fn() }));
vi.mock("../plugins/provider-thinking.js", () => ({
  resolveEffectiveThinkingProfile: mocks.profile,
}));

import {
  listThinkingLevels,
  resolveProviderThinkingLevel,
  resolveThinkingSelectionForModel,
} from "./thinking.js";

beforeEach(() => mocks.profile.mockReset());

describe("model-independent Ultra", () => {
  it.each<{ name: string; profile: ProviderThinkingProfile; expected?: string }>([
    { name: "max", profile: { levels: [{ id: "high" }, { id: "max" }] }, expected: "max" },
    { name: "xhigh", profile: { levels: [{ id: "high" }, { id: "xhigh" }] }, expected: "xhigh" },
    { name: "high", profile: { levels: [{ id: "off" }, { id: "high" }] }, expected: "high" },
    { name: "adaptive", profile: { levels: [{ id: "adaptive" }] }, expected: "adaptive" },
    {
      name: "binary",
      profile: { levels: [{ id: "off" }, { id: "low", label: "on" }] },
      expected: "low",
    },
    { name: "no effort control", profile: { levels: [], defaultLevel: null } },
  ])("keeps Ultra separate from $name provider efforts", ({ profile, expected }) => {
    mocks.profile.mockReturnValue(profile);
    const params = {
      provider: "custom",
      model: "test-model",
      catalog: [{ provider: "custom", id: "test-model", reasoning: true }],
      agentRuntime: "openclaw",
    };
    expect(resolveThinkingSelectionForModel({ ...params, level: "ultra" })).toEqual({
      requestedLevel: "ultra",
      level: "ultra",
      supported: true,
    });
    expect(resolveProviderThinkingLevel({ ...params, level: "ultra" })).toBe(expected);
    expect(resolveThinkingSelectionForModel(params).requestedLevel).not.toBe("ultra");
    expect(listThinkingLevels(params.provider, params.model, params.catalog)).toEqual(
      profile.levels.map(({ id }) => id),
    );
  });

  it("boosts a nonreasoning model without enabling provider reasoning", () => {
    const params = {
      provider: "custom",
      model: "plain-model",
      agentRuntime: "openclaw",
      catalog: [{ provider: "custom", id: "plain-model", reasoning: false }],
    };
    expect(resolveThinkingSelectionForModel({ ...params, level: "ultra" }).level).toBe("ultra");
    expect(resolveProviderThinkingLevel({ ...params, level: "ultra" })).toBe("off");
    expect(resolveThinkingSelectionForModel(params).requestedLevel).toBe("off");
  });

  it("respects native effort opt-outs and provider ranks without falling back to Ultra", () => {
    mocks.profile.mockReturnValue({
      levels: [{ id: "low", rank: 100 }, { id: "high", rank: 40 }, { id: "max" }],
    });
    const params = {
      provider: "custom",
      model: "ranked",
      agentRuntime: "openclaw",
      catalog: [{ provider: "custom", id: "ranked", thinkingLevelMap: { max: null } }],
    };
    expect(resolveProviderThinkingLevel({ ...params, level: "ultra" })).toBe("low");
    expect(resolveThinkingSelectionForModel({ ...params, level: "max" }).level).toBe("high");
  });

  it.each([
    { name: "nonreasoning", reasoning: false, profile: undefined },
    { name: "empty", reasoning: true, profile: { levels: [] } },
    { name: "off-only", reasoning: true, profile: { levels: [{ id: "off" }] } },
  ])("does not synthesize native Codex Ultra for a $name model", ({ reasoning, profile }) => {
    mocks.profile.mockReturnValue(profile);
    const catalog = [{ provider: "custom", id: "plain-model", reasoning }];
    expect(listThinkingLevels("custom", "plain-model", catalog, "codex")).not.toContain("ultra");
    expect(listThinkingLevels("custom", "plain-model", catalog, "openclaw")).toContain("ultra");
  });

  it("preserves an explicitly advertised native Codex Ultra choice", () => {
    mocks.profile.mockReturnValue({ levels: [{ id: "ultra" }] });
    expect(listThinkingLevels("custom", "native-ultra", undefined, "codex")).toEqual(["ultra"]);
  });

  it.each(["codex", "claude-cli"])("preserves logical Ultra for the %s harness", (agentRuntime) => {
    const params = { provider: "custom", model: "plain-model", agentRuntime };
    expect(resolveThinkingSelectionForModel({ ...params, level: "ultra" }).level).toBe("ultra");
    expect(listThinkingLevels("custom", "plain-model", undefined, "unknown-runtime")).not.toContain(
      "ultra",
    );
  });
});
