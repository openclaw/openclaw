// Gateway TLS runtime loads configured certificates or generates a local
// self-signed pair, returning server-ready options plus client fingerprint.
import { createHash, X509Certificate } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import tls from "node:tls";
import type { GatewayTlsConfig } from "../../config/types.gateway.js";
import { runExec } from "../../process/exec.js";
import { CONFIG_DIR, ensureDir, resolveUserPath, shortenHomeInString } from "../../utils.js";
import { sameFileIdentity } from "../fs-safe-advanced.js";
import { pathExists } from "../fs-safe.js";
import { resolveSystemBin } from "../resolve-system-bin.js";
import { normalizeFingerprint } from "./fingerprint.js";

const GATEWAY_TLS_CERT_GENERATION_TIMEOUT_MS = 30_000;
const GATEWAY_TLS_LINK_ATTEMPTS = 3;
const GATEWAY_TLS_LINK_RETRY_DELAY_MS = 25;
const TRANSIENT_LINK_ERROR_CODES = new Set(["EBUSY", "EINTR", "EIO"]);

type GeneratedTlsOutput = {
  contentDigest: string;
  finalPath: string;
  identity: Stats;
  published: boolean;
  stageDir: string;
  stagedPath: string;
};

type GeneratedTlsRecovery = {
  error?: unknown;
  preserveStageDir: boolean;
};

type GeneratedTlsOutputState = "changed" | "generated" | "missing" | "replaced";

class TlsPublicationError extends Error {
  readonly preserveStageDirs: ReadonlySet<string>;

  constructor(
    message: string,
    options: { cause: unknown; preserveStageDirs: ReadonlySet<string> },
  ) {
    super(message, { cause: options.cause });
    this.name = "TlsPublicationError";
    this.preserveStageDirs = options.preserveStageDirs;
  }
}

function digestTlsContent(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

async function publishGeneratedTlsOutput(output: GeneratedTlsOutput): Promise<void> {
  // Hard links provide atomic no-replace publication without exposing partial key bytes.
  // Filesystems without that guarantee fail closed instead of using a writable fallback.
  for (let attempt = 1; attempt <= GATEWAY_TLS_LINK_ATTEMPTS; attempt += 1) {
    try {
      await fs.link(output.stagedPath, output.finalPath);
      output.published = true;
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt === GATEWAY_TLS_LINK_ATTEMPTS || !TRANSIENT_LINK_ERROR_CODES.has(code ?? "")) {
        throw error;
      }
      await delay(GATEWAY_TLS_LINK_RETRY_DELAY_MS);
    }
  }
}

async function inspectGeneratedTlsOutput(
  output: GeneratedTlsOutput,
  filePath: string,
): Promise<GeneratedTlsOutputState> {
  let currentIdentity: Stats;
  try {
    currentIdentity = await fs.lstat(filePath);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "changed";
  }
  if (!currentIdentity.isFile() || !sameFileIdentity(output.identity, currentIdentity)) {
    return "replaced";
  }

  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ELOOP" ? "replaced" : "changed";
  }
  let state: GeneratedTlsOutputState;
  try {
    const openedIdentity = await handle.stat();
    if (!sameFileIdentity(output.identity, openedIdentity)) {
      state = "replaced";
    } else {
      const contents = await handle.readFile();
      state = digestTlsContent(contents) === output.contentDigest ? "generated" : "changed";
    }
  } catch {
    state = "changed";
  }
  try {
    await handle.close();
  } catch {
    return "changed";
  }
  return state;
}

async function restoreRecoveredOutput(
  recoveryPath: string,
  finalPath: string,
  identity: Stats,
): Promise<void> {
  if (identity.isDirectory()) {
    await fs.cp(recoveryPath, finalPath, {
      errorOnExist: true,
      force: false,
      preserveTimestamps: true,
      recursive: true,
      verbatimSymlinks: true,
    });
    return;
  }
  if (identity.isSymbolicLink()) {
    await fs.symlink(await fs.readlink(recoveryPath), finalPath);
    return;
  }
  try {
    await fs.link(recoveryPath, finalPath);
  } catch {
    try {
      await fs.copyFile(recoveryPath, finalPath, fsConstants.COPYFILE_EXCL);
    } catch (copyError) {
      throw new Error("failed to restore recovered tls output after hard-link failure", {
        cause: copyError,
      });
    }
  }
}

async function recoverPublishedTlsOutput(
  output: GeneratedTlsOutput,
): Promise<GeneratedTlsRecovery> {
  if (!output.published) {
    return { preserveStageDir: false };
  }
  const recoveryPath = path.join(output.stageDir, `published-${path.basename(output.finalPath)}`);
  const currentState = await inspectGeneratedTlsOutput(output, output.finalPath);
  if (currentState === "missing" || currentState === "replaced") {
    return { preserveStageDir: false };
  }
  // Identity alone cannot detect in-place writes to a hard-linked output.
  // Keep both paths when content changed so rollback never deletes operator data.
  if (currentState === "changed") {
    return { preserveStageDir: true };
  }
  try {
    await fs.rename(output.finalPath, recoveryPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { preserveStageDir: false };
    }
    return { error, preserveStageDir: true };
  }

  const recoveredState = await inspectGeneratedTlsOutput(output, recoveryPath);
  if (recoveredState === "generated") {
    // An already-open writer can still mutate this inode after the final check.
    // Keep the recovery pathname so rollback never discards those late writes.
    return { preserveStageDir: true };
  }

  let recoveredIdentity: Stats;
  try {
    recoveredIdentity = await fs.lstat(recoveryPath);
  } catch (error) {
    return { error, preserveStageDir: true };
  }
  try {
    await restoreRecoveredOutput(recoveryPath, output.finalPath, recoveredIdentity);
    return { preserveStageDir: true };
  } catch (error) {
    return { error, preserveStageDir: true };
  }
}

async function publishGeneratedTlsOutputs(outputs: GeneratedTlsOutput[]): Promise<void> {
  try {
    for (const output of outputs) {
      await publishGeneratedTlsOutput(output);
    }
  } catch (error) {
    const preserveStageDirs = new Set<string>();
    const recoveryErrors: unknown[] = [];
    for (const output of outputs.toReversed()) {
      const recovery = await recoverPublishedTlsOutput(output);
      if (recovery.preserveStageDir) {
        preserveStageDirs.add(output.stageDir);
      }
      if (recovery.error) {
        recoveryErrors.push(recovery.error);
      }
    }
    const recoveryNotice = preserveStageDirs.size
      ? `; concurrent output backup preserved under ${[...preserveStageDirs].join(", ")}`
      : "";
    throw new TlsPublicationError(
      `gateway tls: generated pair publication failed${recoveryNotice}`,
      {
        cause: new AggregateError([error, ...recoveryErrors]),
        preserveStageDirs,
      },
    );
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
  let preserveStageDirs: ReadonlySet<string> = new Set();
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
        contentDigest: digestTlsContent(Buffer.from(cert, "utf8")),
        finalPath: params.certPath,
        identity: certIdentity,
        published: false,
        stageDir: certStageDir,
        stagedPath: stagedCertPath,
      },
      {
        contentDigest: digestTlsContent(Buffer.from(key, "utf8")),
        finalPath: params.keyPath,
        identity: keyIdentity,
        published: false,
        stageDir: keyStageDir,
        stagedPath: stagedKeyPath,
      },
    ]);
    params.log?.info?.(
      `gateway tls: generated self-signed cert at ${shortenHomeInString(params.certPath)}`,
    );
  } catch (error) {
    if (error instanceof TlsPublicationError) {
      preserveStageDirs = error.preserveStageDirs;
    }
    throw error;
  } finally {
    await Promise.allSettled(
      [certStageDir, keyStageDir]
        .filter((dir): dir is string => Boolean(dir))
        .filter((dir) => !preserveStageDirs.has(dir))
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
