// Gateway TLS runtime loads configured certificates or generates a local
// self-signed pair, returning server-ready options plus client fingerprint.
import { X509Certificate } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import tls from "node:tls";
import type { GatewayTlsConfig } from "../../config/types.gateway.js";
import { runExec } from "../../process/exec.js";
import { CONFIG_DIR, ensureDir, resolveUserPath, shortenHomeInString } from "../../utils.js";
import { FsSafeError, pathExists } from "../fs-safe.js";
import { resolveSystemBin } from "../resolve-system-bin.js";
import { readSecretFileSync } from "../secret-file.js";
import { normalizeFingerprint } from "./fingerprint.js";

// Leaf cert/key PEMs are small; match MCP client TLS (#110016).
const GATEWAY_TLS_CERT_KEY_MAX_BYTES = 64 * 1024;
// CA path is a trust bundle and may hold multiple roots; match managed proxy CA (#110032).
const GATEWAY_TLS_CA_FILE_MAX_BYTES = 256 * 1024;

function readGatewayTlsFile(params: {
  filePath: string;
  label: "cert" | "key" | "ca";
  maxBytes: number;
}): string {
  try {
    return readSecretFileSync(params.filePath, `gateway tls ${params.label} file`, {
      maxBytes: params.maxBytes,
      rejectHardlinks: false,
    });
  } catch (err) {
    if (err instanceof FsSafeError && err.code === "too-large") {
      throw new Error(`gateway tls: ${params.label} file exceeds ${params.maxBytes} bytes`, {
        cause: err,
      });
    }
    throw err;
  }
}

// Gateway TLS runtime carries loaded cert material plus the normalized SHA-256
// fingerprint advertised to clients.
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
  const opensslBin = resolveSystemBin("openssl");
  if (!opensslBin) {
    throw new Error(
      "openssl not found in trusted system directories. Install it in an OS-managed location.",
    );
  }
  // Use argv execution with a trusted system binary; certificate paths are arguments,
  // not shell text.
  await runExec(
    opensslBin,
    [
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
    ],
    { logOutput: false },
  );
  await fs.chmod(params.keyPath, 0o600).catch(() => {});
  await fs.chmod(params.certPath, 0o600).catch(() => {});
  params.log?.info?.(
    `gateway tls: generated self-signed cert at ${shortenHomeInString(params.certPath)}`,
  );
}

/** Load or generate gateway TLS material and return server-ready TLS options. */
export async function loadGatewayTlsRuntime(
  cfg: GatewayTlsConfig | undefined,
  log?: { info?: (msg: string) => void; warn?: (msg: string) => void },
): Promise<GatewayTlsRuntime> {
  if (!cfg || cfg.enabled !== true) {
    return { enabled: false, required: false };
  }

  const autoGenerate = cfg.autoGenerate !== false;
  const baseDir = path.join(CONFIG_DIR, "gateway", "tls");
  // Only blank/whitespace values fall back to the default. Any non-empty path is
  // passed through verbatim so resolveUserPath owns all normalization (it trims
  // and expands ~); trimming here would duplicate it and silently rewrite paths
  // that contain leading/trailing spaces.
  const certPath = resolveUserPath(
    typeof cfg.certPath === "string" && cfg.certPath.trim()
      ? cfg.certPath
      : path.join(baseDir, "gateway-cert.pem"),
  );
  const keyPath = resolveUserPath(
    typeof cfg.keyPath === "string" && cfg.keyPath.trim()
      ? cfg.keyPath
      : path.join(baseDir, "gateway-key.pem"),
  );
  const caPath = cfg.caPath ? resolveUserPath(cfg.caPath) : undefined;

  const hasCert = await pathExists(certPath);
  const hasKey = await pathExists(keyPath);

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

  if (!(await pathExists(certPath)) || !(await pathExists(keyPath))) {
    return {
      enabled: false,
      required: true,
      certPath,
      keyPath,
      error: "gateway tls: cert/key missing",
    };
  }

  try {
    // Bound TLS material through the shared secret-file reader (pinned regular-file
    // read + maxBytes) so pathname swaps / FIFOs cannot bypass a separate stat check.
    const cert = readGatewayTlsFile({
      filePath: certPath,
      label: "cert",
      maxBytes: GATEWAY_TLS_CERT_KEY_MAX_BYTES,
    });
    const key = readGatewayTlsFile({
      filePath: keyPath,
      label: "key",
      maxBytes: GATEWAY_TLS_CERT_KEY_MAX_BYTES,
    });
    const ca = caPath
      ? readGatewayTlsFile({
          filePath: caPath,
          label: "ca",
          maxBytes: GATEWAY_TLS_CA_FILE_MAX_BYTES,
        })
      : undefined;
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
    const message = err instanceof Error ? err.message : String(err);
    return {
      enabled: false,
      required: true,
      certPath,
      keyPath,
      caPath,
      // Preserve role-specific size errors from readGatewayTlsFile; wrap everything else.
      error: message.startsWith("gateway tls:")
        ? message
        : `gateway tls: failed to load cert (${message})`,
    };
  }
}
