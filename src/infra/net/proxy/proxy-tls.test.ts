// Managed proxy CA file reads stay bounded and refuse to wait on a writer.
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it, onTestFinished } from "vitest";
import { loadManagedProxyTlsOptions, loadManagedProxyTlsOptionsSync } from "./proxy-tls.js";

const execFileAsync = promisify(execFile);
const moduleUrl = pathToFileURL(fileURLToPath(new URL("./proxy-tls.ts", import.meta.url))).href;

// Mirrors MANAGED_PROXY_CA_FILE_MAX_BYTES in the source module.
const MAX_BYTES = 4 * 1024 * 1024;
const PEM = "-----BEGIN CERTIFICATE-----\nMIIBdummy\n-----END CERTIFICATE-----\n";
// A real root certificate is ~1.6 KiB; a full system trust bundle is ~130 of them
// (~205 KiB on this machine's EL system bundle). Existing deployments at this scale
// must keep loading after this change.
const PEM_ROOT = `-----BEGIN CERTIFICATE-----\n${"A".repeat(1576)}\n-----END CERTIFICATE-----\n`;
const SYSTEM_TRUST_SCALE_CERTS = 130;

function tempPath(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("managed proxy CA file reads", () => {
  it("returns undefined when no CA file is given (async)", async () => {
    await expect(loadManagedProxyTlsOptions(undefined)).resolves.toBeUndefined();
  });

  it("returns undefined when no CA file is given (sync)", () => {
    expect(loadManagedProxyTlsOptionsSync(undefined)).toBeUndefined();
  });

  it("loads a normal CA bundle (async)", async () => {
    const directory = await tempPath("proxy-ca-normal-async-");
    onTestFinished(() => fs.rm(directory, { recursive: true, force: true }));
    const caPath = path.join(directory, "ca.pem");
    await fs.writeFile(caPath, PEM);
    const result = await loadManagedProxyTlsOptions(caPath);
    expect(result?.ca).toContain("BEGIN CERTIFICATE");
  });

  it("loads a normal CA bundle (sync)", async () => {
    const directory = await tempPath("proxy-ca-normal-sync-");
    onTestFinished(() => fs.rm(directory, { recursive: true, force: true }));
    const caPath = path.join(directory, "ca.pem");
    await fs.writeFile(caPath, PEM);
    const result = loadManagedProxyTlsOptionsSync(caPath);
    expect(result?.ca).toContain("BEGIN CERTIFICATE");
  });

  it("loads a symlinked regular CA bundle (async)", async () => {
    const directory = await tempPath("proxy-ca-symlink-");
    onTestFinished(() => fs.rm(directory, { recursive: true, force: true }));
    const caPath = path.join(directory, "ca.pem");
    const linkPath = path.join(directory, "ca-link.pem");
    await fs.writeFile(caPath, PEM);
    await fs.symlink(caPath, linkPath);
    const result = await loadManagedProxyTlsOptions(linkPath);
    expect(result?.ca).toContain("BEGIN CERTIFICATE");
  });

  it("rejects an empty CA file (async)", async () => {
    const directory = await tempPath("proxy-ca-empty-async-");
    onTestFinished(() => fs.rm(directory, { recursive: true, force: true }));
    const caPath = path.join(directory, "empty.pem");
    await fs.writeFile(caPath, "");
    await expect(loadManagedProxyTlsOptions(caPath)).rejects.toThrow(/proxy CA file/);
  });

  it("loads a system-trust-scale multi-root bundle (~130 roots, async)", async () => {
    const directory = await tempPath("proxy-ca-trust-scale-");
    onTestFinished(() => fs.rm(directory, { recursive: true, force: true }));
    const caPath = path.join(directory, "system-trust.pem");
    await fs.writeFile(caPath, PEM_ROOT.repeat(SYSTEM_TRUST_SCALE_CERTS));
    const result = await loadManagedProxyTlsOptions(caPath);
    expect(result?.ca).toContain("BEGIN CERTIFICATE");
    expect(result?.ca?.length).toBeGreaterThan(200 * 1024);
  });

  it("rejects a CA file exceeding the byte read limit (async)", async () => {
    const directory = await tempPath("proxy-ca-oversized-async-");
    onTestFinished(() => fs.rm(directory, { recursive: true, force: true }));
    const caPath = path.join(directory, "oversized.pem");
    await fs.writeFile(caPath, "x".repeat(MAX_BYTES + 1));
    await expect(loadManagedProxyTlsOptions(caPath)).rejects.toThrow(/proxy CA file/);
  });

  it("rejects a CA file exceeding the byte read limit (sync)", async () => {
    const directory = await tempPath("proxy-ca-oversized-sync-");
    onTestFinished(() => fs.rm(directory, { recursive: true, force: true }));
    const caPath = path.join(directory, "oversized.pem");
    await fs.writeFile(caPath, "x".repeat(MAX_BYTES + 1));
    expect(() => loadManagedProxyTlsOptionsSync(caPath)).toThrow(/proxy CA file/);
  });

  it("loads a CA file just under the byte read limit (sync)", async () => {
    const directory = await tempPath("proxy-ca-boundary-");
    onTestFinished(() => fs.rm(directory, { recursive: true, force: true }));
    const caPath = path.join(directory, "boundary.pem");
    await fs.writeFile(caPath, PEM + "x".repeat(MAX_BYTES - PEM.length - 1));
    const result = loadManagedProxyTlsOptionsSync(caPath);
    expect(result?.ca).toContain("BEGIN CERTIFICATE");
  });

  it.skipIf(process.platform === "win32")(
    "rejects a FIFO without waiting for a writer (async)",
    { timeout: 3_000 },
    async () => {
      const directory = await tempPath("proxy-ca-fifo-async-");
      const fifoPath = path.join(directory, "ca.pipe");
      const setup = execFileAsync("mkfifo", [fifoPath]);
      const reading = setup.then(() => loadManagedProxyTlsOptions(fifoPath));
      onTestFinished(async () => {
        try {
          if (
            await setup.then(
              () => true,
              () => false,
            )
          ) {
            // Release a regressed blocking open after the test's own deadline. Close the
            // write end first so a pending read reaches EOF and can settle on its own.
            const release = await fs.open(fifoPath, fs.constants.O_RDWR | fs.constants.O_NONBLOCK);
            await release.close();
            await reading.catch(() => undefined);
          }
        } finally {
          await fs.rm(directory, { recursive: true, force: true });
        }
      });
      await expect(reading).rejects.toThrow(/proxy CA file/);
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects a FIFO without waiting for a writer (sync, in a child process)",
    { timeout: 15_000 },
    async () => {
      const directory = await tempPath("proxy-ca-fifo-sync-");
      onTestFinished(() => fs.rm(directory, { recursive: true, force: true }));
      const fifoPath = path.join(directory, "ca.pipe");
      await execFileAsync("mkfifo", [fifoPath]);
      const script = [
        `const { loadManagedProxyTlsOptionsSync } = await import(${JSON.stringify(moduleUrl)});`,
        `const result = loadManagedProxyTlsOptionsSync(process.argv[1]);`,
        `process.stdout.write(String(result?.ca?.length ?? 0));`,
      ].join("\n");
      const failure = await execFileAsync(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "-e", script, fifoPath],
        { timeout: 5_000, encoding: "utf8" },
      ).then(
        () => undefined,
        (error: unknown) => error as NodeJS.ErrnoException & { stderr?: string; killed?: boolean },
      );
      expect(failure, "the sync loader must refuse the FIFO").toBeTruthy();
      expect(
        failure?.killed,
        "the child must fail on its own, not by the hard timeout",
      ).toBeFalsy();
      expect(failure?.stderr ?? "").toMatch(/proxy CA file/);
    },
  );
});
