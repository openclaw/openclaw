import fs, { existsSync, readFileSync, writeFileSync } from "node:fs";
import os, { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import "../../test-utils/prepare-compiled-subprocesses.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { FileLockOptions } from "../../infra/file-lock.js";
import { snapshotFiles } from "../../infra/state-migrations.caller-mode.test-helpers.js";

const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());
const spawnSyncMock = vi.hoisted(() => vi.fn());
const extractArchiveMock = vi.hoisted(() => vi.fn());
const withFileLockMock = vi.hoisted(() => vi.fn<typeof runLocked>());
type Install = () => Promise<unknown>;
const runLocked = (_path: string, _options: FileLockOptions, fn: Install) => fn();

vi.mock("../../infra/net/fetch-guard.js", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawnSync: spawnSyncMock,
}));

vi.mock("../../infra/archive.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/archive.js")>()),
  extractArchive: extractArchiveMock,
}));
vi.mock("../../infra/file-lock.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/file-lock.js")>()),
  withFileLock: withFileLockMock,
}));

let tempAgentDir: string;
const binaryName = (tool = "rg") => tool + (process.platform === "win32" ? ".exe" : "");
const binPath = (name = binaryName(), dir = tempAgentDir) => join(dir, "bin", name);
const binFiles = () => fs.readdirSync(join(tempAgentDir, "bin"));
const ensureTool = async (tool: "fd" | "rg") =>
  (await import("./tools-manager.js")).ensureTool(tool);

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
        if (size === undefined) {
          controller.close();
          return;
        }
        reads += 1;
        controller.enqueue(new Uint8Array(size));
      },
      cancel,
    },
    { highWaterMark },
  );
  return { body, cancel, readCount: () => reads };
}

function expectReleased(releases: ReturnType<typeof mockDownload>) {
  for (const release of releases) {
    expect(release).toHaveBeenCalledOnce();
  }
}

function mockDownload(response: Response, release = vi.fn(async () => {})) {
  const metadata = guardedResponse(Response.json({ tag_name: "14.1.1" }));
  fetchWithSsrFGuardMock
    .mockResolvedValueOnce(metadata)
    .mockResolvedValueOnce(guardedResponse(response, release));
  return [metadata.release, release];
}

beforeEach(() => {
  tempAgentDir = fs.mkdtempSync(join(tmpdir(), "openclaw-tools-manager-"));
  stubHome(tempAgentDir);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", join(tempAgentDir, "openclaw.json"));
  vi.stubEnv("OPENCLAW_AGENT_DIR", tempAgentDir);
  fetchWithSsrFGuardMock.mockReset();
  extractArchiveMock.mockReset();
  withFileLockMock.mockReset().mockImplementation(runLocked);
  spawnSyncMock.mockReturnValue({ error: new Error("ENOENT"), status: null });
});

afterEach(() => {
  vi.doUnmock("node:os");
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.resetModules();
  vi.unstubAllEnvs();
  fs.rmSync(tempAgentDir, { recursive: true, force: true });
});

it("uses system tools and shell env without an owner", async () => {
  const home = tempAgentDir;
  const configPath = join(home, "openclaw.json");
  vi.stubEnv("OPENCLAW_AGENT_DIR", "");
  writeFileSync(
    configPath,
    JSON.stringify({ agents: { ownership: "explicit", entries: { alpha: {}, beta: {} } } }),
  );
  const before = snapshotFiles(home);
  const { getAgentDir } = await import("../config.js");
  expect(() => getAgentDir()).toThrow("Select an agent owner");
  const { getBashShellEnv } = await import("../shell-utils.js");
  const sourceEnv = { PATH: join(home, "system-bin"), EXAMPLE: "preserved" };
  expect(getBashShellEnv(undefined, sourceEnv)).toEqual(sourceEnv);
  spawnSyncMock.mockReturnValue({ status: 0 });
  await expect(ensureTool("fd")).resolves.toBe("fd");
  spawnSyncMock.mockReturnValue({ status: 1 });
  await expect(ensureTool("fd")).resolves.toBeUndefined();
  expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
  expect(snapshotFiles(home)).toEqual(before);
});

it.each(["empty legacy", "partial", "other-source", "other-target"])(
  "selects the bin directory for %s",
  async (receipt) => {
    const stateDir = join(tempAgentDir, ".openclaw");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    vi.stubEnv("OPENCLAW_PROFILE", "");
    vi.stubEnv("OPENCLAW_AGENT_DIR", "");
    vi.stubEnv("OPENCLAW_OFFLINE", "1");
    const canonicalDir = join(stateDir, "agents", "main", "agent");
    const legacyDir = join(stateDir, "agent");
    const binary = binaryName("fd");
    fs.mkdirSync(legacyDir, { recursive: true });
    if (receipt !== "empty legacy") {
      writeBinary(binPath(binary, legacyDir));
      fs.mkdirSync(canonicalDir, { recursive: true });
      if (receipt !== "partial") {
        writeBinary(binPath(binary, canonicalDir));
      }
      const source = receipt === "other-source" ? "other-agent" : fs.realpathSync(legacyDir);
      const target = receipt === "other-target" ? "other-target" : fs.realpathSync(canonicalDir);
      writeFileSync(
        join(canonicalDir, ".legacy-agent-dir-migration.json"),
        receipt === "partial"
          ? '{"version":1'
          : JSON.stringify({ version: 1, source, target }) + "\n",
      );
    }
    await expect(ensureTool("fd")).resolves.toBe(
      receipt === "empty legacy" ? undefined : binPath(binary, legacyDir),
    );
    expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
    expect(existsSync(legacyDir)).toBe(true);
  },
);

it("finds installed tools across config failure and repair", async () => {
  const configPath = join(tempAgentDir, "openclaw.json");
  const firstDir = join(tempAgentDir, "first-agent");
  const secondDir = join(tempAgentDir, "second-agent");
  const defaultDir = join(tempAgentDir, "agents/main/agent");
  vi.stubEnv("OPENCLAW_AGENT_DIR", firstDir);
  vi.stubEnv("OPENCLAW_OFFLINE", "1");
  fs.mkdirSync(configPath);
  const binary = binaryName("fd");
  for (const agentDir of [defaultDir, firstDir, secondDir]) {
    writeBinary(binPath(binary, agentDir));
  }
  await import("./tools-manager.js");
  const read = vi.spyOn(fs, "readFileSync");
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const before = snapshotFiles(tempAgentDir);
  read.mockClear();
  await expect(ensureTool("fd")).resolves.toBe(binPath(binary, firstDir));
  expect(read.mock.calls.some(([file]) => file === configPath)).toBe(false);
  vi.stubEnv("OPENCLAW_AGENT_DIR", "");
  const beforeEnv = { ...process.env };
  await expect(ensureTool("fd")).resolves.toBe(binPath(binary, defaultDir));
  expect(process.env).toEqual(beforeEnv);
  expect(snapshotFiles(tempAgentDir)).toEqual(before);
  fs.rmSync(configPath, { recursive: true });
  for (const agentDir of [firstDir, secondDir]) {
    writeFileSync(configPath, JSON.stringify({ agents: { entries: { main: { agentDir } } } }));
    await expect(ensureTool("fd")).resolves.toBe(binPath(binary, agentDir));
  }
});

it("single-flights installs through settlement", async () => {
  const started = createDeferred();
  const pending = createDeferred<ReturnType<typeof guardedResponse>>();
  extractArchiveMock.mockImplementation(async ({ destDir }: { destDir: string }) => {
    writeFileSync(join(destDir, "fd"), "binary");
  });
  fetchWithSsrFGuardMock
    .mockImplementationOnce(() => {
      started.resolve();
      return pending.promise;
    })
    .mockResolvedValueOnce(guardedResponse(new Response("archive-bytes")));
  withFileLockMock.mockImplementationOnce(async (lockPath, _options, fn) => {
    expect(existsSync(dirname(lockPath))).toBe(true);
    return fn();
  });
  const installs = [ensureTool("fd"), ensureTool("fd")];
  await started.promise;
  expect(fetchWithSsrFGuardMock).toHaveBeenCalledOnce();
  pending.resolve(guardedResponse(Response.json({ tag_name: "v10.3.0" })));
  const binaryPath = binPath("fd");
  await expect(Promise.all(installs)).resolves.toEqual([binaryPath, binaryPath]);
  expect(fetchWithSsrFGuardMock).toHaveBeenCalledTimes(2);
  expect(withFileLockMock).toHaveBeenCalledOnce();
  const { retries: r, stale } = expectDefined(withFileLockMock.mock.calls[0]?.[1], "lock options");
  let wait = 0;
  for (let i = 0; i < r.retries; i++) {
    wait += Math.min(r.maxTimeout, Math.max(r.minTimeout, r.minTimeout * r.factor ** i));
  }
  expect(wait).toBeGreaterThan(stale);
});

it("reuses binaries published during the lock wait", async () => {
  const binaryPath = binPath("fd");
  withFileLockMock.mockImplementationOnce(async (_path, _options, fn) => {
    writeBinary(binaryPath);
    return fn();
  });
  await expect(ensureTool("fd")).resolves.toBe(binaryPath);
  expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
});

it.each(["Windows zip", "decoded body"])("installs %s with bounded extraction", async (kind) => {
  const windows = kind === "Windows zip";
  if (windows) {
    vi.doMock("node:os", async (importOriginal) => ({
      ...(await importOriginal<typeof import("node:os")>()),
      arch: () => "x64",
      platform: () => "win32",
    }));
  }
  const binary = windows ? "rg.exe" : binaryName();
  const archive = "decoded archive bytes";
  extractArchiveMock.mockImplementation(
    async (params: { archivePath: string; destDir: string }) => {
      expect(readFileSync(params.archivePath, "utf8")).toBe(archive);
      if (windows) {
        expect(params.archivePath).toMatch(/\.zip$/);
        writeFileSync(join(params.destDir, binary), "binary");
      } else {
        writeBinary(join(params.destDir, "vendor", "bin", binary));
      }
    },
  );
  // Fetch has already decoded the body; this header still describes wire bytes.
  const releases = mockDownload(
    new Response(archive, {
      headers: windows ? {} : { "content-encoding": "gzip", "content-length": "104857601" },
    }),
  );
  await expect(ensureTool("rg")).resolves.toBe(binPath(binary));
  expect(readFileSync(binPath(binary), "utf8")).toBe("binary");
  expect(extractArchiveMock).toHaveBeenCalledWith(
    expect.objectContaining({
      timeoutMs: 60_000,
      limits: {
        maxArchiveBytes: 100 * 1024 * 1024,
        maxExtractedBytes: 500 * 1024 * 1024,
        maxEntries: 1_000,
      },
    }),
  );
  expectReleased(releases);
  expect(binFiles()).toEqual([binary]);
});

it.each([
  ["declared", 100 * 1024 * 1024 + 1, false],
  ["streamed", 1, true],
] as const)("rejects oversized %s bytes", async (_name, bytes, readsBody) => {
  const stream = byteStream([1, 100 * 1024 * 1024], 0);
  const response = new Response(stream.body, {
    headers: { "content-length": String(bytes) },
  });
  const releases = mockDownload(
    response,
    vi.fn(async () => {
      await response.body?.cancel();
    }),
  );
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
  expect(binFiles()).toEqual([]);
});

it.each([false, true])("handles unreadable extraction (fallback: %s)", async (fallback) => {
  let blockedDir: string | undefined;
  let deniedRead = false;
  const readdir = fs.readdirSync.bind(fs);
  vi.spyOn(fs, "readdirSync").mockImplementation((...args) => {
    if (args[0] === blockedDir && !deniedRead) {
      deniedRead = true;
      throw Object.assign(new Error("cannot read extracted directory"), { code: "EACCES" });
    }
    return readdir(...args);
  });
  extractArchiveMock.mockImplementation(async (params: { destDir: string }) => {
    blockedDir = join(params.destDir, "nested");
    fs.mkdirSync(blockedDir);
    writeBinary(join(blockedDir, binaryName()));
    if (fallback) {
      writeBinary(join(params.destDir, "readable", binaryName()), "readable binary");
    }
  });
  const releases = mockDownload(new Response("archive bytes"));
  const installed = await ensureTool("rg");
  expect(deniedRead).toBe(true);
  expect(installed).toBe(fallback ? binPath() : undefined);
  if (fallback) {
    expect(readFileSync(binPath(), "utf8")).toBe("readable binary");
  }
  expectReleased(releases);
  expect(binFiles()).toEqual(fallback ? [binaryName()] : []);
});

it("bounds GitHub release metadata reads", async () => {
  const stream = byteStream(Array.from({ length: 20 }, () => 512 * 1024));
  const headers = { "content-type": "application/json" };
  const guarded = guardedResponse(new Response(stream.body, { headers }));
  fetchWithSsrFGuardMock.mockResolvedValueOnce(guarded);
  await expect(ensureTool("fd")).resolves.toBeUndefined();
  expect(stream.readCount()).toBeLessThan(20);
  expect(stream.cancel).toHaveBeenCalledOnce();
  expect(guarded.release).toHaveBeenCalledOnce();
});
it.each(["release", "download"] as const)("releases %s HTTP errors", async (phase) => {
  const response = new Response("unavailable", { status: phase === "release" ? 503 : 404 });
  const cancel = vi.spyOn(response.body!, "cancel").mockResolvedValue(undefined);
  const guarded = guardedResponse(response);
  let releases;
  if (phase === "release") {
    // A successful spawn with a nonzero exit (e.g. GLIBC mismatch) must still download.
    spawnSyncMock.mockReturnValue({ status: 1 });
    fetchWithSsrFGuardMock.mockResolvedValueOnce(guarded);
    releases = [guarded.release];
  } else {
    releases = mockDownload(response);
  }
  await expect(ensureTool("fd")).resolves.toBeUndefined();
  expectReleased(releases);
  expect(cancel).toHaveBeenCalledOnce();
});
