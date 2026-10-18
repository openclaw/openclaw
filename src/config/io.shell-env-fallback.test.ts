import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { withTempDir } from "../test-utils/temp-dir.js";
import { createConfigIO } from "./io.js";

const shellEnvMocks = vi.hoisted(() => ({
  loadShellEnvFallback: vi.fn(),
  resolveShellEnvFallbackTimeoutMs: vi.fn(() => 15_000),
  shouldDeferShellEnvFallback: vi.fn(() => false),
  shouldEnableShellEnvFallback: vi.fn(() => false),
}));

vi.mock("../infra/shell-env.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/shell-env.js")>()),
  loadShellEnvFallback: shellEnvMocks.loadShellEnvFallback,
  resolveShellEnvFallbackTimeoutMs: shellEnvMocks.resolveShellEnvFallbackTimeoutMs,
  shouldDeferShellEnvFallback: shellEnvMocks.shouldDeferShellEnvFallback,
  shouldEnableShellEnvFallback: shellEnvMocks.shouldEnableShellEnvFallback,
}));

describe("config io shell env fallback", () => {
  it("honors deferred shell env fallback when the config file is missing", async () => {
    await withTempDir("openclaw-shell-env-", async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      shellEnvMocks.shouldEnableShellEnvFallback.mockReturnValue(true);
      const baseOptions = {
        configPath,
        env: {},
        homedir: () => home,
        logger: { error: vi.fn(), warn: vi.fn() },
        observe: false,
      };
      for (const shellEnvFallback of ["defer", undefined] as const) {
        shellEnvMocks.loadShellEnvFallback.mockClear();
        createConfigIO({ ...baseOptions, shellEnvFallback }).loadConfig();
        expect(shellEnvMocks.loadShellEnvFallback).toHaveBeenCalledTimes(
          shellEnvFallback === "defer" ? 0 : 1,
        );
      }
    });
  });
});
