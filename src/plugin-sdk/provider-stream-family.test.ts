import { describe, expect, it, vi } from "vitest";

const { loadTransportRuntime } = vi.hoisted(() => ({ loadTransportRuntime: vi.fn() }));

// mock-isolation: Registration must not initialize the process-wide transport runtime.
vi.mock("../agents/openai-transport-stream.js", () => {
  loadTransportRuntime();
  return { createOpenAIResponsesTransportStreamFn: vi.fn() };
});

import * as providerStreamFamily from "./provider-stream-family.js";
import * as providerStream from "./provider-stream.js";

describe("provider-stream-family compatibility exports", () => {
  it("registers provider stream families without loading transport runtime", () => {
    expect(loadTransportRuntime).not.toHaveBeenCalled();
  });

  it("preserves the Moonshot shortcut used by published providers", () => {
    const value = providerStreamFamily.MOONSHOT_THINKING_STREAM_HOOKS;

    expect(value).toHaveProperty("wrapStreamFn");
    expect(value).toBe(providerStream.MOONSHOT_THINKING_STREAM_HOOKS);
  });
});
