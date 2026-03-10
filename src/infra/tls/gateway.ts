import { execFile } from "node:child_process";
import { X509Certificate } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import tls from "node:tls";
import { promisify } from "node:util";
import type { GatewayTlsConfig } from "../../config/types.gateway.js";
import { CONFIG_DIR, ensureDir, resolveUserPath, shortenHomeInString } from "../../utils.js";
import { resolveExecutablePath } from "../executable-path.js";
import { normalizeFingerprint } from "./fingerprint.js";

const execFileAsync = promisify(execFile);

export type GatewayTlsRuntime = {
  enabled: boolean;
  required: boolean;
  certPath?: string;
  keyPath?: string;
  caPath?: string;
  fingerprintSha256?: string;
  tlsOptions?: tls.TlsOptions;
  error?: string;
};

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

const OPENSSL_UNIX_CANDIDATES = [
  "/usr/bin/openssl",
  "/usr/local/bin/openssl",
  "/opt/homebrew/bin/openssl",
  "/opt/homebrew/opt/openssl@3/bin/openssl",
  "/usr/local/opt/openssl@3/bin/openssl",
  "/opt/local/bin/openssl",
  "/usr/sbin/openssl",
  "/sbin/openssl",
];

function resolveOpenSslSearchPath(): string {
  const dirs = new Set<string>();
  for (const candidate of OPENSSL_UNIX_CANDIDATES) {
    dirs.add(path.dirname(candidate));
  }
  return Array.from(dirs).join(path.delimiter);
}

function getWindowsOpenSslCandidates(): string[] {
  const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
  const programFilesX86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  return [
    path.join(programFiles, "OpenSSL-Win64", "bin", "openssl.exe"),
    path.join(programFiles, "OpenSSL-Win32", "bin", "openssl.exe"),
    path.join(programFiles, "Git", "usr", "bin", "openssl.exe"),
    path.join(programFilesX86, "OpenSSL-Win32", "bin", "openssl.exe"),
    path.join(programFilesX86, "Git", "usr", "bin", "openssl.exe"),
  ];
}

async function resolveOpenSslPath(): Promise<string | undefined> {
  if (process.platform === "win32") {
    for (const candidate of getWindowsOpenSslCandidates()) {
      if (await fileExists(candidate)) {
        return candidate;
      }
    }
    return resolveExecutablePath("openssl");
  }

  for (const candidate of OPENSSL_UNIX_CANDIDATES) {
    if (await fileExists(candidate)) {
      return candidate;
    }
  }
  return resolveExecutablePath("openssl", { env: { PATH: resolveOpenSslSearchPath() } });
}

async function generateSelfSignedCert(params: {
  certPath: string;
  keyPath: string;
  log?: { info?: (msg: string) => void };
}): Promise<void> {
  const certDir = path.dirname(params.certPath);
  const keyDir = path.dirname(params.keyPath);
  await ensureDir(certDir);
  if (keyDir !== certDir) {
    await ensureDir(keyDir);
  }
  const opensslPath = await resolveOpenSslPath();
  if (!opensslPath) {
    throw new Error("openssl not found in common locations");
  }
  await execFileAsync(opensslPath, [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-sha256",
    "-days",
    "3650",
    "-nodes",
    "-keyout",
    params.keyPath,
    "-out",
    params.certPath,
    "-subj",
    "/CN=openclaw-gateway",
  ]);
  await fs.chmod(params.keyPath, 0o600).catch(() => {});
  await fs.chmod(params.certPath, 0o600).catch(() => {});
  params.log?.info?.(
    `gateway tls: generated self-signed cert at ${shortenHomeInString(params.certPath)}`,
  );
}

export async function loadGatewayTlsRuntime(
  cfg: GatewayTlsConfig | undefined,
  log?: { info?: (msg: string) => void; warn?: (msg: string) => void },
): Promise<GatewayTlsRuntime> {
  if (!cfg || cfg.enabled !== true) {
    return { enabled: false, required: false };
  }

  const autoGenerate = cfg.autoGenerate !== false;
  const baseDir = path.join(CONFIG_DIR, "gateway", "tls");
  const certPath = resolveUserPath(cfg.certPath ?? path.join(baseDir, "gateway-cert.pem"));
  const keyPath = resolveUserPath(cfg.keyPath ?? path.join(baseDir, "gateway-key.pem"));
  const caPath = cfg.caPath ? resolveUserPath(cfg.caPath) : undefined;

  const hasCert = await fileExists(certPath);
  const hasKey = await fileExists(keyPath);

  if (!hasCert && !hasKey && autoGenerate) {
    try {
      await generateSelfSignedCert({ certPath, keyPath, log });
    } catch (err) {
      return {
        enabled: false,
        required: true,
        certPath,
        keyPath,
        error: `gateway tls: failed to generate cert (${String(err)})`,
      };
    }
  }

  if (!(await fileExists(certPath)) || !(await fileExists(keyPath))) {
    return {
      enabled: false,
      required: true,
      certPath,
      keyPath,
      error: "gateway tls: cert/key missing",
    };
  }

  try {
    const cert = await fs.readFile(certPath, "utf8");
    const key = await fs.readFile(keyPath, "utf8");
    const ca = caPath ? await fs.readFile(caPath, "utf8") : undefined;
    const x509 = new X509Certificate(cert);
    const fingerprintSha256 = normalizeFingerprint(x509.fingerprint256 ?? "");

    if (!fingerprintSha256) {
      return {
        enabled: false,
        required: true,
        certPath,
        keyPath,
        caPath,
        error: "gateway tls: unable to compute certificate fingerprint",
      };
    }

    return {
      enabled: true,
      required: true,
      certPath,
      keyPath,
      caPath,
      fingerprintSha256,
      tlsOptions: {
        cert,
        key,
        ca,
        minVersion: "TLSv1.3",
      },
    };
  } catch (err) {
    return {
      enabled: false,
      required: true,
      certPath,
      keyPath,
      caPath,
      error: `gateway tls: failed to load cert (${String(err)})`,
    };
  }
}
