import fs from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { resolvePathViaExistingAncestorSync } from "./boundary-path.js";
import { SQLITE_SIDECAR_SUFFIXES } from "./sqlite-files.js";

export const CLIENT_CREDENTIAL_LEGACY_KEYS = [
  "identity:primary",
  "identity:node",
  "identity:shareExtension",
  "auth:primary",
  "auth:node",
  "auth:shareExtension",
] as const;
export type ClientCredentialLegacyKey = (typeof CLIENT_CREDENTIAL_LEGACY_KEYS)[number];
export type ClientCredentialFileIdentity = { path: string; dev: string; ino: string };
type ClientCredentialSource = {
  kind: "canonical" | "independent";
  engine: "sqlite" | "postgres" | "native-v0";
  identity: string;
  generation: string;
  sha256: string;
  destinationVersion: number;
};
export type ClientCredentialReceipt = {
  format: 1;
  source: ClientCredentialSource | null;
  sharedFile: ClientCredentialFileIdentity | null;
  legacyImports: Partial<Record<ClientCredentialLegacyKey, { sha256: string | null }>>;
};

/** File replacement fences a completed orphan without opening the selected database. */
export function readClientCredentialFileIdentity(
  pathname: string,
): ClientCredentialFileIdentity | null {
  const stat = fs.statSync(pathname, { bigint: true, throwIfNoEntry: false });
  if (!stat) {
    if (SQLITE_SIDECAR_SUFFIXES.some((suffix) => fs.existsSync(`${pathname}${suffix}`))) {
      throw new Error(
        "Client credential source is unavailable; restore the matching main database before using this client.",
      );
    }
    return null;
  }
  if (!stat.isFile()) {
    throw new Error("Client credential source is not a regular file.");
  }
  return { path: fs.realpathSync.native(pathname), dev: String(stat.dev), ino: String(stat.ino) };
}

export function emptyClientCredentialReceipt(
  sharedFile: ClientCredentialFileIdentity | null = null,
): ClientCredentialReceipt {
  return { format: 1, source: null, sharedFile, legacyImports: {} };
}

function digest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

/** The private receipt is shared with Swift; reject unsupported formats rather than discarding claims. */
export function parseClientCredentialReceipt(
  serialized: string,
  rootPath?: string,
): ClientCredentialReceipt {
  const invalid = () =>
    new Error("Client credential migration receipt is invalid; run openclaw doctor --fix.");
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw invalid();
  }
  if (!isRecord(value) || value.format !== 1 || !isRecord(value.legacyImports)) {
    throw invalid();
  }
  let source: ClientCredentialSource | null = null;
  if (value.source !== null) {
    const candidate = value.source;
    if (
      !isRecord(candidate) ||
      (candidate.kind !== "canonical" && candidate.kind !== "independent") ||
      (candidate.engine !== "sqlite" &&
        candidate.engine !== "postgres" &&
        candidate.engine !== "native-v0") ||
      typeof candidate.identity !== "string" ||
      candidate.identity.length === 0 ||
      typeof candidate.generation !== "string" ||
      candidate.generation.length === 0 ||
      !digest(candidate.sha256) ||
      candidate.destinationVersion !== 1
    ) {
      throw invalid();
    }
    source = {
      kind: candidate.kind,
      engine: candidate.engine,
      identity: candidate.identity,
      generation: candidate.generation,
      sha256: candidate.sha256,
      destinationVersion: candidate.destinationVersion,
    };
  }
  let sharedFile: ClientCredentialFileIdentity | null = null;
  if (value.sharedFile !== null) {
    const candidate = value.sharedFile;
    if (
      !isRecord(candidate) ||
      typeof candidate.path !== "string" ||
      typeof candidate.dev !== "string" ||
      !/^\d+$/u.test(candidate.dev) ||
      typeof candidate.ino !== "string" ||
      !/^\d+$/u.test(candidate.ino)
    ) {
      throw invalid();
    }
    sharedFile = { path: candidate.path, dev: candidate.dev, ino: candidate.ino };
  }
  if (source?.kind === "independent" && (source.engine !== "native-v0" || !sharedFile)) {
    throw invalid();
  }
  const legacyImports: ClientCredentialReceipt["legacyImports"] = {};
  for (const [key, claim] of Object.entries(value.legacyImports)) {
    const known = CLIENT_CREDENTIAL_LEGACY_KEYS.find((candidate) => candidate === key);
    if (!known || !isRecord(claim) || (claim.sha256 !== null && !digest(claim.sha256))) {
      throw invalid();
    }
    legacyImports[known] = { sha256: claim.sha256 };
  }
  return rebaseCanonicalReceipt(
    {
      format: 1,
      source,
      sharedFile,
      legacyImports,
    },
    rootPath,
    false,
  );
}

function rebaseCanonicalReceipt(
  receipt: ClientCredentialReceipt,
  rootPath: string | undefined,
  storing: boolean,
): ClientCredentialReceipt {
  const shared = receipt.sharedFile;
  if (!shared || receipt.source?.kind === "independent") {
    return receipt;
  }
  const relative = !path.isAbsolute(shared.path);
  if (
    relative &&
    (!rootPath ||
      !shared.path.startsWith("./") ||
      shared.path
        .slice(2)
        .split("/")
        .some((part) => !part || part === "." || part === ".." || part.includes("\\")))
  ) {
    throw new Error("Client credential receipt has an invalid relative shared binding.");
  }
  if (!rootPath) {
    return receipt;
  }
  const root = resolvePathViaExistingAncestorSync(rootPath);
  const absolute = path.resolve(root, shared.path);
  const descendant = path.relative(root, absolute);
  const portable =
    descendant &&
    !path.isAbsolute(descendant) &&
    descendant !== ".." &&
    !descendant.startsWith(`..${path.sep}`);
  const rebound = storing && portable ? `./${descendant.split(path.sep).join("/")}` : absolute;
  let source = receipt.source;
  if (source?.engine === "sqlite") {
    const prefix = `${shared.path}:`;
    if (source.identity.startsWith(prefix)) {
      source = { ...source, identity: `${rebound}:${source.identity.slice(prefix.length)}` };
    } else if (relative) {
      throw new Error("Client credential receipt has an invalid relative source identity.");
    }
  }
  return { ...receipt, source, sharedFile: { ...shared, path: rebound } };
}

export function serializeClientCredentialReceipt(
  receipt: ClientCredentialReceipt,
  rootPath?: string,
): string {
  return JSON.stringify(rebaseCanonicalReceipt(receipt, rootPath, true));
}
