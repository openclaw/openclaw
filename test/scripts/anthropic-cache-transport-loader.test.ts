import type { StreamFn } from "@openclaw/ai";
import { describe, expect, it, vi } from "vitest";
import {
  type AnthropicStreamFn,
  loadAnthropicProviderInternals,
  loadAnthropicTransportStream,
} from "../../scripts/e2e/lib/anthropic-cache/transport-loader.mts";

describe("loadAnthropicTransportStream", () => {
  it("loads the managed transport when the candidate exports it", async () => {
    const stream = vi.fn<StreamFn>();
    const factory = vi.fn(() => stream);

    await expect(
      loadAnthropicTransportStream(async () => ({
        createAnthropicMessagesTransportStreamFn: factory,
      })),
    ).resolves.toBe(stream);
    expect(factory).toHaveBeenCalledOnce();
  });

  it("returns undefined only for the frozen candidate's missing package export", async () => {
    const error = Object.assign(
      new Error("Package subpath './transports' is not defined by exports in @openclaw/ai"),
      { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" },
    );

    await expect(
      loadAnthropicTransportStream(async () => {
        throw error;
      }),
    ).resolves.toBe(undefined);
  });

  it("does not hide unrelated import failures", async () => {
    const error = Object.assign(new Error("unexpected loader failure"), {
      code: "ERR_MODULE_NOT_FOUND",
    });

    await expect(
      loadAnthropicTransportStream(async () => {
        throw error;
      }),
    ).rejects.toBe(error);
  });
});

describe("loadAnthropicProviderInternals", () => {
  it("uses the candidate prefix-binding capability when exported", async () => {
    const stream = vi.fn<AnthropicStreamFn>();
    const binds = vi.fn(() => true);

    const loaded = await loadAnthropicProviderInternals(async () => ({
      streamAnthropic: stream,
      bindsClaudeThinkingPrefix: binds,
    }));

    expect(loaded.streamAnthropic).toBe(stream);
    expect(loaded.bindsClaudeThinkingPrefix({ id: "claude-fable-5-1" })).toBe(true);
  });

  it("treats a missing prefix-binding export as an absent frozen capability", async () => {
    const stream = vi.fn<AnthropicStreamFn>();
    const loaded = await loadAnthropicProviderInternals(async () => ({ streamAnthropic: stream }));

    expect(loaded.streamAnthropic).toBe(stream);
    expect(loaded.bindsClaudeThinkingPrefix({ id: "claude-sonnet-4-6" })).toBe(false);
  });

  it("rejects candidates missing the provider stream", async () => {
    await expect(
      loadAnthropicProviderInternals(async () => ({ streamAnthropic: undefined as never })),
    ).rejects.toThrow("candidate package does not export streamAnthropic");
  });
});
