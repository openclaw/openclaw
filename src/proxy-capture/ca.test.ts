import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";

const { resolveSystemBinMock, runExecMock } = vi.hoisted(() => ({
  resolveSystemBinMock: vi.fn(() => "/usr/bin/openssl"),
  runExecMock: vi.fn(),
}));

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  const parseMarker = (value: Buffer, prefix: string): string => {
    const text = value.toString("utf8");
    if (!text.startsWith(prefix)) {
      throw new Error("invalid certificate material");
    }
    return text.slice(prefix.length);
  };
  return {
    ...actual,
    createPrivateKey: (value: Buffer) => ({ marker: parseMarker(value, "ca-material-marker:") }),
    X509Certificate: class {
      readonly ca: boolean;
      readonly marker: string;
      constructor(value: Buffer) {
        this.marker = parseMarker(value, "ca-cert-marker:");
        this.ca = this.marker !== "not-ca";
      }
      checkPrivateKey(key: { marker?: string }): boolean {
        return key.marker === this.marker;
      }
    },
  };
});
vi.mock("../infra/resolve-system-bin.js", () => ({ resolveSystemBin: resolveSystemBinMock }));
vi.mock("../process/exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../process/exec.js")>()),
  runExec: runExecMock,
}));

import { ensureDebugProxyCa } from "./ca.js";

const tempDirs = createTrackedTempDirs();

function outputPath(args: string[], flag: "-config" | "-keyout" | "-out"): string {
  const value = args[args.indexOf(flag) + 1];
  if (!value) {
    throw new Error(`missing ${flag} output path`);
  }
  return value;
}

function writeGeneratedPair(args: string[], marker: string): void {
  fs.writeFileSync(outputPath(args, "-out"), `ca-cert-marker:${marker}`);
  fs.writeFileSync(outputPath(args, "-keyout"), `ca-material-marker:${marker}`);
}

async function makeCertPaths(stale?: string) {
  const certDir = await tempDirs.make("openclaw-proxy-ca-");
  const certPath = path.join(certDir, "root-ca.pem");
  const keyPath = path.join(certDir, "root-ca-key.pem");
  if (stale) {
    fs.writeFileSync(certPath, `${stale} cert`);
    fs.writeFileSync(keyPath, `${stale} key`);
  }
  return {
    certDir,
    paths: { certPath, keyPath },
    ensure: () => ensureDebugProxyCa(certDir),
    read: () => [fs.readFileSync(certPath, "utf8"), fs.readFileSync(keyPath, "utf8")],
  };
}

function generatePair(marker: string): void {
  runExecMock.mockImplementationOnce(async (_command: string, args: string[]) => {
    writeGeneratedPair(args, marker);
  });
}

afterEach(async () => {
  vi.restoreAllMocks();
  runExecMock.mockReset();
  await tempDirs.cleanup();
});

describe("ensureDebugProxyCa", () => {
  it("regenerates after partial output timeout without reusing stale final files", async () => {
    const { certDir, paths, ensure, read } = await makeCertPaths("stale partial");
    let generatedConfig = "";
    runExecMock.mockImplementationOnce(async (_command: string, args: string[]) => {
      generatedConfig = fs.readFileSync(outputPath(args, "-config"), "utf8");
      fs.writeFileSync(outputPath(args, "-out"), "partial cert");
      fs.writeFileSync(outputPath(args, "-keyout"), "partial key");
      throw new Error("openssl timed out");
    });
    generatePair("retry");
    await expect(ensure()).rejects.toThrow("openssl timed out");
    expect(read()).toEqual(["stale partial cert", "stale partial key"]);
    expect(fs.readdirSync(certDir).toSorted()).toEqual(["root-ca-key.pem", "root-ca.pem"]);

    await expect(Promise.all([ensure(), ensure()])).resolves.toEqual([paths, paths]);
    expect(runExecMock).toHaveBeenCalledTimes(2);
    const [command, args, options] = runExecMock.mock.calls[0] as [string, string[], object];
    expect(command).toBe("/usr/bin/openssl");
    expect(args).toEqual(expect.arrayContaining(["req", "-extensions", "v3_ca", "-x509"]));
    expect(path.dirname(outputPath(args, "-config"))).toBe(path.dirname(outputPath(args, "-out")));
    expect(path.dirname(outputPath(args, "-out")).startsWith(`${certDir}${path.sep}`)).toBe(true);
    expect(options).toEqual({ logOutput: false, timeoutMs: 30_000 });
    expect(generatedConfig).toContain("CN = OpenClaw Debug Proxy");
    expect(generatedConfig).toContain("basicConstraints = critical, CA:TRUE");
    expect(generatedConfig).toContain("keyUsage = critical, keyCertSign, cRLSign");
  });

  it("rejects matching certificate material that is not a CA", async () => {
    const { certDir, ensure } = await makeCertPaths();
    generatePair("not-ca");

    await expect(ensure()).rejects.toThrow(
      "openssl generated invalid debug proxy certificate material",
    );

    expect(fs.readdirSync(certDir)).toEqual([]);
  });

  it("waits for a live lock owner before generating", async () => {
    const { paths, ensure } = await makeCertPaths();
    const lockPath = `${paths.keyPath}.lock`;
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, createdAt: new Date() }));
    generatePair("live-owner-retry");
    const releaseOwner = setTimeout(() => fs.rmSync(lockPath, { force: true }), 150);

    try {
      await expect(ensure()).resolves.toEqual(paths);
    } finally {
      clearTimeout(releaseOwner);
    }

    expect(runExecMock).toHaveBeenCalledTimes(1);
  });

  it("recovers when publication is interrupted between the two renames", async () => {
    const { certDir, paths, ensure, read } = await makeCertPaths("stale");
    generatePair("failed");
    generatePair("retry");
    const renameSync = fs.renameSync.bind(fs);
    const renameSpy = vi
      .spyOn(fs, "renameSync")
      .mockImplementationOnce(renameSync)
      .mockImplementationOnce((source, destination) => {
        expect(destination.toString()).toBe(paths.certPath);
        expect(source.toString()).toContain(`${path.sep}.root-ca-`);
        throw Object.assign(new Error("certificate publication failed"), { code: "EACCES" });
      });

    await expect(ensure()).rejects.toThrow("certificate publication failed");

    expect(read()).toEqual(["stale cert", "ca-material-marker:failed"]);
    expect(fs.readdirSync(certDir).toSorted()).toEqual(["root-ca-key.pem", "root-ca.pem"]);

    renameSpy.mockRestore();
    await expect(ensure()).resolves.toEqual(paths);

    expect(read()).toEqual(["ca-cert-marker:retry", "ca-material-marker:retry"]);
    expect(runExecMock).toHaveBeenCalledTimes(2);
  });
});
