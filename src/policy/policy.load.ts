import type { Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { verifyEd25519Signature } from "./policy.crypto.js";
import { SignedPolicySchema, type SignedPolicy } from "./policy.schema.js";

export type PolicyLoadErrorCode =
  | "POLICY_FILE_MISSING"
  | "SIGNATURE_FILE_MISSING"
  | "POLICY_FILE_UNREADABLE"
  | "SIGNATURE_FILE_UNREADABLE"
  | "POLICY_FILE_INSECURE"
  | "SIGNATURE_FILE_INSECURE"
  | "POLICY_JSON_INVALID"
  | "POLICY_SCHEMA_INVALID"
  | "PUBLIC_KEY_MISSING"
  | "POLICY_KEY_ID_UNTRUSTED"
  | "SIGNATURE_INVALID";

export type PolicyLoadFailure = {
  ok: false;
  code: PolicyLoadErrorCode;
  error: string;
  policyPath: string;
  sigPath: string;
};

export type PolicyLoadSuccess = {
  ok: true;
  policy: SignedPolicy;
  policyPath: string;
  sigPath: string;
  rawPolicy: string;
  verifiedKeyId?: string;
};

export type PolicyLoadResult = PolicyLoadSuccess | PolicyLoadFailure;

type VerificationKey = {
  keyId: string;
  publicKey: string;
};

type ArtifactKind = "policy" | "signature";

function buildLoadError(
  code: PolicyLoadErrorCode,
  message: string,
  policyPath: string,
  sigPath: string,
): PolicyLoadFailure {
  return {
    ok: false,
    code,
    error: message,
    policyPath,
    sigPath,
  };
}

function isPosixLikePlatform(): boolean {
  return process.platform !== "win32";
}

function statHasUnsafeWriteBits(stats: Stats): boolean {
  const mode = stats.mode & 0o777;
  return (mode & 0o022) !== 0;
}

function ensureOwnerIsCurrentUser(stats: Stats): boolean {
  if (typeof process.getuid !== "function") {
    return true;
  }
  return stats.uid === process.getuid();
}

function getArtifactCodes(kind: ArtifactKind): {
  missing: PolicyLoadErrorCode;
  unreadable: PolicyLoadErrorCode;
  insecure: PolicyLoadErrorCode;
} {
  return kind === "policy"
    ? {
        missing: "POLICY_FILE_MISSING",
        unreadable: "POLICY_FILE_UNREADABLE",
        insecure: "POLICY_FILE_INSECURE",
      }
    : {
        missing: "SIGNATURE_FILE_MISSING",
        unreadable: "SIGNATURE_FILE_UNREADABLE",
        insecure: "SIGNATURE_FILE_INSECURE",
      };
}

async function validateSecureArtifactPath(params: {
  pathname: string;
  kind: ArtifactKind;
  strictFilePermissions: boolean;
  policyPath: string;
  sigPath: string;
}): Promise<PolicyLoadFailure | null> {
  const codes = getArtifactCodes(params.kind);
  let stats: Stats;
  try {
    stats = await fs.lstat(params.pathname);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ENOENT") {
      return buildLoadError(
        codes.missing,
        `${params.kind === "policy" ? "Policy file" : "Policy signature file"} not found at ${
          params.pathname
        }.`,
        params.policyPath,
        params.sigPath,
      );
    }
    return buildLoadError(
      codes.unreadable,
      `Failed to read metadata for ${params.kind} file at ${params.pathname}: ${String(err)}`,
      params.policyPath,
      params.sigPath,
    );
  }

  if (stats.isSymbolicLink()) {
    return buildLoadError(
      codes.insecure,
      `${params.kind} file at ${params.pathname} must not be a symbolic link.`,
      params.policyPath,
      params.sigPath,
    );
  }

  if (!stats.isFile()) {
    return buildLoadError(
      codes.insecure,
      `${params.kind} file at ${params.pathname} must be a regular file.`,
      params.policyPath,
      params.sigPath,
    );
  }

  if (!params.strictFilePermissions || !isPosixLikePlatform()) {
    return null;
  }

  if (statHasUnsafeWriteBits(stats)) {
    return buildLoadError(
      codes.insecure,
      `${params.kind} file at ${params.pathname} has insecure permissions (group/world writable).`,
      params.policyPath,
      params.sigPath,
    );
  }

  if (!ensureOwnerIsCurrentUser(stats)) {
    return buildLoadError(
      codes.insecure,
      `${params.kind} file at ${params.pathname} is not owned by the current user.`,
      params.policyPath,
      params.sigPath,
    );
  }

  let parentStats: Stats;
  try {
    parentStats = await fs.stat(path.dirname(params.pathname));
  } catch (err) {
    return buildLoadError(
      codes.unreadable,
      `Failed to stat parent directory for ${params.kind} file at ${params.pathname}: ${String(err)}`,
      params.policyPath,
      params.sigPath,
    );
  }

  if (statHasUnsafeWriteBits(parentStats)) {
    return buildLoadError(
      codes.insecure,
      `${params.kind} directory ${path.dirname(params.pathname)} has insecure permissions (group/world writable).`,
      params.policyPath,
      params.sigPath,
    );
  }

  if (!ensureOwnerIsCurrentUser(parentStats)) {
    return buildLoadError(
      codes.insecure,
      `${params.kind} directory ${path.dirname(params.pathname)} is not owned by the current user.`,
      params.policyPath,
      params.sigPath,
    );
  }

  return null;
}

async function readUtf8File(pathname: string): Promise<string> {
  return await fs.readFile(pathname, "utf8");
}

function normalizeTrustedKeys(params: {
  publicKey?: string;
  publicKeys?: Record<string, string>;
}): Map<string, string> {
  const trusted = new Map<string, string>();
  const primary = params.publicKey?.trim();
  if (primary) {
    trusted.set("default", primary);
  }
  const configured = params.publicKeys ?? {};
  for (const [keyId, rawKey] of Object.entries(configured)) {
    const normalizedKeyId = keyId.trim();
    const normalizedKey = rawKey.trim();
    if (!normalizedKeyId || !normalizedKey) {
      continue;
    }
    trusted.set(normalizedKeyId, normalizedKey);
  }
  return trusted;
}

function resolveVerificationKeys(params: {
  policy: SignedPolicy;
  publicKey?: string;
  publicKeys?: Record<string, string>;
  policyPath: string;
  sigPath: string;
}): { ok: true; keys: VerificationKey[] } | PolicyLoadFailure {
  const trusted = normalizeTrustedKeys({
    publicKey: params.publicKey,
    publicKeys: params.publicKeys,
  });
  if (trusted.size === 0) {
    return buildLoadError(
      "PUBLIC_KEY_MISSING",
      "At least one policy verification public key is required when policy.enabled=true.",
      params.policyPath,
      params.sigPath,
    );
  }

  if (params.policy.keyId) {
    const key = trusted.get(params.policy.keyId);
    if (!key) {
      return buildLoadError(
        "POLICY_KEY_ID_UNTRUSTED",
        `Policy keyId "${params.policy.keyId}" is not trusted by configured policy.publicKeys.`,
        params.policyPath,
        params.sigPath,
      );
    }
    return {
      ok: true,
      keys: [{ keyId: params.policy.keyId, publicKey: key }],
    };
  }

  return {
    ok: true,
    keys: [...trusted.entries()].map(([keyId, publicKey]) => ({ keyId, publicKey })),
  };
}

export async function loadSignedPolicy(params: {
  policyPath: string;
  sigPath: string;
  publicKey?: string;
  publicKeys?: Record<string, string>;
  strictFilePermissions?: boolean;
}): Promise<PolicyLoadResult> {
  const policyPath = params.policyPath;
  const sigPath = params.sigPath;
  const strictFilePermissions = params.strictFilePermissions !== false;

  const policyPathCheck = await validateSecureArtifactPath({
    pathname: policyPath,
    kind: "policy",
    strictFilePermissions,
    policyPath,
    sigPath,
  });
  if (policyPathCheck) {
    return policyPathCheck;
  }

  const sigPathCheck = await validateSecureArtifactPath({
    pathname: sigPath,
    kind: "signature",
    strictFilePermissions,
    policyPath,
    sigPath,
  });
  if (sigPathCheck) {
    return sigPathCheck;
  }

  let rawPolicy: string;
  try {
    rawPolicy = await readUtf8File(policyPath);
  } catch (err) {
    return buildLoadError(
      "POLICY_FILE_UNREADABLE",
      `Failed to read policy file at ${policyPath}: ${String(err)}`,
      policyPath,
      sigPath,
    );
  }

  let rawSignature: string;
  try {
    rawSignature = await readUtf8File(sigPath);
  } catch (err) {
    return buildLoadError(
      "SIGNATURE_FILE_UNREADABLE",
      `Failed to read policy signature at ${sigPath}: ${String(err)}`,
      policyPath,
      sigPath,
    );
  }

  let parsedPolicy: unknown;
  try {
    parsedPolicy = JSON.parse(rawPolicy);
  } catch (err) {
    return buildLoadError(
      "POLICY_JSON_INVALID",
      `Policy JSON parse failed: ${String(err)}`,
      policyPath,
      sigPath,
    );
  }

  const validated = SignedPolicySchema.safeParse(parsedPolicy);
  if (!validated.success) {
    const issueText = validated.error.issues
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("; ");
    return buildLoadError(
      "POLICY_SCHEMA_INVALID",
      `Policy schema validation failed: ${issueText}`,
      policyPath,
      sigPath,
    );
  }

  const keyResolution = resolveVerificationKeys({
    policy: validated.data,
    publicKey: params.publicKey,
    publicKeys: params.publicKeys,
    policyPath,
    sigPath,
  });
  if (!keyResolution.ok) {
    return keyResolution;
  }

  const signature = rawSignature.trim();
  let verifiedKeyId: string | undefined;
  for (const key of keyResolution.keys) {
    if (
      verifyEd25519Signature({
        payload: rawPolicy,
        signatureBase64: signature,
        publicKey: key.publicKey,
      })
    ) {
      verifiedKeyId = key.keyId;
      break;
    }
  }

  if (!verifiedKeyId) {
    return buildLoadError(
      "SIGNATURE_INVALID",
      "Policy signature verification failed.",
      policyPath,
      sigPath,
    );
  }

  return {
    ok: true,
    policy: validated.data,
    policyPath,
    sigPath,
    rawPolicy,
    verifiedKeyId,
  };
}
