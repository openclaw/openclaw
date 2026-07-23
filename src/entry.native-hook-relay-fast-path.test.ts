import { describe, expect, it, vi } from "vitest";
import { tryHandleNativeHookRelayFastPath } from "./entry.native-hook-relay-fast-path.js";

describe("native hook relay entry fast path", () => {
  it("parses and dispatches the internal relay without CLI bootstrap", async () => {
    const runRelay = vi.fn(async () => 0);
    const setExitCode = vi.fn();

    await expect(
      tryHandleNativeHookRelayFastPath(
        [
          "node",
          "entry.js",
          "hooks",
          "relay",
          "--provider",
          "codex",
          "--relay-id=relay-1",
          "--state-db",
          "/tmp/openclaw.sqlite",
          "--generation",
          "generation-1",
          "--event",
          "pre_tool_use",
          "--pre-tool-use-unavailable",
          "noop",
          "--timeout",
          "2000",
        ],
        { runRelay, setExitCode },
      ),
    ).resolves.toBe(true);

    expect(runRelay).toHaveBeenCalledWith({
      provider: "codex",
      relayId: "relay-1",
      stateDb: "/tmp/openclaw.sqlite",
      generation: "generation-1",
      event: "pre_tool_use",
      preToolUseUnavailable: "noop",
      timeout: "2000",
    });
    expect(setExitCode).toHaveBeenCalledWith(0);
  });

  it("does not intercept other commands", async () => {
    const runRelay = vi.fn();

    await expect(
      tryHandleNativeHookRelayFastPath(["node", "entry.js", "hooks", "list"], { runRelay }),
    ).resolves.toBe(false);

    expect(runRelay).not.toHaveBeenCalled();
  });

  it("falls back to Commander for malformed relay options", async () => {
    const runRelay = vi.fn();

    await expect(
      tryHandleNativeHookRelayFastPath(
        ["node", "entry.js", "hooks", "relay", "--provider", "--event", "pre_tool_use"],
        { runRelay },
      ),
    ).resolves.toBe(false);

    expect(runRelay).not.toHaveBeenCalled();
  });
});
