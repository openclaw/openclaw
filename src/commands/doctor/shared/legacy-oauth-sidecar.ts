// Temporary #174343 OAuth upgrade dead-end repair; remove after 2026-11-29 with
// Doctor compat record doctor-pre-july-retired-state.
import * as childProcess from "node:child_process";
import { createDecipheriv, hash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isPathInside } from "@openclaw/fs-safe/path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { readNonBlankString as readNonEmptyString } from "@openclaw/normalization-core/string-coerce";
import {
  normalizeUniqueTrimmedStringList,
  uniqueStrings,
} from "@openclaw/normalization-core/string-normalization";
import { coerceLegacyAuthStore } from "../../../agents/auth-profiles/legacy-flat-credential.js";
import {
  isLegacyOAuthRef,
  type LegacyOAuthRef,
} from "../../../agents/auth-profiles/legacy-oauth-ref.js";
import { resolveOAuthDir, resolveStateDir } from "../../../config/paths.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { shortenHomePath } from "../../../utils.js";
import { listReferencedLegacyOAuthSidecarPaths } from "../../doctor-auth-legacy-paths.js";
import {
  acquireAuthProfileMigrationSourceLocks,
  prepareAuthProfileSourceReceipt,
  parseAuthProfileMigrationSource,
  finalizeAuthProfileMigrationSource,
  type AuthProfileMigrationSourceReceipt,
} from "../../doctor-auth-migration-receipts.js";

const LEGACY_OAUTH_SECRET_DIRNAME = "auth-profiles";
const LEGACY_OAUTH_SECRET_VERSION = 1;
const LEGACY_OAUTH_SECRET_ALGORITHM = "aes-256-gcm";
const LEGACY_OAUTH_SECRET_KEYCHAIN_SERVICE = "OpenClaw Auth Profile Secrets";
const LEGACY_OAUTH_SECRET_KEYCHAIN_ACCOUNT = "oauth-profile-master-key";
const LEGACY_OAUTH_SECRET_KEY_FILE_NAME = "auth-profile-secret-key";

type LegacyOAuthSecretMaterial = {
  /** OAuth access token from the legacy sidecar. */
  access?: string;
  /** OAuth refresh token from the legacy sidecar. */
  refresh?: string;
  /** Optional OpenID Connect id token from the legacy sidecar. */
  idToken?: string;
};

type LegacyOAuthEncryptedPayload = {
  algorithm: typeof LEGACY_OAUTH_SECRET_ALGORITHM;
  iv: string;
  tag: string;
  ciphertext: string;
};

function resolveLegacyOAuthSidecarPath(
  ref: LegacyOAuthRef,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(resolveOAuthDir(env), LEGACY_OAUTH_SECRET_DIRNAME, `${ref.id}.json`);
}

function normalizeLegacyOAuthSecretMaterial(raw: unknown): LegacyOAuthSecretMaterial | null {
  if (!isRecord(raw)) {
    return null;
  }
  const material: LegacyOAuthSecretMaterial = {
    ...(readNonEmptyString(raw.access) ? { access: readNonEmptyString(raw.access) } : {}),
    ...(readNonEmptyString(raw.refresh) ? { refresh: readNonEmptyString(raw.refresh) } : {}),
    ...(readNonEmptyString(raw.idToken) ? { idToken: readNonEmptyString(raw.idToken) } : {}),
  };
  return Object.keys(material).length > 0 ? material : null;
}

function coerceLegacyOAuthEncryptedPayload(raw: unknown): LegacyOAuthEncryptedPayload | null {
  if (!isRecord(raw)) {
    return null;
  }
  return raw.algorithm === LEGACY_OAUTH_SECRET_ALGORITHM &&
    typeof raw.iv === "string" &&
    typeof raw.tag === "string" &&
    typeof raw.ciphertext === "string"
    ? {
        algorithm: raw.algorithm,
        iv: raw.iv,
        tag: raw.tag,
        ciphertext: raw.ciphertext,
      }
    : null;
}

function buildLegacyOAuthSecretAad(params: {
  ref: LegacyOAuthRef;
  profileId: string;
  provider: string;
}): Buffer {
  return Buffer.from(`${params.ref.id}\0${params.profileId}\0${params.provider}`, "utf8");
}

function buildLegacyOAuthSecretKey(seed: string): Buffer {
  // Legacy #79006 compatibility: existing sidecars were encrypted with this
  // SHA-256 key derivation, so changing it would strand affected users.
  return hash("sha256", `openclaw:auth-profile-oauth:${seed}`, "buffer");
}

function uniquePaths(paths: Array<string | undefined>): string[] {
  return uniqueStrings(paths.filter((entry): entry is string => Boolean(entry)));
}

function resolveLegacyOAuthSecretKeyFileCandidates(env: NodeJS.ProcessEnv): string[] {
  const home = (process.platform === "win32" ? env.USERPROFILE : env.HOME)?.trim() || os.homedir();
  let root: string | undefined;
  let directory = "OpenClaw";
  if (process.platform === "win32") {
    root = env.APPDATA?.trim() || (home ? path.join(home, "AppData", "Roaming") : undefined);
  } else if (process.platform === "darwin") {
    root = home ? path.join(home, "Library", "Application Support") : undefined;
  } else {
    root = env.XDG_CONFIG_HOME?.trim() || (home ? path.join(home, ".config") : undefined);
    directory = "openclaw";
  }
  return uniquePaths([
    root ? path.join(root, directory, LEGACY_OAUTH_SECRET_KEY_FILE_NAME) : undefined,
    home
      ? path.join(home, ".openclaw-auth-profile-secrets", LEGACY_OAUTH_SECRET_KEY_FILE_NAME)
      : undefined,
  ]);
}

export function resolveLegacyOAuthSecretKeyFiles(env: NodeJS.ProcessEnv): string[] {
  const stateDir = resolveStateDir(env);
  return resolveLegacyOAuthSecretKeyFileCandidates(env).filter(
    (candidate) => !isPathInside(stateDir, candidate),
  );
}

function readLegacyOAuthSecretKeyFiles(env: NodeJS.ProcessEnv): string[] {
  return normalizeUniqueTrimmedStringList(
    resolveLegacyOAuthSecretKeyFiles(env).flatMap((keyPath) => {
      try {
        return [fs.readFileSync(keyPath, "utf8")];
      } catch {
        return [];
      }
    }),
  );
}

function readLegacyMacOAuthSecretKeychainKey(params: {
  allowKeychainPrompt?: boolean;
  env: NodeJS.ProcessEnv;
}): string | undefined {
  // The security CLI has no no-UI lookup; unattended Doctor must not trigger a Keychain prompt.
  if (
    process.platform !== "darwin" ||
    params.allowKeychainPrompt === false ||
    params.env.VITEST === "true" ||
    params.env.VITEST_WORKER_ID !== undefined
  ) {
    return undefined;
  }
  try {
    // Read-only compatibility for #79006 sidecar OAuth profiles. Do not add
    // writes, creation, prompts, or new OS-level Keychain integrations here.
    // Doctor alone reads this retired source while importing into SQLite.
    return childProcess
      .execFileSync(
        "security",
        [
          "find-generic-password",
          "-s",
          LEGACY_OAUTH_SECRET_KEYCHAIN_SERVICE,
          "-a",
          LEGACY_OAUTH_SECRET_KEYCHAIN_ACCOUNT,
          "-w",
        ],
        { encoding: "utf8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"] },
      )
      .trim();
  } catch {
    return undefined;
  }
}

function decryptLegacyOAuthSecretMaterialWithSeed(
  params: {
    ref: LegacyOAuthRef;
    profileId: string;
    provider: string;
    encrypted: LegacyOAuthEncryptedPayload;
  },
  seed: string,
): LegacyOAuthSecretMaterial | null {
  try {
    const decipher = createDecipheriv(
      LEGACY_OAUTH_SECRET_ALGORITHM,
      buildLegacyOAuthSecretKey(seed),
      Buffer.from(params.encrypted.iv, "base64url"),
    );
    decipher.setAAD(
      buildLegacyOAuthSecretAad({
        ref: params.ref,
        profileId: params.profileId,
        provider: params.provider,
      }),
    );
    decipher.setAuthTag(Buffer.from(params.encrypted.tag, "base64url"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(params.encrypted.ciphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8");
    return normalizeLegacyOAuthSecretMaterial(JSON.parse(plaintext) as unknown);
  } catch {
    return null;
  }
}

function decryptLegacyOAuthSecretMaterial(params: {
  ref: LegacyOAuthRef;
  profileId: string;
  provider: string;
  encrypted: LegacyOAuthEncryptedPayload;
  env: NodeJS.ProcessEnv;
  allowKeychainPrompt?: boolean;
}): LegacyOAuthSecretMaterial | null {
  const seeds = readLegacyOAuthSecretKeyFiles(params.env);
  for (const seed of seeds) {
    const material = decryptLegacyOAuthSecretMaterialWithSeed(params, seed);
    if (material) {
      return material;
    }
  }
  const keychainSeed = readLegacyMacOAuthSecretKeychainKey({
    allowKeychainPrompt: params.allowKeychainPrompt,
    env: params.env,
  });
  if (keychainSeed && !seeds.includes(keychainSeed)) {
    return decryptLegacyOAuthSecretMaterialWithSeed(params, keychainSeed);
  }
  return null;
}

function loadLegacyOAuthSidecarMaterial(params: {
  ref: LegacyOAuthRef;
  profileId: string;
  provider: string;
  allowKeychainPrompt?: boolean;
  env?: NodeJS.ProcessEnv;
  raw: unknown;
}): LegacyOAuthSecretMaterial | null {
  const env = params.env ?? process.env;
  const raw = params.raw;
  if (!isRecord(raw)) {
    return null;
  }
  if (
    raw.version !== LEGACY_OAUTH_SECRET_VERSION ||
    raw.profileId !== params.profileId ||
    raw.provider !== params.provider
  ) {
    return null;
  }
  const encrypted = coerceLegacyOAuthEncryptedPayload(raw.encrypted);
  if (encrypted) {
    return decryptLegacyOAuthSecretMaterial({
      ref: params.ref,
      profileId: params.profileId,
      provider: params.provider,
      encrypted,
      env,
      allowKeychainPrompt: params.allowKeychainPrompt,
    });
  }
  return normalizeLegacyOAuthSecretMaterial(raw);
}

export function collectUnresolvedLegacyOAuthSidecarProfileIds(raw: unknown): string[] {
  if (!isRecord(raw) || !isRecord(raw.profiles)) {
    return [];
  }
  const profileIds: string[] = [];
  for (const [profileId, profile] of Object.entries(raw.profiles)) {
    if (!isRecord(profile) || profile.type !== "oauth" || !isRecord(profile.oauthRef)) {
      continue;
    }
    if (
      readNonEmptyString(profile.oauthRef.id) &&
      readNonEmptyString(profile.oauthRef.provider) &&
      (!readNonEmptyString(profile.access) || !readNonEmptyString(profile.refresh))
    ) {
      profileIds.push(profileId);
    }
  }
  return profileIds;
}

export function prepareLegacyOAuthSidecarImport(params: {
  rawStore: unknown;
  env: NodeJS.ProcessEnv;
  oauthEnv: NodeJS.ProcessEnv;
  targetDatabasePath: string;
  targetStoreKey: "primary" | "shared";
  now: () => number;
}): AuthProfileMigrationSourceReceipt[] {
  const { rawStore, env, oauthEnv, targetDatabasePath, targetStoreKey, now } = params;
  const sidecarReceipts: AuthProfileMigrationSourceReceipt[] = [];
  if (isRecord(rawStore) && isRecord(rawStore.profiles)) {
    for (const [profileId, profile] of Object.entries(rawStore.profiles)) {
      if (
        !isRecord(profile) ||
        profile.type !== "oauth" ||
        !isLegacyOAuthRef(profile.oauthRef) ||
        profile.provider !== profile.oauthRef.provider
      ) {
        continue;
      }
      const sidecarPath = resolveLegacyOAuthSidecarPath(profile.oauthRef, oauthEnv);
      if (!fs.existsSync(sidecarPath)) {
        throw new Error(
          `Legacy OAuth sidecar is missing at ${sidecarPath}. Restore that file or correct OPENCLAW_OAUTH_DIR, then rerun openclaw doctor --fix. The auth source remains unchanged for retry.`,
        );
      }
      const receipt = prepareAuthProfileSourceReceipt({
        pathname: sidecarPath,
        targetDatabasePath,
        targetTable: targetStoreKey === "shared" ? "auth_profile_stores" : "auth_profile_store",
        targetStoreKey,
        now,
        env,
      });
      const material = loadLegacyOAuthSidecarMaterial({
        profileId,
        provider: profile.provider,
        ref: profile.oauthRef,
        env: oauthEnv,
        raw: parseAuthProfileMigrationSource(receipt),
        allowKeychainPrompt: process.stdin.isTTY,
      });
      if (material) {
        delete profile.oauthRef;
        Object.assign(profile, material);
      }
      sidecarReceipts.push(receipt);
    }
  }
  return sidecarReceipts;
}

export function parseLegacyOAuthFile(raw: unknown) {
  const store = isRecord(raw)
    ? coerceLegacyAuthStore(
        Object.fromEntries(
          Object.entries(raw).map(([provider, credential]) => [
            provider,
            isRecord(credential) ? { ...credential, type: "oauth", provider } : credential,
          ]),
        ),
      )
    : null;
  const rejectedEntries = isRecord(raw)
    ? Object.keys(raw).length - Object.keys(store ?? {}).length
    : raw === undefined
      ? 0
      : 1;
  return { store, rejectedEntries };
}

export function finalizeLegacyOAuthSidecarImports(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  receipts: Iterable<AuthProfileMigrationSourceReceipt>;
}): { changes: string[]; warnings: string[] } {
  const { cfg, env, receipts } = params;
  const changes: string[] = [];
  const warnings: string[] = [];
  const stillReferenced = new Set(listReferencedLegacyOAuthSidecarPaths(env, cfg));
  for (const receipt of receipts) {
    if (stillReferenced.has(receipt.sourcePath)) {
      continue;
    }
    const release = acquireAuthProfileMigrationSourceLocks([receipt.sourcePath]);
    try {
      finalizeAuthProfileMigrationSource(receipt);
      changes.push(`Archived legacy OAuth sidecar -> ${shortenHomePath(receipt.archivePath)}.`);
    } catch (err) {
      warnings.push(
        `Could not archive legacy OAuth sidecar ${shortenHomePath(receipt.sourcePath)}: ${String(err)}`,
      );
    } finally {
      release();
    }
  }
  return { changes, warnings };
}
