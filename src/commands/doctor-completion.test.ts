import { spawnSync } from "node:child_process";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const completionCacheExistsMock = vi.hoisted(() => vi.fn());
const installCompletionMock = vi.hoisted(() => vi.fn());
const isCompletionInstalledMock = vi.hoisted(() => vi.fn());
const resolveCompletionCachePathMock = vi.hoisted(() => vi.fn());
const resolveShellFromEnvMock = vi.hoisted(() => vi.fn());
const resolveOpenClawPackageRootMock = vi.hoisted(() => vi.fn());
const spawnSyncMock = vi.hoisted(() => vi.fn());
const usesSlowDynamicCompletionMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  spawnSync: spawnSyncMock,
}));

vi.mock("../cli/cli-name.js", () => ({
  resolveCliName: () => "openclaw",
}));

vi.mock("../cli/completion-runtime.js", () => ({
  COMPLETION_SKIP_PLUGIN_COMMANDS_ENV: "OPENCLAW_COMPLETION_SKIP_PLUGIN_COMMANDS",
  completionCacheExists: completionCacheExistsMock,
  installCompletion: installCompletionMock,
  isCompletionInstalled: isCompletionInstalledMock,
  resolveCompletionCachePath: resolveCompletionCachePathMock,
  resolveShellFromEnv: resolveShellFromEnvMock,
  usesSlowDynamicCompletion: usesSlowDynamicCompletionMock,
}));

vi.mock("../infra/openclaw-root.js", () => ({
  resolveOpenClawPackageRoot: resolveOpenClawPackageRootMock,
}));

vi.mock("../terminal/note.js", () => ({
  note: vi.fn(),
}));

describe("doctor completion cache generation", () => {
  const packageRoot = "/tmp/openclaw-package-root";

  beforeEach(() => {
    completionCacheExistsMock.mockReset();
    installCompletionMock.mockReset();
    isCompletionInstalledMock.mockReset();
    resolveCompletionCachePathMock.mockReset();
    resolveOpenClawPackageRootMock.mockReset();
    resolveShellFromEnvMock.mockReset();
    spawnSyncMock.mockReset();
    usesSlowDynamicCompletionMock.mockReset();

    completionCacheExistsMock.mockResolvedValue(false);
    isCompletionInstalledMock.mockResolvedValue(false);
    resolveCompletionCachePathMock.mockReturnValue("/tmp/openclaw-state/completions/openclaw.zsh");
    resolveOpenClawPackageRootMock.mockResolvedValue(packageRoot);
    resolveShellFromEnvMock.mockReturnValue("zsh");
    spawnSyncMock.mockReturnValue({ status: 0 });
    usesSlowDynamicCompletionMock.mockResolvedValue(false);
  });

  it("writes missing completion caches without eager plugin command registration", async () => {
    const { ensureCompletionCacheExists } = await import("./doctor-completion.js");

    await expect(ensureCompletionCacheExists()).resolves.toBe(true);

    expect(spawnSync).toHaveBeenCalledWith(
      process.execPath,
      [path.join(packageRoot, "openclaw.mjs"), "completion", "--write-state"],
      expect.objectContaining({
        cwd: packageRoot,
        encoding: "utf-8",
        env: expect.objectContaining({
          OPENCLAW_COMPLETION_SKIP_PLUGIN_COMMANDS: "1",
        }),
        timeout: 30_000,
      }),
    );
  });

  it("does not spawn completion cache generation when the cache already exists", async () => {
    completionCacheExistsMock.mockResolvedValue(true);
    const { ensureCompletionCacheExists } = await import("./doctor-completion.js");

    await expect(ensureCompletionCacheExists()).resolves.toBe(true);

    expect(spawnSync).not.toHaveBeenCalled();
  });
});
