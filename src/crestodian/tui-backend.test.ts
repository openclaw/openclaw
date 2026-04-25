import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";

const mocks = vi.hoisted(() => ({
  runTui: vi.fn(async (_opts: unknown) => ({ exitReason: "exit" as const })),
}));

vi.mock("../tui/tui.js", () => ({
  runTui: mocks.runTui,
}));

import { runCrestodianTui } from "./tui-backend.js";

function createRuntime(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: (code) => {
      throw new Error(`exit ${code}`);
    },
  };
}

describe("runCrestodianTui", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    mocks.runTui.mockClear();
  });

  it("runs Crestodian inside the shared TUI shell", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "crestodian-tui-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", tempDir);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(tempDir, "openclaw.json"));

    await runCrestodianTui({}, createRuntime());

    expect(mocks.runTui).toHaveBeenCalledWith(
      expect.objectContaining({
        local: true,
        session: "agent:crestodian:main",
        historyLimit: 200,
        config: {},
        title: "openclaw crestodian",
      }),
    );
    const callOptions = mocks.runTui.mock.calls[0]?.[0] as { backend?: unknown } | undefined;
    expect(callOptions?.backend).toBeTruthy();
  });
});
