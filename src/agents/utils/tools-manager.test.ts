import fs, { existsSync, readFileSync, writeFileSync } from "node:fs";
import os, { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../test-utils/prepare-compiled-subprocesses.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { FileLockOptions } from "../../infra/file-lock.js";
import { snapshotFiles } from "../../infra/state-migrations.caller-mode.test-helpers.js";

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

let tempAgentDir: string | undefined;

function stubHome(home: string, stateDir = home) {
  vi.spyOn(os, "homedir").mockReturnValue(home);
  for (const key of ["HOME", "USERPROFILE", "OPENCLAW_HOME"]) {
    vi.stubEnv(key, home);
  }
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
}

function guardedResponse(response: Response, release = vi.fn(async () => {})) {
  return { response, release };
}

function writeBinary(path: string, contents = "binary") {
  fs.mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

function byteStream(sizes: number[], highWaterMark = 1) {
  let reads = 0;
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        const size = sizes[reads];
        if (size !== undefined) {
          controller.enqueue(new Uint8Array(size));
          reads += 1;
        } else {
          controller.close();
        }
      },
      cancel,
    },
    { highWaterMark },
  );
  return { body, cancel, readCount: () => reads };
}

function expectReleased(releases: ReturnType<typeof mockDownload>) {
  expect(releases.releaseCheckRelease).toHaveBeenCalledOnce();
  expect(releases.downloadRelease).toHaveBeenCalledOnce();
}

function mockDownload(response: Response, release = vi.fn(async () => {})) {
  const metadata = guardedResponse(Response.json({ tag_name: "14.1.1" }));
  fetchWithSsrFGuardMock
    .mockResolvedValueOnce(metadata)
    .mockResolvedValueOnce(guardedResponse(response, release));
  return { releaseCheckRelease: metadata.release, downloadRelease: release };
}

beforeEach(() => {
  tempAgentDir = fs.mkdtempSync(join(tmpdir(), "openclaw-tools-manager-"));
  vi.stubEnv("OPENCLAW_AGENT_DIR", tempAgentDir);
  fetchWithSsrFGuardMock.mockReset();
  extractArchiveMock.mockReset();
  withFileLockMock
    .mockReset()
    .mockImplementation(
      async (_path: string, _options: FileLockOptions, fn: () => Promise<unknown>) => fn(),
    );
  spawnSyncMock.mockReturnValue({ error: new Error("ENOENT"), status: null });
});

afterEach(() => {
  vi.doUnmock("node:os");
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.resetModules();
  vi.unstubAllEnvs();
  if (tempAgentDir) {
    fs.rmSync(tempAgentDir, { recursive: true, force: true });
  }
  tempAgentDir = undefined;
});

describe("ensureTool", () => {
  it.each(["fd", "shell"] as const)(
    "keeps %s usable without an ambient agent owner",
    async (tool) => {
      const home = expectDefined(tempAgentDir, "test home");
      const configPath = join(home, "openclaw.json");
      stubHome(home);
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
        await expect(ensureTool(tool)).resolves.toBe(tool);
        spawnSyncMock.mockReturnValue({ status: 1 });
        await expect(ensureTool(tool)).resolves.toBeUndefined();
        expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
      }
      expect(snapshotFiles(home)).toEqual(before);
    },
  );

  it.each<[string, string, string, string, string?]>([
    ["legacy only", "payload", "missing", "legacy"],
    ["migrated", "missing", "payload", "canonical"],
    ["both present", "payload", "payload", "legacy"],
    ["empty canonical", "payload", "empty", "legacy"],
    ["completed migration", "payload", "payload", "canonical", "valid"],
    ["incomplete receipt", "payload", "empty", "legacy", "partial"],
    ["another source's receipt", "payload", "payload", "legacy", "other-source"],
    ["another target's receipt", "payload", "payload", "legacy", "other-target"],
    ["empty legacy", "empty", "missing", "canonical"],
    ["missing legacy", "missing", "missing", "canonical"],
  ])(
    "reuses managed binaries across default-profile agent directory migration: %s",
    async (_name, legacy, canonical, selected, receipt) => {
      const home = expectDefined(tempAgentDir, "test home");
      const stateDir = join(home, ".openclaw");
      stubHome(home, stateDir);
      vi.stubEnv("OPENCLAW_PROFILE", "");
      vi.stubEnv("OPENCLAW_AGENT_DIR", "");
      vi.stubEnv("OPENCLAW_OFFLINE", "1");
      const canonicalDir = join(stateDir, "agents", "main", "agent");
      const legacyDir = join(home, ".openclaw", "agent");
      const binaryName = process.platform === "win32" ? "fd.exe" : "fd";
      for (const [directory, contents] of [
        [legacyDir, legacy],
        [canonicalDir, canonical],
      ] as const) {
        if (contents === "payload") {
          writeBinary(join(directory, "bin", binaryName), "managed binary");
        } else if (contents === "empty") {
          fs.mkdirSync(directory, { recursive: true });
        }
      }

      if (receipt) {
        const source =
          receipt === "other-source" ? join(home, "other-agent") : fs.realpathSync(legacyDir);
        const target =
          receipt === "other-target" ? join(home, "other-target") : fs.realpathSync(canonicalDir);
        writeFileSync(
          join(canonicalDir, ".legacy-agent-dir-migration.json"),
          receipt === "partial"
            ? '{"version":1'
            : JSON.stringify({ version: 1, source, target }) + "\n",
        );
      }

      const { getAgentDir } = await import("../config.js");
      const { resolveAgentDir } = await import("../agent-scope-config.js");
      const { ensureTool } = await import("./tools-manager.js");
      const selectedDir = selected === "legacy" ? legacyDir : canonicalDir;
      const selectedContents = selected === "legacy" ? legacy : canonical;

      await expect(ensureTool("fd")).resolves.toBe(
        selectedContents === "payload" ? join(selectedDir, "bin", binaryName) : undefined,
      );
      expect(getAgentDir()).toBe(selectedDir);
      expect(resolveAgentDir({}, "main")).toBe(canonicalDir);
      expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
      expect(existsSync(legacyDir)).toBe(legacy !== "missing");
    },
  );

  it("keeps installed tools available with unreadable config and follows repaired configuration", async () => {
    const root = expectDefined(tempAgentDir, "test root");
    const configPath = join(root, "openclaw.json");
    const firstDir = join(root, "first-agent");
    const secondDir = join(root, "second-agent");
    const defaultDir = join(root, "agents/main/agent");
    stubHome(root);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
    vi.stubEnv("OPENCLAW_AGENT_DIR", firstDir);
    vi.stubEnv("OPENCLAW_OFFLINE", "1");
    fs.mkdirSync(configPath);
    const binary = process.platform === "win32" ? "fd.exe" : "fd";
    for (const agentDir of [defaultDir, firstDir, secondDir]) {
      writeBinary(join(agentDir, "bin", binary), "managed binary");
    }
    const { ensureTool } = await import("./tools-manager.js");
    const { getAgentDir } = await import("../config.js");
    const read = vi.spyOn(fs, "readFileSync");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const before = snapshotFiles(root);
    read.mockClear();
    expect(getAgentDir()).toBe(firstDir);
    await expect(ensureTool("fd")).resolves.toBe(join(firstDir, "bin", binary));
    expect(read.mock.calls.some(([file]) => file === configPath)).toBe(false);
    expect(warn).not.toHaveBeenCalled();

    vi.stubEnv("OPENCLAW_AGENT_DIR", "");
    const beforeEnv = { ...process.env };
    expect(getAgentDir()).toBe(defaultDir);
    await expect(ensureTool("fd")).resolves.toBe(join(defaultDir, "bin", binary));
    expect(getAgentDir()).toBe(defaultDir);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("default agent directory"));
    expect(process.env).toEqual(beforeEnv);
    expect(snapshotFiles(root)).toEqual(before);

    fs.rmSync(configPath, { recursive: true });
    for (const agentDir of [firstDir, secondDir]) {
      writeFileSync(configPath, JSON.stringify({ agents: { entries: { main: { agentDir } } } }));
      await expect(ensureTool("fd")).resolves.toBe(join(agentDir, "bin", binary));
    }
  });

  it("single-flights concurrent installs until installation settles", async () => {
    const releaseCheckStarted = createDeferred();
    const { ensureTool } = await import("./tools-manager.js");
    const releaseCheckRelease = vi.fn(async () => {});
    const downloadRelease = vi.fn(async () => {});
    const { promise: releaseCheck, resolve: resolveCheck } =
      createDeferred<ReturnType<typeof guardedResponse>>();
    extractArchiveMock.mockImplementation(async (params: { destDir: string }) => {
      writeFileSync(join(params.destDir, "fd"), "binary");
    });
    fetchWithSsrFGuardMock
      .mockImplementationOnce(() => {
        releaseCheckStarted.resolve();
        return releaseCheck;
      })
      .mockResolvedValueOnce(guardedResponse(new Response("archive-bytes"), downloadRelease));
    withFileLockMock.mockImplementationOnce(
      async (lockPath: string, _options: FileLockOptions, fn: () => Promise<unknown>) => {
        expect(existsSync(dirname(lockPath))).toBe(true);
        return fn();
      },
    );

    const installs = [ensureTool("fd"), ensureTool("fd")];

    await releaseCheckStarted.promise;
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledOnce();
    resolveCheck(guardedResponse(Response.json({ tag_name: "v10.3.0" }), releaseCheckRelease));
    const binaryPath = join(tempAgentDir!, "bin", "fd");
    await expect(Promise.all(installs)).resolves.toEqual([binaryPath, binaryPath]);
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledTimes(2);
    expect(extractArchiveMock).toHaveBeenCalledOnce();
    expect(withFileLockMock).toHaveBeenCalledOnce();
    const lockOptions = withFileLockMock.mock.calls[0]?.[1];
    const { retries, stale } = expectDefined(lockOptions, "tool installation lock options");
    const minimumLockWaitMs = Array.from({ length: retries.retries }, (_, attempt) =>
      Math.min(
        retries.maxTimeout,
        Math.max(retries.minTimeout, retries.minTimeout * retries.factor ** attempt),
      ),
    ).reduce((total, delay) => total + delay, 0);
    expect(minimumLockWaitMs).toBeGreaterThan(stale);
  });

  it("reuses an installation published during the lock wait", async () => {
    const binaryPath = join(tempAgentDir!, "bin", "fd");
    withFileLockMock.mockImplementationOnce(
      async (_path: string, _options: FileLockOptions, fn: () => Promise<unknown>) => {
        writeBinary(binaryPath);
        return fn();
      },
    );
    const { ensureTool } = await import("./tools-manager.js");

    await expect(ensureTool("fd")).resolves.toBe(binaryPath);

    expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
  });

  it("extracts Windows zip downloads via safe archive API with size limits", async () => {
    vi.doMock("node:os", async (importOriginal) => ({
      ...(await importOriginal<typeof import("node:os")>()),
      arch: () => "x64",
      platform: () => "win32",
    }));

    const { ensureTool } = await import("./tools-manager.js");
    extractArchiveMock.mockImplementation(async (params: { destDir: string }) => {
      writeFileSync(join(params.destDir, "rg.exe"), "binary");
    });
    mockDownload(new Response("zip-bytes", { status: 200 }));

    await expect(ensureTool("rg")).resolves.toBe(join(tempAgentDir!, "bin", "rg.exe"));

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

  it("installs decoded downloads when encoded Content-Length exceeds the archive cap", async () => {
    const agentDir = expectDefined(tempAgentDir, "test agent directory");
    const binaryName = process.platform === "win32" ? "rg.exe" : "rg";
    const archive = "decoded archive bytes";
    extractArchiveMock.mockImplementation(
      async (params: { archivePath: string; destDir: string }) => {
        expect(readFileSync(params.archivePath, "utf8")).toBe(archive);
        writeBinary(join(params.destDir, "vendor", "bin", binaryName));
      },
    );
    // Fetch has already decoded the body; this header still describes wire bytes.
    const releases = mockDownload(
      new Response(archive, {
        status: 200,
        headers: { "content-encoding": "gzip", "content-length": "104857601" },
      }),
    );
    const { ensureTool } = await import("./tools-manager.js");
    const binaryPath = join(agentDir, "bin", binaryName);

    await expect(ensureTool("rg")).resolves.toBe(binaryPath);

    expect(readFileSync(binaryPath, "utf8")).toBe("binary");
    expect(extractArchiveMock).toHaveBeenCalledOnce();
    expectReleased(releases);
    expect(fs.readdirSync(join(agentDir, "bin"))).toEqual([binaryName]);
  });

  it.each([
    { name: "declared bytes", declaredBytes: 100 * 1024 * 1024 + 1, readsBody: false },
    { name: "streamed bytes", declaredBytes: 1, readsBody: true },
  ])(
    "rejects $name above the archive cap and cleans installation staging",
    async ({ declaredBytes, readsBody }) => {
      const agentDir = expectDefined(tempAgentDir, "test agent directory");
      // Write one byte before the second chunk exceeds the cap.
      const stream = byteStream([1, 100 * 1024 * 1024], 0);
      const response = new Response(stream.body, {
        headers: { "content-length": String(declaredBytes) },
      });
      const releases = mockDownload(
        response,
        vi.fn(async () => {
          await response.body?.cancel();
        }),
      );
      const { ensureTool } = await import("./tools-manager.js");

      await expect(ensureTool("rg")).resolves.toBeUndefined();

      if (readsBody) {
        expect(stream.readCount()).toBeGreaterThanOrEqual(2);
      } else {
        expect(stream.readCount()).toBe(0);
      }
      expect(stream.cancel).toHaveBeenCalledOnce();
      expect(response.body?.locked).toBe(false);
      expect(extractArchiveMock).not.toHaveBeenCalled();
      expectReleased(releases);
      expect(fs.readdirSync(join(agentDir, "bin"))).toEqual([]);
    },
  );

  it.each([
    { name: "returns unavailable for an unreadable extracted directory", readableBinary: false },
    {
      name: "installs a readable binary despite an unrelated directory read failure",
      readableBinary: true,
    },
  ])("$name and cleans installation staging", async ({ readableBinary }) => {
    const agentDir = expectDefined(tempAgentDir, "test agent directory");
    const binaryName = process.platform === "win32" ? "rg.exe" : "rg";
    let blockedDir: string | undefined;
    let deniedRead = false;
    const readdir = fs.readdirSync.bind(fs);
    vi.spyOn(fs, "readdirSync").mockImplementation((...args) => {
      if (args[0] === blockedDir && !deniedRead) {
        deniedRead = true;
        throw Object.assign(new Error("EACCES: cannot read extracted directory"), {
          code: "EACCES",
        });
      }
      return readdir(...args);
    });
    extractArchiveMock.mockImplementation(async (params: { destDir: string }) => {
      blockedDir = join(params.destDir, "nested");
      fs.mkdirSync(blockedDir);
      writeFileSync(join(blockedDir, binaryName), "binary");
      if (readableBinary) {
        writeBinary(join(params.destDir, "readable", binaryName), "readable binary");
      }
    });
    const releases = mockDownload(new Response("archive bytes", { status: 200 }));
    const { ensureTool } = await import("./tools-manager.js");

    const installed = await ensureTool("rg");

    expect(deniedRead).toBe(true);
    if (readableBinary) {
      const binaryPath = join(agentDir, "bin", binaryName);
      expect(installed).toBe(binaryPath);
      expect(readFileSync(binaryPath, "utf8")).toBe("readable binary");
    } else {
      expect(installed).toBeUndefined();
    }
    expectReleased(releases);
    expect(fs.readdirSync(join(agentDir, "bin"))).toEqual(readableBinary ? [binaryName] : []);
  });

  it("bounds GitHub release metadata reads", async () => {
    const stream = byteStream(Array.from({ length: 20 }, () => 512 * 1024));
    const guarded = guardedResponse(
      new Response(stream.body, {
        headers: { "content-type": "application/json" },
      }),
    );
    fetchWithSsrFGuardMock.mockResolvedValueOnce(guarded);

    const { ensureTool } = await import("./tools-manager.js");
    await expect(ensureTool("fd")).resolves.toBeUndefined();

    expect(stream.readCount()).toBeLessThan(20);
    expect(stream.cancel).toHaveBeenCalledOnce();
    expect(guarded.release).toHaveBeenCalledOnce();
  });
  it.each(["release", "download"] as const)(
    "cancels and releases %s HTTP errors",
    async (phase) => {
      const { ensureTool } = await import("./tools-manager.js");
      const response = new Response("unavailable", { status: phase === "release" ? 503 : 404 });
      const cancel = vi.spyOn(response.body!, "cancel").mockResolvedValue(undefined);
      if (phase === "release") {
        // A successful spawn with a nonzero exit (e.g. GLIBC mismatch) must still download.
        spawnSyncMock.mockReturnValue({ status: 1 });
        const guarded = guardedResponse(response);
        fetchWithSsrFGuardMock.mockResolvedValueOnce(guarded);
        await expect(ensureTool("fd")).resolves.toBeUndefined();
        expect(fetchWithSsrFGuardMock).toHaveBeenCalledOnce();
        expect(guarded.release).toHaveBeenCalledOnce();
      } else {
        const releases = mockDownload(response);
        await expect(ensureTool("rg")).resolves.toBeUndefined();
        expectReleased(releases);
      }
      expect(cancel).toHaveBeenCalledOnce();
    },
  );
});
