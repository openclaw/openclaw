// Regression: dns-cli subprocess probes (brew --prefix) must be bounded
// by a timeout so a hung binary cannot block `openclaw dns setup`.
import { describe, expect, it, vi } from "vitest";

const spawnSyncMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async () => {
  const { mockNodeChildProcessSpawnSync } = await import("openclaw/plugin-sdk/test-node-mocks");
  return mockNodeChildProcessSpawnSync(spawnSyncMock, () =>
    vi.importActual<typeof import("node:child_process")>("node:child_process"),
  );
});

import { detectBrewPrefix, PROBE_TIMEOUT_MS } from "./dns-cli.js";

describe("dns-cli probe bounds", () => {
  it("passes a timeout to brew --prefix probe", () => {
    spawnSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "brew" && args?.[0] === "--prefix") {
        return {
          stdout: "/opt/homebrew",
          stderr: "",
          pid: 1,
          output: [],
          status: 0,
          signal: null,
        };
      }
      return {
        stdout: "",
        stderr: "",
        pid: 1,
        output: [],
        status: 0,
        signal: null,
      };
    });

    const prefix = detectBrewPrefix();
    expect(prefix).toBe("/opt/homebrew");

    const calls = spawnSyncMock.mock.calls;
    expect(calls.length).toBeGreaterThan(0);

    const brewCall = calls.find(([cmd, args]) => cmd === "brew" && args?.[0] === "--prefix");
    expect(brewCall).toBeDefined();
    const opts = brewCall?.[2];
    expect(opts?.timeout).toBe(PROBE_TIMEOUT_MS);
    expect(opts?.killSignal).toBe("SIGKILL");
  });
});
