// Proxy capture CA tests cover bounded and recoverable certificate generation.
import { mkdir, readdir, readFile, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";

const { resolveSystemBinMock, runExecMock } = vi.hoisted(() => ({
  resolveSystemBinMock: vi.fn(),
  runExecMock: vi.fn(),
}));

vi.mock("../infra/resolve-system-bin.js", () => ({ resolveSystemBin: resolveSystemBinMock }));
vi.mock("../process/exec.js", () => ({ runExec: runExecMock }));

import { ensureDebugProxyCa } from "./ca.js";

const tempDirs = createTrackedTempDirs();

function argAfter(args: string[], flag: string): string {
  const index = args.indexOf(flag);
  expect(index).toBeGreaterThanOrEqual(0);
  const value = args[index + 1];
  expect(value).toBeDefined();
  return value as string;
}

function mockSuccessfulGeneration() {
  runExecMock.mockImplementation(async (_command: string, args: string[]) => {
    await writeFile(argAfter(args, "-keyout"), "generated key\n", "utf8");
    await writeFile(argAfter(args, "-out"), "generated cert\n", "utf8");
    return { stdout: "", stderr: "" };
  });
}

async function sortedDirEntries(dir: string): Promise<string[]> {
  return (await readdir(dir)).sort();
}

beforeEach(() => {
  resolveSystemBinMock.mockReturnValue("/usr/bin/openssl");
  runExecMock.mockReset();
});

afterEach(async () => {
  await tempDirs.cleanup();
});

describe("ensureDebugProxyCa", () => {
  it("reuses an existing CA pair without invoking OpenSSL", async () => {
    const certDir = await tempDirs.make("openclaw-proxy-ca-");
    const certPath = path.join(certDir, "root-ca.pem");
    const keyPath = path.join(certDir, "root-ca-key.pem");
    await writeFile(certPath, "existing cert\n", "utf8");
    await writeFile(keyPath, "existing key\n", "utf8");

    await expect(ensureDebugProxyCa(certDir)).resolves.toEqual({ certPath, keyPath });

    expect(runExecMock).not.toHaveBeenCalled();
  });

  it("generates into temporary files before promoting the reusable CA pair", async () => {
    const certDir = await tempDirs.make("openclaw-proxy-ca-");
    const certPath = path.join(certDir, "root-ca.pem");
    const keyPath = path.join(certDir, "root-ca-key.pem");
    mockSuccessfulGeneration();

    await expect(ensureDebugProxyCa(certDir)).resolves.toEqual({ certPath, keyPath });

    expect(await readFile(certPath, "utf8")).toBe("generated cert\n");
    expect(await readFile(keyPath, "utf8")).toBe("generated key\n");
    await expect(sortedDirEntries(certDir)).resolves.toEqual(["root-ca-key.pem", "root-ca.pem"]);

    const [command, args, options] = runExecMock.mock.calls[0] as [
      string,
      string[],
      Record<string, unknown>,
    ];
    expect(command).toBe("/usr/bin/openssl");
    expect(options).toEqual({ logOutput: false, timeoutMs: 30_000 });
    expect(argAfter(args, "-keyout").startsWith(`${keyPath}.tmp-`)).toBe(true);
    expect(argAfter(args, "-out").startsWith(`${certPath}.tmp-`)).toBe(true);
    expect(args).not.toContain(keyPath);
    expect(args).not.toContain(certPath);
  });

  it("cleans partial CA output after a generation failure so a retry can regenerate", async () => {
    const certDir = await tempDirs.make("openclaw-proxy-ca-");
    const certPath = path.join(certDir, "root-ca.pem");
    const keyPath = path.join(certDir, "root-ca-key.pem");
    await writeFile(certPath, "stale partial cert\n", "utf8");
    runExecMock
      .mockImplementationOnce(async (_command: string, args: string[]) => {
        await writeFile(argAfter(args, "-keyout"), "partial key\n", "utf8");
        await writeFile(argAfter(args, "-out"), "partial cert\n", "utf8");
        throw new Error("openssl timed out");
      })
      .mockImplementationOnce(async (_command: string, args: string[]) => {
        await writeFile(argAfter(args, "-keyout"), "retry key\n", "utf8");
        await writeFile(argAfter(args, "-out"), "retry cert\n", "utf8");
        return { stdout: "", stderr: "" };
      });

    await expect(ensureDebugProxyCa(certDir)).rejects.toThrow("openssl timed out");
    await expect(sortedDirEntries(certDir)).resolves.toEqual([]);

    await expect(ensureDebugProxyCa(certDir)).resolves.toEqual({ certPath, keyPath });
    await expect(readFile(certPath, "utf8")).resolves.toBe("retry cert\n");
    await expect(readFile(keyPath, "utf8")).resolves.toBe("retry key\n");
  });

  it("does not recursively remove existing directories at CA output paths", async () => {
    const certDir = await tempDirs.make("openclaw-proxy-ca-");
    const certPath = path.join(certDir, "root-ca.pem");
    const nestedPath = path.join(certPath, "keep.txt");
    await mkdir(certPath);
    await writeFile(nestedPath, "user data\n", "utf8");
    runExecMock.mockRejectedValueOnce(new Error("openssl failed"));

    await expect(ensureDebugProxyCa(certDir)).rejects.toThrow("openssl failed");

    expect((await stat(certPath)).isDirectory()).toBe(true);
    await expect(readFile(nestedPath, "utf8")).resolves.toBe("user data\n");
  });

  it("reclaims abandoned lock tokens before regenerating", async () => {
    const certDir = await tempDirs.make("openclaw-proxy-ca-");
    const certPath = path.join(certDir, "root-ca.pem");
    const keyPath = path.join(certDir, "root-ca-key.pem");
    const lockDir = path.join(certDir, ".root-ca-generation.lock");
    const lockTokenPath = path.join(lockDir, "abandoned.lock");
    const nowMs = Date.parse("2026-07-17T00:00:00.000Z");
    await mkdir(lockDir);
    await writeFile(lockTokenPath, String(nowMs - 40_000), "utf8");
    await utimes(lockTokenPath, new Date(nowMs - 40_000), new Date(nowMs - 40_000));
    mockSuccessfulGeneration();

    vi.useFakeTimers();
    vi.setSystemTime(nowMs);
    try {
      await expect(ensureDebugProxyCa(certDir)).resolves.toEqual({ certPath, keyPath });
    } finally {
      vi.useRealTimers();
    }

    await expect(readFile(certPath, "utf8")).resolves.toBe("generated cert\n");
    await expect(readFile(keyPath, "utf8")).resolves.toBe("generated key\n");
    await expect(sortedDirEntries(certDir)).resolves.toEqual(["root-ca-key.pem", "root-ca.pem"]);
  });

  it("times out instead of reclaiming active lock tokens across processes", async () => {
    const certDir = await tempDirs.make("openclaw-proxy-ca-");
    const lockDir = path.join(certDir, ".root-ca-generation.lock");
    const lockTokenPath = path.join(lockDir, "active.lock");
    const nowMs = Date.parse("2026-07-17T00:00:00.000Z");
    await mkdir(lockDir);
    await writeFile(lockTokenPath, String(nowMs), "utf8");

    vi.useFakeTimers();
    vi.setSystemTime(nowMs);
    try {
      const generation = ensureDebugProxyCa(certDir);
      await vi.advanceTimersByTimeAsync(35_100);

      await expect(generation).rejects.toThrow(
        "timed out waiting for debug proxy CA generation lock",
      );
      expect(runExecMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("serializes concurrent generation for a shared cert directory", async () => {
    const certDir = await tempDirs.make("openclaw-proxy-ca-");
    const certPath = path.join(certDir, "root-ca.pem");
    const keyPath = path.join(certDir, "root-ca-key.pem");
    let markStarted!: () => void;
    let finishGeneration!: () => void;
    const generationStarted = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const generationMayFinish = new Promise<void>((resolve) => {
      finishGeneration = resolve;
    });
    runExecMock.mockImplementationOnce(async (_command: string, args: string[]) => {
      markStarted();
      await generationMayFinish;
      await writeFile(argAfter(args, "-keyout"), "shared key\n", "utf8");
      await writeFile(argAfter(args, "-out"), "shared cert\n", "utf8");
      return { stdout: "", stderr: "" };
    });

    const first = ensureDebugProxyCa(certDir);
    await generationStarted;
    const second = ensureDebugProxyCa(certDir);
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
    expect(runExecMock).toHaveBeenCalledTimes(1);

    finishGeneration();
    await expect(Promise.all([first, second])).resolves.toEqual([
      { certPath, keyPath },
      { certPath, keyPath },
    ]);
    expect(runExecMock).toHaveBeenCalledTimes(1);
    await expect(sortedDirEntries(certDir)).resolves.toEqual(["root-ca-key.pem", "root-ca.pem"]);
  });
});
