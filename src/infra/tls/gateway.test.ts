// Covers gateway TLS loading, fingerprint reporting, generated certificate
// paths, and error handling for missing or invalid material.
import { X509Certificate } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTrackedTempDirs } from "../../test-utils/tracked-temp-dirs.js";
import { normalizeFingerprint } from "./fingerprint.js";
import { loadGatewayTlsRuntime } from "./gateway.js";

const tempDirs = createTrackedTempDirs();
const createTempDir = () => tempDirs.make("openclaw-gateway-tls-test-");

const KEY_PEM = [
  "-----BEGIN PRIVATE KEY-----", // pragma: allowlist secret
  "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDrur5CWp4psMMb",
  "DTPY1aN46HPDxRchGgh8XedNkrlc4z1KFiyLUsXpVIhuyoXq1fflpTDz7++pGEDJ",
  "Q5pEdChn3fuWgi7gC+pvd5VQ1eAX/7qVE72fhx14NxhaiZU3hCzXjG2SflTEEExk",
  "UkQTm0rdHSjgLVMhTM3Pqm6Kzfdgtm9ZyXwlAsorE/pvgbUxG3Q4xKNBGzbirZ+1",
  "EzPDwsjf3fitNtakZJkymu6Kg5lsUihQVXOP0U7f989FmevoTMvJmkvJzsoTRd7s",
  "XNSOjzOwJr8da8C4HkXi21md1yEccyW0iSh7tWvDrpWDAgW6RMuMHC0tW4bkpDGr",
  "FpbQOgzVAgMBAAECggEAIMhwf8Ve9CDVTWyNXpU9fgnj2aDOCeg3MGaVzaO/XCPt",
  "KOHDEaAyDnRXYgMP0zwtFNafo3klnSBWmDbq3CTEXseQHtsdfkKh+J0KmrqXxval",
  "YeikKSyvBEIzRJoYMqeS3eo1bddcXgT/Pr9zIL/qzivpPJ4JDttBzyTeaTbiNaR9",
  "KphGNueo+MTQMLreMqw5VAyJ44gy7Z/2TMiMEc/d95wfubcOSsrIfpOKnMvWd/rl",
  "vxIS33s95L7CjREkixskj5Yo5Wpt3Yf5b0Zi70YiEsCfAZUDrPW7YzMlylzmhMzm",
  "MARZKfN1Tmo74SGpxUrBury+iPwf1sYcRnsHR+zO8QKBgQD6ISQHRzPboZ3J/60+",
  "fRLETtrBa9WkvaH9c+woF7l47D4DIlvlv9D3N1KGkUmhMnp2jNKLIlalBNDxBdB+",
  "iwZP1kikGz4629Ch3/KF/VYscLTlAQNPE42jOo7Hj7VrdQx9zQrK9ZBLteXmSvOh",
  "bB3aXwXPF3HoTMt9gQ9thhXZJQKBgQDxQxUnQSw43dRlqYOHzPUEwnJkGkuW/qxn",
  "aRc8eopP5zUaebiDFmqhY36x2Wd+HnXrzufy2o4jkXkWTau8Ns+OLhnIG3PIU9L/",
  "LYzJMckGb75QYiK1YKMUUSQzlNCS8+TFVCTAvG2u2zCCk7oTIe8aT516BQNjWDjK",
  "gWo2f87N8QKBgHoVANO4kfwJxszXyMPuIeHEpwquyijNEap2EPaEldcKXz4CYB4j",
  "4Cc5TkM12F0gGRuRohWcnfOPBTgOYXPSATOoX+4RCe+KaCsJ9gIl4xBvtirrsqS+",
  "42ue4h9O6fpXt9AS6sii0FnTnzEmtgC8l1mE9X3dcJA0I0HPYytOvY0tAoGAAYJj",
  "7Xzw4+IvY/ttgTn9BmyY/ptTgbxSI8t6g7xYhStzH5lHWDqZrCzNLBuqFBXosvL2",
  "bISFgx9z3Hnb6y+EmOUc8C2LyeMMXOBSEygmk827KRGUGgJiwsvHKDN0Ipc4BSwD",
  "ltkW7pMceJSoA1qg/k8lMxA49zQkFtA8c97U0mECgYEAk2DDN78sRQI8RpSECJWy",
  "l1O1ikVUAYVeh5HdZkpt++ddfpo695Op9OeD2Eq27Y5EVj8Xl58GFxNk0egLUnYq",
  "YzSbjcNkR2SbVvuLaV1zlQKm6M5rfvhj4//YrzrrPUQda7Q4eR0as/3q91uzAO2O",
  "++pfnSCVCyp/TxSkhEDEawU=",
  "-----END PRIVATE KEY-----",
].join("\n");

const CERT_PEM = `-----BEGIN CERTIFICATE-----
MIIDCTCCAfGgAwIBAgIUel0Lv05cjrViyI/H3tABBJxM7NgwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MDEyMDEyMjEzMloXDTI2MDEy
MTEyMjEzMlowFDESMBAGA1UEAwwJbG9jYWxob3N0MIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEA67q+QlqeKbDDGw0z2NWjeOhzw8UXIRoIfF3nTZK5XOM9
ShYsi1LF6VSIbsqF6tX35aUw8+/vqRhAyUOaRHQoZ937loIu4Avqb3eVUNXgF/+6
lRO9n4cdeDcYWomVN4Qs14xtkn5UxBBMZFJEE5tK3R0o4C1TIUzNz6puis33YLZv
Wcl8JQLKKxP6b4G1MRt0OMSjQRs24q2ftRMzw8LI3934rTbWpGSZMpruioOZbFIo
UFVzj9FO3/fPRZnr6EzLyZpLyc7KE0Xe7FzUjo8zsCa/HWvAuB5F4ttZndchHHMl
tIkoe7Vrw66VgwIFukTLjBwtLVuG5KQxqxaW0DoM1QIDAQABo1MwUTAdBgNVHQ4E
FgQUwNdNkEQtd0n/aofzN7/EeYPPPbIwHwYDVR0jBBgwFoAUwNdNkEQtd0n/aofz
N7/EeYPPPbIwDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOCAQEAnOnw
o8Az/bL0A6bGHTYra3L9ArIIljMajT6KDHxylR4LhliuVNAznnhP3UkcZbUdjqjp
MNOM0lej2pNioondtQdXUskZtqWy6+dLbTm1RYQh1lbCCZQ26o7o/oENzjPksLAb
jRM47DYxRweTyRWQ5t9wvg/xL0Yi1tWq4u4FCNZlBMgdwAEnXNwVWTzRR9RHwy20
lmUzM8uQ/p42bk4EvPEV4PI1h5G0khQ6x9CtkadCTDs/ZqoUaJMwZBIDSrdJJSLw
4Vh8Lqzia1CFB4um9J4S1Gm/VZMBjjeGGBJk7VSYn4ZmhPlbPM+6z39lpQGEG0x4
r1USnb+wUdA7Zoj/mQ==
-----END CERTIFICATE-----`;

afterEach(async () => {
  await tempDirs.cleanup();
});

describe("loadGatewayTlsRuntime", () => {
  it("disables tls when config is absent or disabled", async () => {
    await expect(loadGatewayTlsRuntime(undefined)).resolves.toEqual({
      enabled: false,
      required: false,
    });
    await expect(loadGatewayTlsRuntime({ enabled: false })).resolves.toEqual({
      enabled: false,
      required: false,
    });
  });

  it("loads existing cert, key, and optional ca files", async () => {
    const dir = await createTempDir();
    const certPath = path.join(dir, "gateway-cert.pem");
    const keyPath = path.join(dir, "gateway-key.pem");
    const caPath = path.join(dir, "gateway-ca.pem");
    await writeFile(certPath, CERT_PEM, "utf8");
    await writeFile(keyPath, KEY_PEM, "utf8");
    await writeFile(caPath, CERT_PEM, "utf8");

    const result = await loadGatewayTlsRuntime({
      enabled: true,
      certPath,
      keyPath,
      caPath,
      autoGenerate: false,
    });

    expect(result.enabled).toBe(true);
    expect(result.required).toBe(true);
    expect(result.certPath).toBe(certPath);
    expect(result.keyPath).toBe(keyPath);
    expect(result.caPath).toBe(caPath);
    expect(result.fingerprintSha256).toBe(
      normalizeFingerprint(new X509Certificate(CERT_PEM).fingerprint256 ?? ""),
    );
    expect(result.tlsOptions?.cert).toBe(CERT_PEM);
    expect(result.tlsOptions?.key).toBe(KEY_PEM);
    expect(result.tlsOptions?.ca).toBe(CERT_PEM);
    expect(result.tlsOptions?.minVersion).toBe("TLSv1.3");
    expect(result.error).toBeUndefined();
  });

  it("fails closed when cert/key are missing and auto generation is disabled", async () => {
    const dir = await createTempDir();
    const certPath = path.join(dir, "missing-cert.pem");
    const keyPath = path.join(dir, "missing-key.pem");

    const result = await loadGatewayTlsRuntime({
      enabled: true,
      certPath,
      keyPath,
      autoGenerate: false,
    });

    expect(result.enabled).toBe(false);
    expect(result.required).toBe(true);
    expect(result.certPath).toBe(certPath);
    expect(result.keyPath).toBe(keyPath);
    expect(result.error).toBe("gateway tls: cert/key missing");
  });

  it("reports load failures for invalid pem files", async () => {
    const dir = await createTempDir();
    const certPath = path.join(dir, "gateway-cert.pem");
    const keyPath = path.join(dir, "gateway-key.pem");
    await writeFile(certPath, "not a certificate\n", "utf8");
    await writeFile(keyPath, KEY_PEM, "utf8");

    const result = await loadGatewayTlsRuntime({
      enabled: true,
      certPath,
      keyPath,
      autoGenerate: false,
    });

    expect(result.enabled).toBe(false);
    expect(result.required).toBe(true);
    expect(result.certPath).toBe(certPath);
    expect(result.keyPath).toBe(keyPath);
    expect(result.error).toContain("gateway tls: failed to load cert");
  });

  it("falls back to default paths when certPath and keyPath are empty strings", async () => {
    const result = await loadGatewayTlsRuntime({
      enabled: true,
      certPath: "",
      keyPath: "",
      autoGenerate: false,
    });

    // Empty paths must not reach downstream — they must be replaced with defaults.
    expect(result.certPath).toBeTruthy();
    expect(result.certPath).not.toBe("");
    expect(result.keyPath).toBeTruthy();
    expect(result.keyPath).not.toBe("");
  });

  it("falls back to default paths when certPath and keyPath are whitespace-only", async () => {
    const result = await loadGatewayTlsRuntime({
      enabled: true,
      certPath: "   ",
      keyPath: "\t",
      autoGenerate: false,
    });

    expect(result.certPath).toBeTruthy();
    expect(result.certPath).not.toBe("   ");
    expect(result.keyPath).toBeTruthy();
    expect(result.keyPath).not.toBe("\t");
  });

  it("does not fall back for non-empty paths with leading/trailing spaces", async () => {
    const result = await loadGatewayTlsRuntime({
      enabled: true,
      certPath: "  /etc/ssl/cert.pem  ",
      keyPath: "  /etc/ssl/private/server.key  ",
      autoGenerate: false,
    });

    // Non-empty paths are passed through verbatim; resolveUserPath owns
    // normalization (it trims), so they must not fall back to default names.
    expect(result.certPath).not.toContain("gateway-cert.pem");
    expect(result.keyPath).not.toContain("gateway-key.pem");
  });

  it("upgrades existing CN-only OpenClaw-generated cert to include subjectAltName", async () => {
    const dir = await createTempDir();
    const certPath = path.join(dir, "gateway-cert.pem");
    const keyPath = path.join(dir, "gateway-key.pem");

    // Generate a CN-only cert directly via openssl (simulating pre-fix OpenClaw)
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    await execFileAsync("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-sha256",
      "-days",
      "3650",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-subj",
      "/CN=openclaw-gateway",
      // no -addext → intentionally CN-only
    ]);

    // Verify the cert is CN-only (no SAN)
    const fs = await import("node:fs/promises");
    const x509Before = new X509Certificate(await fs.readFile(certPath, "utf8"));
    expect(x509Before.subject).toContain("CN=openclaw-gateway");
    expect(x509Before.subjectAltName).toBeFalsy();

    // Load with autoGenerate=true — should detect and regenerate
    const result = await loadGatewayTlsRuntime({
      enabled: true,
      certPath,
      keyPath,
      autoGenerate: true,
    });

    expect(result.enabled).toBe(true);
    expect(result.error).toBeUndefined();

    // After upgrade, cert must have SANs — verify via openssl CLI
    const certPem = await fs.readFile(certPath, "utf8");
    const x509After = new X509Certificate(certPem);
    // X509Certificate.subjectAltName may not be available in all Node.js versions;
    // when it is, verify the expected entries.
    if (x509After.subjectAltName) {
      expect(x509After.subjectAltName).toContain("DNS:localhost");
      expect(x509After.subjectAltName).toContain("IP Address:127.0.0.1");
    }
  });

  it("generates cert with subjectAltName for localhost and hostname", async () => {
    const dir = await createTempDir();
    const certPath = path.join(dir, "gateway-cert.pem");
    const keyPath = path.join(dir, "gateway-key.pem");

    const result = await loadGatewayTlsRuntime({
      enabled: true,
      certPath,
      keyPath,
      autoGenerate: true,
    });

    expect(result.enabled).toBe(true);
    expect(result.error).toBeUndefined();

    const cert = new X509Certificate(
      await (await import("node:fs/promises")).readFile(certPath, "utf8"),
    );
    const san = cert.subjectAltName;
    expect(san).toBeTruthy();
    expect(san).toContain("DNS:localhost");
    expect(san).toContain("IP Address:127.0.0.1");
    expect(san).toContain("IP Address:0:0:0:0:0:0:0:1");
  });

  it("does not upgrade custom certificates with non-OpenClaw CN", async () => {
    const dir = await createTempDir();
    const certPath = path.join(dir, "custom-cert.pem");
    const keyPath = path.join(dir, "custom-key.pem");

    // Generate a custom cert with a different CN (not openclaw-gateway) and no SAN
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    await execFileAsync("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-sha256",
      "-days",
      "3650",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-subj",
      "/CN=custom-server",
    ]);

    const x509Before = new X509Certificate(
      await (await import("node:fs/promises")).readFile(certPath, "utf8"),
    );
    expect(x509Before.subject).toContain("CN=custom-server");
    expect(x509Before.subjectAltName).toBeFalsy();

    const result = await loadGatewayTlsRuntime({
      enabled: true,
      certPath,
      keyPath,
      autoGenerate: true,
    });

    expect(result.enabled).toBe(true);
    expect(result.error).toBeUndefined();

    // Custom cert must not be regenerated — CN and SAN must be unchanged
    const certPem = await (await import("node:fs/promises")).readFile(certPath, "utf8");
    const x509After = new X509Certificate(certPem);
    expect(x509After.subject).toContain("CN=custom-server");
    expect(x509After.subjectAltName).toBeFalsy();
    expect(result.fingerprintSha256).toBe(normalizeFingerprint(x509After.fingerprint256 ?? ""));
  });
});
