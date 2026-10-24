import fs from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { stableStringify } from "@openclaw/normalization-core/stable-stringify";
import { fingerprintConfigSnapshotAuthoredConfig } from "../config/config-journal-snapshot.js";
import { hashConfigRaw, parseConfigJson5 } from "../config/io.read-helpers.js";
import {
  assertConfigFileWritePathSnapshot,
  captureConfigFileWritePathProof,
  resolveConfigStatMetadata,
} from "../config/io.write-safety.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { sha256Hex } from "./crypto-digest.js";
import { readDatabasePathIdentitySync } from "./sqlite-worker-identity.js";
import {
  immutableConfigFingerprintSchema,
  immutableProtectedFileIdentitySchema,
  type ConfigFingerprint,
  type ImmutableProtectionSnapshot,
} from "./update-immutable-protection-schema.js";

type ProtectionContext = { env: NodeJS.ProcessEnv; assertCurrent: () => void };

function fileIdentity(file: string) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.nlink !== 1) {
    throw new Error(`Immutable update requires an unshared regular protected file: ${file}`);
  }
  return immutableProtectedFileIdentitySchema.parse(resolveConfigStatMetadata(stat));
}

function fingerprint(raw: string, env: NodeJS.ProcessEnv): ConfigFingerprint {
  const parsed = parseConfigJson5(raw);
  if (!parsed.ok || !isRecord(parsed.parsed)) {
    throw new Error("Immutable update requires a readable object-shaped config.");
  }
  const result = immutableConfigFingerprintSchema.safeParse(
    fingerprintConfigSnapshotAuthoredConfig(parsed.parsed, { env, readOnly: true }),
  );
  if (!result.success) {
    throw new Error(
      "Config journal fingerprints are unavailable; immutable activation was not admitted.",
    );
  }
  return result.data;
}

function object(
  value: ConfigFingerprint | undefined,
): Record<string, ConfigFingerprint> | undefined {
  return value !== undefined && typeof value === "object" && !Array.isArray(value)
    ? value
    : undefined;
}

function policyFingerprint(config: ConfigFingerprint): string {
  const root = object(config) ?? {};
  const channelPolicy = (value: ConfigFingerprint): ConfigFingerprint => {
    const fields = object(value);
    if (!fields) {
      return value;
    }
    return Object.fromEntries(
      Object.entries(fields)
        .filter(([key]) => key !== "legacyWebhook")
        .map(([key, child]) => [key, channelPolicy(child)]),
    );
  };
  const agents = object(root.agents);
  const agentPolicy = (value: ConfigFingerprint | undefined) => {
    const entry = object(value);
    return { tools: entry?.tools, sandbox: entry?.sandbox, permissions: entry?.permissions };
  };
  // Channel settings are open-world plugin contracts. Freeze the whole subtree except
  // the established additive webhook migration instead of guessing permission key names.
  return sha256Hex(
    stableStringify({
      ...Object.fromEntries(
        [
          "gateway",
          "tools",
          "commands",
          "approvals",
          "permissions",
          "security",
          "bindings",
          "plugins",
        ].map((key) => [key, root[key]]),
      ),
      channels: root.channels === undefined ? undefined : channelPolicy(root.channels),
      agents: {
        defaults: agentPolicy(agents?.defaults),
        entries: Object.fromEntries(
          Object.entries(object(agents?.entries) ?? {}).map(([key, entry]) => [
            key,
            agentPolicy(entry),
          ]),
        ),
      },
    }),
  );
}

function isAdditive(
  before: ConfigFingerprint,
  after: ConfigFingerprint,
  keys: string[] = [],
): boolean {
  if (keys.length === 2 && keys[0] === "meta" && keys[1] === "lastTouchedVersion") {
    return typeof after === "string";
  }
  const previous = object(before);
  const next = object(after);
  return previous && next
    ? Object.entries(previous).every(
        ([key, value]) => Object.hasOwn(next, key) && isAdditive(value, next[key]!, [...keys, key]),
      )
    : isDeepStrictEqual(before, after);
}

function readFile(file: ImmutableProtectionSnapshot["config"][number], env: NodeJS.ProcessEnv) {
  assertConfigFileWritePathSnapshot(file.pathProof, fs);
  const before = fileIdentity(file.pathProof.targetPath);
  const raw = fs.readFileSync(file.pathProof.targetPath, "utf8");
  const after = fileIdentity(file.pathProof.targetPath);
  assertConfigFileWritePathSnapshot(file.pathProof, fs);
  if (!isDeepStrictEqual(before, after)) {
    throw new Error("Protected config identity changed during verification.");
  }
  return { identity: after, hash: hashConfigRaw(raw), fingerprint: fingerprint(raw, env) };
}

function assertState(snapshot: ImmutableProtectionSnapshot): void {
  const state = snapshot.state;
  assertConfigFileWritePathSnapshot(state.pathProof, fs);
  const current = readDatabasePathIdentitySync(state.path);
  if (
    current.key !== state.key ||
    current.birthtime !== state.birthtime ||
    !isDeepStrictEqual(fileIdentity(state.pathProof.targetPath), state.identity)
  ) {
    throw new Error(
      "Protected state database identity changed; automatic activation or rollback was refused.",
    );
  }
}

export async function captureImmutableProtection(
  params: ProtectionContext & {
    configPath: string;
    stateDir: string;
  },
): Promise<ImmutableProtectionSnapshot> {
  const env = {
    ...params.env,
    OPENCLAW_STATE_DIR: params.stateDir,
    OPENCLAW_CONFIG_PATH: params.configPath,
  };
  params.assertCurrent();
  const statePath = resolveOpenClawStateSqlitePath(env);
  const state = readDatabasePathIdentitySync(statePath);
  const stateIdentity = fileIdentity(state.canonicalPath);
  const { captureUpdateConfigSnapshot } =
    await import("../cli/update-cli/update-command-config-snapshot.js");
  params.assertCurrent();
  const capture = await captureUpdateConfigSnapshot(params.configPath, env);
  params.assertCurrent();
  const files = [capture, ...(capture.includedFiles ?? [])];
  const config = files.map((file, index) => {
    if (file.raw === null || file.doctorOwned === false) {
      throw new Error(
        "Protected config and its include graph must be readable before immutable activation.",
      );
    }
    const proof =
      file.pathSnapshot ??
      captureConfigFileWritePathProof(file.path, fs.realpathSync(file.path), fs).snapshot;
    const value = fingerprint(file.raw, env);
    return {
      path: file.path,
      pathProof: proof,
      identity: fileIdentity(proof.targetPath),
      hash: file.hash,
      fingerprint: value,
      policyFingerprint: index === 0 ? policyFingerprint(value) : sha256Hex(stableStringify(value)),
    };
  });
  const snapshot: ImmutableProtectionSnapshot = {
    capturedAtMs: Date.now(),
    auditBoundary: null,
    state: {
      path: statePath,
      identity: stateIdentity,
      pathProof: captureConfigFileWritePathProof(statePath, state.canonicalPath, fs).snapshot,
      key: state.key,
      ...(state.birthtime === undefined ? {} : { birthtime: state.birthtime }),
    },
    config,
  };
  assertImmutableProtectionUnchanged(snapshot, { env, assertCurrent: params.assertCurrent });
  return snapshot;
}

/** Drain may yield for minutes; recheck the original capture immediately before cutover. */
export function assertImmutableProtectionUnchanged(
  snapshot: ImmutableProtectionSnapshot,
  context: ProtectionContext,
): void {
  context.assertCurrent();
  assertState(snapshot);
  for (const file of snapshot.config) {
    const current = readFile(file, context.env);
    if (current.hash !== file.hash || !isDeepStrictEqual(current.identity, file.identity)) {
      throw new Error(
        "Protected configuration changed before immutable cutover; the Gateway remains on its previous generation.",
      );
    }
  }
  assertState(snapshot);
  context.assertCurrent();
}

/** Optional audit receipts do not gate an additive migration with unchanged policy and ownership. */
export function verifyImmutableProtection(
  snapshot: ImmutableProtectionSnapshot,
  context: ProtectionContext,
): void {
  context.assertCurrent();
  assertState(snapshot);
  for (const file of snapshot.config) {
    const current = readFile(file, context.env);
    if (current.hash === file.hash && isDeepStrictEqual(current.identity, file.identity)) {
      continue;
    }
    if (
      !isAdditive(file.fingerprint, current.fingerprint) ||
      (file === snapshot.config[0]
        ? policyFingerprint(current.fingerprint)
        : sha256Hex(stableStringify(current.fingerprint))) !== file.policyFingerprint
    ) {
      throw new Error(
        "Protected configuration changed without an additive, policy-preserving startup migration.",
      );
    }
    if (
      current.identity.uid !== file.identity.uid ||
      current.identity.gid !== file.identity.gid ||
      current.identity.mode !== file.identity.mode ||
      current.identity.dev !== file.identity.dev
    ) {
      throw new Error(
        "Protected config ownership or permissions changed during startup migration.",
      );
    }
  }
  assertState(snapshot);
  context.assertCurrent();
}
