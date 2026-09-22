import fs, {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os, { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileLockOptions } from "../../infra/file-lock.js";
import { snapshotFiles } from "../../infra/state-migrations.caller-mode.test-helpers.js";
import { deleteTestEnvValue, setTestEnvValue } from "../../test-utils/env.js";

const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());
const spawnSyncMock = vi.hoisted(() => vi.fn());
const extractArchiveMock = vi.hoisted(() => vi.fn());
const withFileLockMock = vi.hoisted(() =>
  vi.fn(async (_path: string, _options: FileLockOptions, fn: () => Promise<unknown>) => fn()),
);

vi.mock("../../infra/net/fetch-guard.js", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawnSync: spawnSyncMock,
}));

vi.mock("../../infra/archive.js", () => ({
  extractArchive: extractArchiveMock,
}));

vi.mock("../../infra/file-lock.js", () => ({
  withFileLock: withFileLockMock,
}));

let originalAgentDir: string | undefined;
let tempAgentDir: string | undefined;

beforeEach(() => {
  originalAgentDir = process.env.OPENCLAW_AGENT_DIR;
  tempAgentDir = mkdtempSync(join(tmpdir(), "openclaw-tools-manager-"));
  setTestEnvValue("OPENCLAW_AGENT_DIR", tempAgentDir);
  fetchWithSsrFGuardMock.mockReset();
  extractArchiveMock.mockReset();
  withFileLockMock
    .mockReset()
    .mockImplementation(
      async (_path: string, _options: FileLockOptions, fn: () => Promise<unknown>) => fn(),
    );
  spawnSyncMock.mockReturnValue({
    error: new Error("ENOENT"),
    status: null,
    stderr: Buffer.alloc(0),
    stdout: Buffer.alloc(0),
  });
});

afterEach(() => {
  vi.doUnmock("node:os");
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.resetModules();
  vi.unstubAllEnvs();
  if (originalAgentDir === undefined) {
    deleteTestEnvValue("OPENCLAW_AGENT_DIR");
  } else {
    setTestEnvValue("OPENCLAW_AGENT_DIR", originalAgentDir);
  }
  if (tempAgentDir) {
    rmSync(tempAgentDir, { recursive: true, force: true });
  }
  tempAgentDir = undefined;
});

describe("ensureTool", () => {
  it.each(["fd", "rg", "shell"] as const)(
    "keeps %s usable without an ambient agent owner",
    async (tool) => {
      const home = expectDefined(tempAgentDir, "test home");
      const configPath = join(home, "openclaw.json");
      vi.spyOn(os, "homedir").mockReturnValue(home);
      vi.stubEnv("HOME", home);
      vi.stubEnv("USERPROFILE", home);
      vi.stubEnv("OPENCLAW_HOME", home);
      vi.stubEnv("OPENCLAW_STATE_DIR", home);
      vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
      vi.stubEnv("OPENCLAW_AGENT_DIR", "");
      writeFileSync(
        configPath,
        JSON.stringify({ agents: { ownership: "explicit", entries: { alpha: {}, beta: {} } } }),
      );
      const before = snapshotFiles(home);
      const { getAgentDir } = await import("../config.js");
      expect(() => getAgentDir()).toThrow("Select an agent owner");

      if (tool === "shell") {
        const { getBashShellEnv } = await import("../shell-utils.js");
        const sourceEnv = { PATH: join(home, "system-bin"), EXAMPLE: "preserved" };
        expect(getBashShellEnv(undefined, sourceEnv)).toEqual(sourceEnv);
      } else {
        const { ensureTool } = await import("./tools-manager.js");
        spawnSyncMock.mockReturnValue({ status: 0 });
        await expect(ensureTool(tool, true)).resolves.toBe(tool);
        spawnSyncMock.mockReturnValue({ status: 1 });
        await expect(ensureTool(tool, true)).resolves.toBeUndefined();
        expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
      }
      expect(snapshotFiles(home)).toEqual(before);
    },
  );

  it.each(
    [
      { name: "legacy only", legacy: "payload", canonical: "missing", selected: "legacy" },
      { name: "migrated", legacy: "missing", canonical: "payload", selected: "canonical" },
      { name: "both present", legacy: "payload", canonical: "payload", selected: "legacy" },
      { name: "empty canonical", legacy: "payload", canonical: "empty", selected: "legacy" },
      {
        name: "completed migration",
        legacy: "payload",
        canonical: "payload",
        receipt: "valid",
        selected: "canonical",
      },
      {
        name: "incomplete receipt",
        legacy: "payload",
        canonical: "empty",
        receipt: "partial",
        selected: "legacy",
      },
      {
        name: "another source's receipt",
        legacy: "payload",
        canonical: "payload",
        receipt: "other-source",
        selected: "legacy",
      },
      {
        name: "another target's receipt",
        legacy: "payload",
        canonical: "payload",
        receipt: "other-target",
        selected: "legacy",
      },
      { name: "empty legacy", legacy: "empty", canonical: "missing", selected: "canonical" },
      { name: "missing legacy", legacy: "missing", canonical: "missing", selected: "canonical" },
    ].flatMap((testCase) =>
      ["none", "OPENCLAW_STATE_DIR", "OPENCLAW_HOME"].map((override) => ({
        testCase,
        override,
      })),
    ),
  )(
    "reuses managed binaries across agent directory migration: $testCase.name ($override)",
    async ({ testCase, override }) => {
      const home = expectDefined(tempAgentDir, "test home");
      vi.spyOn(os, "homedir").mockReturnValue(home);
      const overrideHome = join(home, "override-home");
      const stateDir =
        override === "OPENCLAW_STATE_DIR"
          ? join(home, "state")
          : join(override === "OPENCLAW_HOME" ? overrideHome : home, ".openclaw");
      vi.stubEnv("HOME", home);
      vi.stubEnv("USERPROFILE", home);
      vi.stubEnv("OPENCLAW_HOME", override === "OPENCLAW_HOME" ? overrideHome : "");
      vi.stubEnv("OPENCLAW_STATE_DIR", override === "OPENCLAW_STATE_DIR" ? stateDir : "");
      vi.stubEnv("OPENCLAW_AGENT_DIR", "");
      vi.stubEnv("OPENCLAW_OFFLINE", "1");
      const canonicalDir = join(stateDir, "agents", "main", "agent");
      const legacyDir = join(home, ".openclaw", "agent");
      const binaryName = process.platform === "win32" ? "fd.exe" : "fd";
      for (const { directory, contents } of [
        { directory: legacyDir, contents: testCase.legacy },
        { directory: canonicalDir, contents: testCase.canonical },
      ]) {
        if (contents === "payload") {
          const binaryPath = join(directory, "bin", binaryName);
          mkdirSync(dirname(binaryPath), { recursive: true });
          writeFileSync(binaryPath, "managed binary");
        } else if (contents === "empty") {
          mkdirSync(directory, { recursive: true });
        }
      }

      if (testCase.receipt) {
        writeFileSync(
          join(canonicalDir, ".legacy-agent-dir-migration.json"),
          testCase.receipt === "partial"
            ? '{"version":1'
            : JSON.stringify({
                version: 1,
                source:
                  testCase.receipt === "other-source"
                    ? join(home, "other-agent")
                    : realpathSync(legacyDir),
                target:
                  testCase.receipt === "other-target"
                    ? join(home, "other-target")
                    : realpathSync(canonicalDir),
              }) + "\n",
        );
      }

      const { getAgentDir } = await import("../config.js");
      const { resolveAgentDir } = await import("../agent-scope-config.js");
      const { ensureTool } = await import("./tools-manager.js");
      const selectedDir = testCase.selected === "legacy" ? legacyDir : canonicalDir;
      const selectedContents =
        testCase.selected === "legacy" ? testCase.legacy : testCase.canonical;

      await expect(ensureTool("fd", true)).resolves.toBe(
        selectedContents === "payload" ? join(selectedDir, "bin", binaryName) : undefined,
      );
      expect(getAgentDir()).toBe(selectedDir);
      expect(resolveAgentDir({}, "main")).toBe(canonicalDir);
      expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
      expect(existsSync(legacyDir)).toBe(testCase.legacy !== "missing");
    },
  );

  it.each(["malformed", "invalid", "missing", "unreadable"])(
    "keeps installed tools available with %s config and follows repaired configuration",
    async (condition) => {
      const root = expectDefined(tempAgentDir, "test root");
      const configPath = join(root, "openclaw.json");
      const firstDir = join(root, "first-agent");
      const secondDir = join(root, "second-agent");
      const defaultDir = join(root, "agents/main/agent");
      vi.spyOn(os, "homedir").mockReturnValue(root);
      vi.stubEnv("HOME", root);
      vi.stubEnv("OPENCLAW_HOME", root);
      vi.stubEnv("OPENCLAW_STATE_DIR", root);
      vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
      vi.stubEnv("OPENCLAW_AGENT_DIR", firstDir);
      vi.stubEnv("OPENCLAW_OFFLINE", "1");
      if (condition === "unreadable") {
        mkdirSync(configPath);
      } else if (condition !== "missing") {
        writeFileSync(
          configPath,
          condition === "malformed" ? "{broken config" : '{"gateway":{"port":false}}',
        );
      }
      const binary = process.platform === "win32" ? "fd.exe" : "fd";
      for (const agentDir of [defaultDir, firstDir, secondDir]) {
        mkdirSync(join(agentDir, "bin"), { recursive: true });
        writeFileSync(join(agentDir, "bin", binary), "managed binary");
      }
      const { ensureTool } = await import("./tools-manager.js");
      const { getAgentDir } = await import("../config.js");
      const read = vi.spyOn(fs, "readFileSync");
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const before = snapshotFiles(root);
      read.mockClear();
      expect(getAgentDir()).toBe(firstDir);
      await expect(ensureTool("fd", true)).resolves.toBe(join(firstDir, "bin", binary));
      expect(read.mock.calls.some(([file]) => file === configPath)).toBe(false);
      expect(warn).not.toHaveBeenCalled();

      vi.stubEnv("OPENCLAW_AGENT_DIR", "");
      const beforeEnv = { ...process.env };
      expect(getAgentDir()).toBe(defaultDir);
      await expect(ensureTool("fd", true)).resolves.toBe(join(defaultDir, "bin", binary));
      expect(getAgentDir()).toBe(defaultDir);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("default agent directory"));
      expect(process.env).toEqual(beforeEnv);
      expect(snapshotFiles(root)).toEqual(before);

      if (condition === "unreadable") {
        rmSync(configPath, { recursive: true });
      }
      for (const agentDir of [firstDir, secondDir]) {
        writeFileSync(configPath, JSON.stringify({ agents: { entries: { main: { agentDir } } } }));
        await expect(ensureTool("fd", true)).resolves.toBe(join(agentDir, "bin", binary));
      }
    },
  );

  it("single-flights concurrent installs of the same tool", async () => {
    const { ensureTool } = await import("./tools-manager.js");
    const releaseCheckRelease = vi.fn(async () => {});
    const downloadRelease = vi.fn(async () => {});
    let resolveReleaseCheck!: (value: {
      response: Response;
      release: typeof releaseCheckRelease;
      finalUrl: string;
    }) => void;
    const releaseCheck = new Promise<Parameters<typeof resolveReleaseCheck>[0]>((resolve) => {
      resolveReleaseCheck = resolve;
    });
    extractArchiveMock.mockImplementation(async (params: { destDir: string }) => {
      writeFileSync(join(params.destDir, "fd"), "binary");
    });
    fetchWithSsrFGuardMock.mockReturnValueOnce(releaseCheck).mockResolvedValueOnce({
      response: new Response("archive-bytes", { status: 200 }),
      release: downloadRelease,
      finalUrl: "https://github.com/sharkdp/fd/releases/download/v10.3.0/archive.tar.gz",
    });
    withFileLockMock.mockImplementationOnce(
      async (lockPath: string, _options: FileLockOptions, fn: () => Promise<unknown>) => {
        expect(existsSync(dirname(lockPath))).toBe(true);
        return fn();
      },
    );

    const installs = [ensureTool("fd", true), ensureTool("fd", true)];

    expect(fetchWithSsrFGuardMock).toHaveBeenCalledOnce();
    resolveReleaseCheck({
      response: new Response(JSON.stringify({ tag_name: "v10.3.0" }), { status: 200 }),
      release: releaseCheckRelease,
      finalUrl: "https://api.github.com/repos/sharkdp/fd/releases/latest",
    });
    await expect(Promise.all(installs)).resolves.toEqual([
      join(tempAgentDir!, "bin", "fd"),
      join(tempAgentDir!, "bin", "fd"),
    ]);
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledTimes(2);
    expect(extractArchiveMock).toHaveBeenCalledOnce();
    expect(withFileLockMock).toHaveBeenCalledOnce();
    const lockOptions = withFileLockMock.mock.calls[0]?.[1];
    if (!lockOptions) {
      throw new Error("expected tool installation lock options");
    }
    const minimumLockWaitMs = Array.from({ length: lockOptions.retries.retries }, (_, attempt) =>
      Math.min(
        lockOptions.retries.maxTimeout,
        Math.max(
          lockOptions.retries.minTimeout,
          lockOptions.retries.minTimeout * lockOptions.retries.factor ** attempt,
        ),
      ),
    ).reduce((total, delay) => total + delay, 0);
    expect(minimumLockWaitMs).toBeGreaterThan(lockOptions.stale);
  });

  it("reuses an installation published while waiting for the file lock", async () => {
    const binaryPath = join(tempAgentDir!, "bin", "fd");
    withFileLockMock.mockImplementationOnce(
      async (_path: string, _options: FileLockOptions, fn: () => Promise<unknown>) => {
        mkdirSync(join(tempAgentDir!, "bin"), { recursive: true });
        writeFileSync(binaryPath, "binary");
        return fn();
      },
    );
    const { ensureTool } = await import("./tools-manager.js");

    await expect(ensureTool("fd", true)).resolves.toBe(binaryPath);

    expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
  });

  it("treats trimmed on as the canonical offline opt-in", async () => {
    vi.stubEnv("OPENCLAW_OFFLINE", " ON ");
    const { ensureTool } = await import("./tools-manager.js");

    await expect(ensureTool("fd", true)).resolves.toBeUndefined();
    expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
  });

  it("cancels release-check error bodies before releasing guarded fetches", async () => {
    const { ensureTool } = await import("./tools-manager.js");
    const release = vi.fn(async () => {});
    const response = new Response("server error", { status: 503 });
    const cancel = vi.spyOn(response.body!, "cancel").mockResolvedValue(undefined);
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response,
      release,
      finalUrl: "https://api.github.com/repos/sharkdp/fd/releases/latest",
    });

    await expect(ensureTool("fd", true)).resolves.toBeUndefined();

    expect(cancel).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  it("cancels download error bodies before releasing guarded fetches", async () => {
    const { ensureTool } = await import("./tools-manager.js");
    const releaseCheckRelease = vi.fn(async () => {});
    const downloadRelease = vi.fn(async () => {});
    const downloadResponse = new Response("missing asset", { status: 404 });
    const cancel = vi.spyOn(downloadResponse.body!, "cancel").mockResolvedValue(undefined);
    fetchWithSsrFGuardMock
      .mockResolvedValueOnce({
        response: new Response(JSON.stringify({ tag_name: "14.1.1" }), { status: 200 }),
        release: releaseCheckRelease,
        finalUrl: "https://api.github.com/repos/BurntSushi/ripgrep/releases/latest",
      })
      .mockResolvedValueOnce({
        response: downloadResponse,
        release: downloadRelease,
        finalUrl: "https://github.com/BurntSushi/ripgrep/releases/download/14.1.1/archive",
      });

    await expect(ensureTool("rg", true)).resolves.toBeUndefined();

    expect(cancel).toHaveBeenCalledOnce();
    expect(releaseCheckRelease).toHaveBeenCalledOnce();
    expect(downloadRelease).toHaveBeenCalledOnce();
  });

  it("extracts Windows zip downloads via safe archive API with size limits", async () => {
    vi.doMock("node:os", async (importOriginal) => ({
      ...(await importOriginal<typeof import("node:os")>()),
      arch: () => "x64",
      platform: () => "win32",
    }));

    const { ensureTool } = await import("./tools-manager.js");
    const releaseCheckRelease = vi.fn(async () => {});
    const downloadRelease = vi.fn(async () => {});
    extractArchiveMock.mockImplementation(async (params: { destDir: string }) => {
      writeFileSync(join(params.destDir, "rg.exe"), "binary");
    });
    fetchWithSsrFGuardMock
      .mockResolvedValueOnce({
        response: new Response(JSON.stringify({ tag_name: "14.1.1" }), { status: 200 }),
        release: releaseCheckRelease,
        finalUrl: "https://api.github.com/repos/BurntSushi/ripgrep/releases/latest",
      })
      .mockResolvedValueOnce({
        response: new Response("zip-bytes", { status: 200 }),
        release: downloadRelease,
        finalUrl: "https://github.com/BurntSushi/ripgrep/releases/download/14.1.1/archive.zip",
      });

    await expect(ensureTool("rg", true)).resolves.toBe(join(tempAgentDir!, "bin", "rg.exe"));

    expect(extractArchiveMock).toHaveBeenCalledOnce();
    expect(extractArchiveMock).toHaveBeenCalledWith(
      expect.objectContaining({
        archivePath: expect.stringContaining(".zip"),
        destDir: expect.stringMatching(/install_tmp_rg_.+[\\/]extract$/),
        timeoutMs: 60_000,
        limits: {
          maxArchiveBytes: 100 * 1024 * 1024,
          maxExtractedBytes: 500 * 1024 * 1024,
          maxEntries: 1_000,
        },
      }),
    );
  });

  it("rejects downloads whose declared size exceeds the byte cap", async () => {
    const response = new Response("oversized-body", {
      status: 200,
      headers: { "content-length": "11" },
    });
    const cancel = vi.spyOn(response.body!, "cancel").mockResolvedValue(undefined);
    const release = vi.fn(async () => {});
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response,
      release,
      finalUrl: "https://example.com/archive.tar.gz",
    });
    const destination = join(tempAgentDir!, "archive.tar.gz");
    const { testing } = await import("./tools-manager.test-support.js");

    await expect(
      testing.downloadFile("https://example.com/archive.tar.gz", destination, 10),
    ).rejects.toThrow("Download exceeds the 10-byte archive limit");

    expect(cancel).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(existsSync(destination)).toBe(false);
  });

  it("rejects streamed bytes above the cap and removes the partial file", async () => {
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3, 4, 5, 6]));
          controller.enqueue(new Uint8Array([7, 8, 9, 10, 11, 12]));
          controller.close();
        },
      }),
      { status: 200, headers: { "content-length": "6" } },
    );
    const release = vi.fn(async () => {});
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response,
      release,
      finalUrl: "https://example.com/archive.tar.gz",
    });
    const destination = join(tempAgentDir!, "archive.tar.gz");
    const { testing } = await import("./tools-manager.test-support.js");

    await expect(
      testing.downloadFile("https://example.com/archive.tar.gz", destination, 10),
    ).rejects.toThrow("Download exceeded the 10-byte archive limit");

    expect(release).toHaveBeenCalledOnce();
    expect(existsSync(destination)).toBe(false);
  });

  it("accepts downloads exactly at the byte cap", async () => {
    const body = new Uint8Array([1, 2, 3, 4]);
    const release = vi.fn(async () => {});
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: new Response(body, {
        status: 200,
        headers: { "content-length": String(body.byteLength) },
      }),
      release,
      finalUrl: "https://example.com/archive.tar.gz",
    });
    const destination = join(tempAgentDir!, "archive.tar.gz");
    const { testing } = await import("./tools-manager.test-support.js");

    await testing.downloadFile("https://example.com/archive.tar.gz", destination, body.byteLength);

    expect(release).toHaveBeenCalledOnce();
    expect(readFileSync(destination)).toEqual(Buffer.from(body));
  });

  it("bounds GitHub release metadata reads", async () => {
    let reads = 0;
    let canceled = false;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (reads >= 20) {
            controller.close();
            return;
          }
          reads += 1;
          controller.enqueue(new Uint8Array(512 * 1024));
        },
        cancel() {
          canceled = true;
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
    const release = vi.fn(async () => {});
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response,
      release,
      finalUrl: "https://api.github.com/repos/sharkdp/fd/releases/latest",
    });

    const { ensureTool } = await import("./tools-manager.js");
    await expect(ensureTool("fd", true)).resolves.toBeUndefined();

    expect(reads).toBeLessThan(20);
    expect(canceled).toBe(true);
    expect(release).toHaveBeenCalledOnce();
  });
});

describe("ensureTool exit-status handling", () => {
  it("treats a binary that spawns but exits non-zero as missing", async () => {
    const { ensureTool } = await import("./tools-manager.js");
    // execve succeeded (no result.error) but the child exited non-zero — the
    // signature of an installed-but-broken binary (GLIBC / shared-lib mismatch).
    // Must not be reported as available, or ensureTool skips its download path.
    spawnSyncMock.mockReturnValue({
      error: undefined,
      status: 1,
      stderr: Buffer.alloc(0),
      stdout: Buffer.alloc(0),
    });
    const release = vi.fn(async () => {});
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: new Response("unavailable", { status: 503 }),
      release,
      finalUrl: "https://api.github.com/repos/sharkdp/fd/releases/latest",
    });

    await expect(ensureTool("fd", true)).resolves.toBeUndefined();
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  it("reports a binary present when it spawns and exits 0", async () => {
    const { ensureTool } = await import("./tools-manager.js");
    spawnSyncMock.mockReturnValue({
      error: undefined,
      status: 0,
      stderr: Buffer.alloc(0),
      stdout: Buffer.alloc(0),
    });
    await expect(ensureTool("fd", true)).resolves.toBe("fd");
    expect(spawnSyncMock).toHaveBeenCalledWith("fd", ["--version"], {
      killSignal: "SIGKILL",
      stdio: "pipe",
      timeout: 5_000,
    });
    expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
  });
});
