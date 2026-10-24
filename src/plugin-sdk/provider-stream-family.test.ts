import { describe, expect, it } from "vitest";
import * as providerStreamFamily from "./provider-stream-family.js";
import * as providerStream from "./provider-stream.js";

describe("provider-stream-family compatibility exports", () => {
  it("preserves the Moonshot shortcut used by published providers", () => {
    const value = providerStreamFamily.MOONSHOT_THINKING_STREAM_HOOKS;

    expect(value).toHaveProperty("wrapStreamFn");
    expect(value).toBe(providerStream.MOONSHOT_THINKING_STREAM_HOOKS);
  });
});
