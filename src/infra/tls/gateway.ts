// Gateway TLS runtime loads configured certificates or generates a local
// self-signed pair, returning server-ready options plus client fingerprint.
import { X509Certificate } from "node:crypto";
import fsSync, { type Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import tls from "node:tls";
import type { GatewayTlsConfig } from "../../config/types.gateway.js";
import { runExec } from "../../process/exec.js";
import { CONFIG_DIR, ensureDir, resolveUserPath, shortenHomeInString } from "../../utils.js";
import { sameFileIdentity } from "../fs-safe-advanced.js";
import { pathExists } from "../fs-safe.js";
import { resolveSystemBin } from "../resolve-system-bin.js";
import { normalizeFingerprint } from "./fingerprint.js";

const GATEWAY_TLS_CERT_GENERATION_TIMEOUT_MS = 30_000;

type GeneratedTlsOutput = {
  finalPath: string;
  identity: Stats;
  published: boolean;
  stagedPath: string;
};

function removePublishedOutputIfOwned(output: GeneratedTlsOutput): void {
  if (!output.published) {
    return;
  }
  try {
    const current = fsSync.lstatSync(output.finalPath);
    if (sameFileIdentity(output.identity, current)) {
      fsSync.unlinkSync(output.finalPath);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

async function publishGeneratedTlsOutputs(outputs: GeneratedTlsOutput[]): Promise<void> {
  try {
    for (const output of outputs) {
      await fs.link(output.stagedPath, output.finalPath);
      output.published = true;
    }
  } catch (error) {
    for (const output of outputs.toReversed()) {
      removePublishedOutputIfOwned(output);
    }
    throw error;
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
  const certStageDir = await fs.mkdtemp(path.join(certDir, ".openclaw-gateway-tls-cert-"));
  const stagedCertPath = path.join(certStageDir, "cert.pem");
  let keyStageDir: string | undefined;
  try {
    keyStageDir = await fs.mkdtemp(path.join(keyDir, ".openclaw-gateway-tls-key-"));
    const stagedKeyPath = path.join(keyStageDir, "key.pem");
    await Promise.all([fs.chmod(certStageDir, 0o700), fs.chmod(keyStageDir, 0o700)]);
    // OpenSSL never sees the configured final paths, so timeout and generation
    // failures cannot strand a half-written certificate pair there.
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
        stagedKeyPath,
        "-out",
        stagedCertPath,
        "-subj",
        "/CN=openclaw-gateway",
      ],
      {
        logOutput: false,
        timeoutMs: GATEWAY_TLS_CERT_GENERATION_TIMEOUT_MS,
      },
    );
    await Promise.all([fs.chmod(stagedKeyPath, 0o600), fs.chmod(stagedCertPath, 0o600)]);
    const [cert, key, certIdentity, keyIdentity] = await Promise.all([
      fs.readFile(stagedCertPath, "utf8"),
      fs.readFile(stagedKeyPath, "utf8"),
      fs.lstat(stagedCertPath),
      fs.lstat(stagedKeyPath),
    ]);
    tls.createSecureContext({ cert, key, minVersion: "TLSv1.3" });
    await publishGeneratedTlsOutputs([
      {
        finalPath: params.certPath,
        identity: certIdentity,
        published: false,
        stagedPath: stagedCertPath,
      },
      {
        finalPath: params.keyPath,
        identity: keyIdentity,
        published: false,
        stagedPath: stagedKeyPath,
      },
    ]);
    params.log?.info?.(
      `gateway tls: generated self-signed cert at ${shortenHomeInString(params.certPath)}`,
    );
  } finally {
    await Promise.allSettled(
      [certStageDir, keyStageDir]
        .filter((dir): dir is string => Boolean(dir))
        .map((dir) => fs.rm(dir, { force: true, recursive: true })),
    );
  }
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
