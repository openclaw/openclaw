import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";
import {
  createTokenEfficientToolsWrapper,
  TOKEN_EFFICIENT_TOOLS_BETA,
} from "./token-efficient-tools.js";

function makeAnthropicModel(): Model<Api> {
  return { api: "anthropic-messages", id: "claude-sonnet-4-5" } as Model<Api>;
}

function makeOpenAIModel(): Model<Api> {
  return { api: "openai-chat", id: "gpt-5" } as Model<Api>;
}

describe("createTokenEfficientToolsWrapper", () => {
  it("adds beta header for Anthropic models with tools", () => {
    const innerFn = vi.fn().mockReturnValue({ on: vi.fn() });
    const wrapped = createTokenEfficientToolsWrapper(innerFn as unknown as StreamFn);

    void wrapped(makeAnthropicModel(), { tools: [{ name: "read_file" }] }, {});

    expect(innerFn).toHaveBeenCalledOnce();
    const options = innerFn.mock.calls[0][2];
    expect(options.betas).toContain(TOKEN_EFFICIENT_TOOLS_BETA);
  });

  it("preserves existing betas", () => {
    const innerFn = vi.fn().mockReturnValue({ on: vi.fn() });
    const wrapped = createTokenEfficientToolsWrapper(innerFn as unknown as StreamFn);

    void wrapped(
      makeAnthropicModel(),
      { tools: [{ name: "read_file" }] },
      { betas: ["existing-beta-1"] },
    );

    const options = innerFn.mock.calls[0][2];
    expect(options.betas).toContain("existing-beta-1");
    expect(options.betas).toContain(TOKEN_EFFICIENT_TOOLS_BETA);
  });

  it("skips non-Anthropic models", () => {
    const innerFn = vi.fn().mockReturnValue({ on: vi.fn() });
    const wrapped = createTokenEfficientToolsWrapper(innerFn as unknown as StreamFn);

    void wrapped(makeOpenAIModel(), { tools: [{ name: "read_file" }] }, {});

    const options = innerFn.mock.calls[0][2];
    expect(options.betas).toBeUndefined();
  });

  it("skips when no tools present", () => {
    const innerFn = vi.fn().mockReturnValue({ on: vi.fn() });
    const wrapped = createTokenEfficientToolsWrapper(innerFn as unknown as StreamFn);

    void wrapped(makeAnthropicModel(), { messages: [{ role: "user", content: "hello" }] }, {});

    const options = innerFn.mock.calls[0][2];
    expect(options.betas).toBeUndefined();
  });

  it("skips when tools array is empty", () => {
    const innerFn = vi.fn().mockReturnValue({ on: vi.fn() });
    const wrapped = createTokenEfficientToolsWrapper(innerFn as unknown as StreamFn);

    void wrapped(makeAnthropicModel(), { tools: [] }, {});

    const options = innerFn.mock.calls[0][2];
    expect(options.betas).toBeUndefined();
  });
});
