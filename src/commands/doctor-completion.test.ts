import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  completionCacheExists: vi.fn(async () => false),
  resolveOpenClawPackageRoot: vi.fn(async () => "/tmp/openclaw"),
  resolveShellFromEnv: vi.fn(() => "zsh"),
  spawnSync: vi.fn(() => ({
    pid: 0,
    output: [],
    stdout: "",
    stderr: "",
    status: 0,
    signal: null,
  })),
}));

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    spawnSync: mocks.spawnSync,
  };
});

vi.mock("../infra/openclaw-root.js", () => ({
  resolveOpenClawPackageRoot: mocks.resolveOpenClawPackageRoot,
}));

vi.mock("../cli/completion-runtime.js", () => ({
  completionCacheExists: mocks.completionCacheExists,
  installCompletion: vi.fn(),
  isCompletionInstalled: vi.fn(),
  resolveCompletionCachePath: vi.fn(() => "/tmp/openclaw-completion.zsh"),
  resolveShellFromEnv: mocks.resolveShellFromEnv,
  usesSlowDynamicCompletion: vi.fn(),
}));

vi.mock("../terminal/note.js", () => ({
  note: vi.fn(),
}));

const { ensureCompletionCacheExists } = await import("./doctor-completion.js");

describe("doctor completion cache", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.completionCacheExists.mockResolvedValue(false);
    mocks.resolveOpenClawPackageRoot.mockResolvedValue("/tmp/openclaw");
    mocks.resolveShellFromEnv.mockReturnValue("zsh");
    mocks.spawnSync.mockReturnValue({
      pid: 0,
      output: [],
      stdout: "",
      stderr: "",
      status: 0,
      signal: null,
    });
  });

  it("allows slower completion cache generation during doctor repair", async () => {
    await expect(ensureCompletionCacheExists("openclaw")).resolves.toBe(true);

    expect(mocks.spawnSync).toHaveBeenCalledWith(
      expect.any(String),
      [path.join("/tmp/openclaw", "openclaw.mjs"), "completion", "--write-state"],
      expect.objectContaining({
        timeout: 120_000,
      }),
    );
  });
});
