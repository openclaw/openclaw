import { X509Certificate } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { TEST_TLS_KEY_PEM } from "../../test/helpers/tls-fixture.js";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";

const runExecMock = vi.hoisted(() => vi.fn());

// mock-isolation: Keep CA generation independent of host OpenSSL discovery.
vi.mock("../infra/resolve-system-bin.js", () => ({ resolveSystemBin: () => "/usr/bin/openssl" }));
vi.mock("../process/exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../process/exec.js")>()),
  runExec: runExecMock,
}));

import { ensureDebugProxyCa } from "./ca.js";

const tempDirs = createTrackedTempDirs();
const caCert = fs.readFileSync(
  new URL("./fixtures/retained-ca-no-key-identifiers.pem", import.meta.url),
  "utf8",
);
// PEM whitespace distinguishes interrupted/retried writes without a fake crypto parser.
const pair = (marker: string) =>
  [caCert, TEST_TLS_KEY_PEM].map((pem) => pem + "\n".repeat(marker.length));

function outputPath(args: string[], flag: "-config" | "-keyout" | "-out"): string {
  const value = args[args.indexOf(flag) + 1];
  if (!value) {
    throw new Error(`missing ${flag} output path`);
  }
  return value;
}

function generatePair(marker: string, afterWrite?: (args: string[]) => void): void {
  runExecMock.mockImplementationOnce(async (_command: string, args: string[]) => {
    const [cert, key] = pair(marker);
    fs.writeFileSync(outputPath(args, "-out"), cert!);
    fs.writeFileSync(outputPath(args, "-keyout"), key!);
    afterWrite?.(args);
  });
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

afterEach(async () => {
  vi.restoreAllMocks();
  runExecMock.mockReset();
  await tempDirs.cleanup();
});

it.each(["generation", "publication"] as const)("repairs interrupted CA %s", async (stage) => {
  const { certDir, paths, ensure, read } = await makeCertPaths("stale");
  const failure = Object.assign(new Error(`${stage} interrupted`), { code: "EACCES" });
  let generatedConfig = "";
  generatePair("failed", (args) => {
    generatedConfig = fs.readFileSync(outputPath(args, "-config"), "utf8");
    if (stage === "generation") {
      throw failure;
    }
  });
  generatePair("retry");
  const renameSync = fs.renameSync.bind(fs);
  const renameSpy =
    stage === "publication"
      ? vi
          .spyOn(fs, "renameSync")
          .mockImplementationOnce(renameSync)
          .mockImplementationOnce((source, destination) => {
            expect(destination.toString()).toBe(paths.certPath);
            expect(source.toString()).toContain(`${path.sep}.root-ca-`);
            throw failure;
          })
      : undefined;
  await expect(ensure()).rejects.toBe(failure);
  expect(read()).toEqual(["stale cert", stage === "publication" ? pair("failed")[1] : "stale key"]);
  expect(fs.readdirSync(certDir).toSorted()).toEqual(["root-ca-key.pem", "root-ca.pem"]);
  renameSpy?.mockRestore();
  await expect(Promise.all([ensure(), ensure()])).resolves.toEqual([paths, paths]);
  expect(read()).toEqual(pair("retry"));
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
  vi.spyOn(X509Certificate.prototype, "ca", "get").mockReturnValue(false);
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
