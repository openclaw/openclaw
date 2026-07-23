// Tests bounded CA file reads for managed proxy TLS trust loading.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadManagedProxyTlsOptions, loadManagedProxyTlsOptionsSync } from "./proxy-tls.js";

describe("managed proxy TLS CA file reads", () => {
  let tmpDir = "";

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "openclaw-proxy-tls-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns undefined when no CA file is given (async)", async () => {
    await expect(loadManagedProxyTlsOptions(undefined)).resolves.toBeUndefined();
  });

  it("returns undefined when no CA file is given (sync)", () => {
    expect(loadManagedProxyTlsOptionsSync(undefined)).toBeUndefined();
  });

  it("loads a normal CA bundle (sync)", () => {
    const caPath = path.join(tmpDir, "ca.pem");
    writeFileSync(caPath, "-----BEGIN CERTIFICATE-----\nMIIBdummy\n-----END CERTIFICATE-----\n");
    const result = loadManagedProxyTlsOptionsSync(caPath);
    expect(result?.ca).toContain("BEGIN CERTIFICATE");
  });

  it("loads a normal CA bundle (async)", async () => {
    const caPath = path.join(tmpDir, "ca.pem");
    writeFileSync(caPath, "-----BEGIN CERTIFICATE-----\nMIIBdummy\n-----END CERTIFICATE-----\n");
    const result = await loadManagedProxyTlsOptions(caPath);
    expect(result?.ca).toContain("BEGIN CERTIFICATE");
  });

  it("rejects a CA file exceeding the byte read limit (sync)", () => {
    // 256 KiB limit mirrors MANAGED_PROXY_CA_FILE_MAX_BYTES in the source module.
    const limit = 256 * 1024;
    const caPath = path.join(tmpDir, "oversized-ca.pem");
    writeFileSync(caPath, "x".repeat(limit + 1));
    expect(() => loadManagedProxyTlsOptionsSync(caPath)).toThrow(/proxy CA file/);
  });

  it("rejects a CA file exceeding the byte read limit (async)", async () => {
    const limit = 256 * 1024;
    const caPath = path.join(tmpDir, "oversized-ca.pem");
    writeFileSync(caPath, "x".repeat(limit + 1));
    await expect(loadManagedProxyTlsOptions(caPath)).rejects.toThrow(/proxy CA file/);
  });

  it("loads a CA file just under the byte read limit", () => {
    const limit = 256 * 1024;
    const caPath = path.join(tmpDir, "ca.pem");
    const content = "-----BEGIN CERTIFICATE-----\nMIIBdummy\n-----END CERTIFICATE-----\n";
    writeFileSync(caPath, content + "x".repeat(limit - content.length - 1));
    const result = loadManagedProxyTlsOptionsSync(caPath);
    expect(result?.ca).toContain("BEGIN CERTIFICATE");
  });
});
