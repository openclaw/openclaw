import fs from "node:fs";
import path from "node:path";
import {
  listAgentIds,
  resolveAgentDir,
  resolveDefaultAgentDir,
  resolveDefaultAgentId,
} from "../agents/agent-scope.js";
import { AUTH_STORE_VERSION } from "../agents/auth-profiles/constants.js";
import {
  isLegacyOAuthRef,
  isLegacyOAuthSidecarPayload,
  legacyOAuthSidecarTestUtils,
  loadLegacyOAuthSidecarMaterial,
  resolveLegacyOAuthSidecarPath,
  type LegacyOAuthRef,
  type LegacyOAuthSecretMaterial,
} from "../agents/auth-profiles/legacy-oauth-sidecar.js";
import { resolveAuthStorePath } from "../agents/auth-profiles/paths.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "../agents/auth-profiles/store.js";
import { formatCliCommand } from "../cli/command-format.js";
import { resolveOAuthDir, resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadJsonFile, saveJsonFile } from "../infra/json-file.js";
import { isRecord } from "../shared/record-coerce.js";
import { note } from "../terminal/note.js";
import { shortenHomePath } from "../utils.js";
import type { DoctorPrompter } from "./doctor-prompter.js";

const LEGACY_OAUTH_SECRET_DIRNAME = "auth-profiles";

type AuthProfileRepairCandidate = {
  agentId?: string;
  agentDir?: string;
  authPath: string;
  isMain: boolean;
};

type LegacyOAuthSidecarProfile = {
  profileId: string;
  provider: string;
  ref: LegacyOAuthRef;
};

type LegacyOAuthSidecarStore = AuthProfileRepairCandidate & {
  raw: Record<string, unknown>;
  profiles: LegacyOAuthSidecarProfile[];
};

type LegacyOAuthUnreferencedSidecar = {
  sidecarPath: string;
};

type UndecryptableLegacyOAuthSidecarProfile = {
  store: LegacyOAuthSidecarStore;
  profile: LegacyOAuthSidecarProfile;
  sidecarPath: string;
};

export type LegacyOAuthSidecarRepairResult = {
  detected: string[];
  changes: string[];
  warnings: string[];
};

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function resolveMainAuthStorePath(env: NodeJS.ProcessEnv): string {
  return path.join(resolveStateDir(env), "agents", "main", "agent", "auth-profiles.json");
}

function addCandidate(
  candidates: Map<string, AuthProfileRepairCandidate>,
  agentDir: string | undefined,
  env: NodeJS.ProcessEnv,
  agentId?: string,
): void {
  const authPath = resolveAuthStorePath(agentDir);
  const resolvedAuthPath = path.resolve(authPath);
  candidates.set(resolvedAuthPath, {
    agentId,
    agentDir,
    authPath,
    isMain: agentId === "main" || resolvedAuthPath === path.resolve(resolveMainAuthStorePath(env)),
  });
}

function listExistingAgentDirsFromState(
  env: NodeJS.ProcessEnv,
): Array<{ agentId: string; agentDir: string }> {
  const root = path.join(resolveStateDir(env), "agents");
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => ({ agentId: entry.name, agentDir: path.join(root, entry.name, "agent") }))
    .filter((entry) => {
      try {
        return fs.statSync(entry.agentDir).isDirectory();
      } catch {
        return false;
      }
    });
}

function listAuthProfileRepairCandidates(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv,
): AuthProfileRepairCandidate[] {
  const candidates = new Map<string, AuthProfileRepairCandidate>();
  addCandidate(candidates, resolveDefaultAgentDir(cfg, env), env, resolveDefaultAgentId(cfg));
  const envAgentDir = readNonEmptyString(env.OPENCLAW_AGENT_DIR);
  if (envAgentDir) {
    addCandidate(candidates, envAgentDir, env);
  }
  for (const agentId of listAgentIds(cfg)) {
    addCandidate(candidates, resolveAgentDir(cfg, agentId, env), env, agentId);
  }
  for (const entry of listExistingAgentDirsFromState(env)) {
    addCandidate(candidates, entry.agentDir, env, entry.agentId);
  }
  return [...candidates.values()];
}

function resolveLegacyOAuthSidecarStore(
  candidate: AuthProfileRepairCandidate,
): LegacyOAuthSidecarStore | null {
  if (!fs.existsSync(candidate.authPath)) {
    return null;
  }
  const raw = loadJsonFile(candidate.authPath);
  if (!isRecord(raw) || !isRecord(raw.profiles)) {
    return null;
  }
  const profiles: LegacyOAuthSidecarProfile[] = [];
  for (const [profileId, value] of Object.entries(raw.profiles)) {
    if (!isRecord(value) || value.type !== "oauth") {
      continue;
    }
    const ref = isLegacyOAuthRef(value.oauthRef) ? value.oauthRef : undefined;
    if (!ref || readNonEmptyString(value.provider) !== ref.provider) {
      continue;
    }
    profiles.push({ profileId, provider: ref.provider, ref });
  }
  return profiles.length > 0
    ? {
        ...candidate,
        raw,
        profiles,
      }
    : null;
}

function listUnreferencedLegacyOAuthSidecars(
  referencedRefIds: Set<string>,
  env: NodeJS.ProcessEnv,
): LegacyOAuthUnreferencedSidecar[] {
  const sidecarDir = path.join(resolveOAuthDir(env), LEGACY_OAUTH_SECRET_DIRNAME);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(sidecarDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      return [];
    }
    const refId = entry.name.slice(0, -".json".length);
    if (!/^[a-f0-9]{32}$/.test(refId) || referencedRefIds.has(refId)) {
      return [];
    }
    const sidecarPath = path.join(sidecarDir, entry.name);
    return isLegacyOAuthSidecarPayload(loadJsonFile(sidecarPath)) ? [{ sidecarPath }] : [];
  });
}

function applyLegacyOAuthSidecarMaterial(params: {
  raw: Record<string, unknown>;
  profile: LegacyOAuthSidecarProfile;
  material: LegacyOAuthSecretMaterial;
}): boolean {
  if (!isRecord(params.raw.profiles)) {
    return false;
  }
  const entry = params.raw.profiles[params.profile.profileId];
  if (!isRecord(entry)) {
    return false;
  }
  delete entry.oauthRef;
  if (params.material.access) {
    entry.access = params.material.access;
  }
  if (params.material.refresh) {
    entry.refresh = params.material.refresh;
  }
  if (params.material.idToken) {
    entry.idToken = params.material.idToken;
  }
  return true;
}

function backupLegacyOAuthSidecarStore(authPath: string, now: () => number): string {
  const backupPath = `${authPath}.oauth-ref.${now()}.bak`;
  fs.copyFileSync(authPath, backupPath);
  return backupPath;
}

function movePathAside(pathname: string, now: () => number): string {
  const baseBackupPath = `${pathname}.bak.${now()}`;
  let backupPath = baseBackupPath;
  let suffix = 1;
  while (fs.existsSync(backupPath)) {
    backupPath = `${baseBackupPath}.${suffix}`;
    suffix += 1;
  }
  fs.renameSync(pathname, backupPath);
  return backupPath;
}

function findUndecryptableLegacyOAuthSidecarProfiles(params: {
  stores: LegacyOAuthSidecarStore[];
  env: NodeJS.ProcessEnv;
  allowKeychainPrompt: boolean;
}): UndecryptableLegacyOAuthSidecarProfile[] {
  const undecryptable: UndecryptableLegacyOAuthSidecarProfile[] = [];
  for (const store of params.stores) {
    for (const profile of store.profiles) {
      const material = loadLegacyOAuthSidecarMaterial({
        ...profile,
        env: params.env,
        allowKeychainPrompt: params.allowKeychainPrompt,
      });
      if (material) {
        continue;
      }
      undecryptable.push({
        store,
        profile,
        sidecarPath: resolveLegacyOAuthSidecarPath(profile.ref, params.env),
      });
    }
  }
  return undecryptable;
}

function formatAgentLabel(store: LegacyOAuthSidecarStore): string {
  return store.agentId ? `agent ${store.agentId}` : "custom agent";
}

function formatUndecryptableProfileLine(entry: UndecryptableLegacyOAuthSidecarProfile): string {
  return `- ${formatAgentLabel(entry.store)}: ${shortenHomePath(entry.store.authPath)} (${entry.profile.profileId}; sidecar ${shortenHomePath(entry.sidecarPath)})`;
}

function uniqueUndecryptableStores(
  entries: UndecryptableLegacyOAuthSidecarProfile[],
): LegacyOAuthSidecarStore[] {
  const seen = new Set<string>();
  const stores: LegacyOAuthSidecarStore[] = [];
  for (const entry of entries) {
    const key = path.resolve(entry.store.authPath);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    stores.push(entry.store);
  }
  return stores;
}

async function confirmInteractiveOnly(
  prompter: Pick<DoctorPrompter, "confirmAutoFix"> &
    Partial<Pick<DoctorPrompter, "confirm" | "confirmInteractiveOnly" | "repairMode">>,
  params: Parameters<DoctorPrompter["confirm"]>[0],
): Promise<boolean> {
  if (prompter.repairMode?.canPrompt === false || prompter.repairMode?.nonInteractive === true) {
    return false;
  }
  if (prompter.confirmInteractiveOnly) {
    return prompter.confirmInteractiveOnly(params);
  }
  return prompter.confirm ? prompter.confirm(params) : prompter.confirmAutoFix(params);
}

function buildNonInteractiveResetWarning(): string {
  return [
    "Could not decrypt legacy OAuth sidecar for one or more non-main agents.",
    "Non-interactive doctor/update runs never reset per-agent auth files.",
    `Run ${formatCliCommand("openclaw doctor")} in an interactive terminal and answer yes to the auth reset prompt if these agents should fall back to main auth.`,
  ].join(" ");
}

async function maybeResetUndecryptableNonMainAuth(params: {
  entries: UndecryptableLegacyOAuthSidecarProfile[];
  stores: LegacyOAuthSidecarStore[];
  result: LegacyOAuthSidecarRepairResult;
  prompter: Pick<DoctorPrompter, "confirmAutoFix"> &
    Partial<Pick<DoctorPrompter, "confirm" | "confirmInteractiveOnly" | "repairMode">>;
  now: () => number;
  emitNotes: boolean;
}): Promise<boolean> {
  const affected = params.entries.filter((entry) => !entry.store.isMain);
  if (affected.length === 0) {
    return false;
  }

  if (params.emitNotes) {
    note(
      [
        "Could not decrypt legacy OAuth sidecar auth for these non-main agents:",
        ...affected.map(formatUndecryptableProfileLine),
        "Custom per-agent auth may be intentional. Choose no to preserve these files unchanged.",
      ].join("\n"),
      "Auth profiles",
    );
  }

  const shouldReset = await confirmInteractiveOnly(params.prompter, {
    message: "Reset auth config for affected non-main agents so they use main auth?",
    initialValue: false,
  });

  if (!shouldReset) {
    if (
      params.prompter.repairMode?.nonInteractive === true ||
      params.prompter.repairMode?.canPrompt === false
    ) {
      params.result.warnings.push(buildNonInteractiveResetWarning());
    }
    return false;
  }

  const resetStores = uniqueUndecryptableStores(affected);
  const resetAuthPaths = new Set(resetStores.map((store) => path.resolve(store.authPath)));
  const remainingRefIds = new Set(
    params.stores
      .filter((store) => !resetAuthPaths.has(path.resolve(store.authPath)))
      .flatMap((store) => store.profiles.map((profile) => profile.ref.id)),
  );
  const affectedSidecars = new Map<string, string>();
  for (const entry of affected) {
    if (!remainingRefIds.has(entry.profile.ref.id)) {
      affectedSidecars.set(entry.profile.ref.id, entry.sidecarPath);
    }
  }

  for (const store of resetStores) {
    try {
      const backupPath = movePathAside(store.authPath, params.now);
      params.result.changes.push(
        `Moved auth config for ${formatAgentLabel(store)} aside so it can use main auth (backup: ${shortenHomePath(backupPath)}).`,
      );
    } catch (err) {
      params.result.warnings.push(
        `Failed to move auth config for ${formatAgentLabel(store)} at ${shortenHomePath(store.authPath)}: ${String(err)}`,
      );
    }
  }

  for (const sidecarPath of affectedSidecars.values()) {
    if (!fs.existsSync(sidecarPath)) {
      continue;
    }
    try {
      const backupPath = movePathAside(sidecarPath, params.now);
      params.result.changes.push(
        `Moved legacy OAuth sidecar aside (backup: ${shortenHomePath(backupPath)}).`,
      );
    } catch (err) {
      params.result.warnings.push(
        `Failed to move legacy OAuth sidecar ${shortenHomePath(sidecarPath)}: ${String(err)}`,
      );
    }
  }

  if (params.result.changes.length > 0) {
    params.result.changes.push(
      `Re-run ${formatCliCommand("openclaw doctor")} to validate auth after the reset.`,
    );
    clearRuntimeAuthProfileStoreSnapshots();
  }
  return params.result.changes.length > 0;
}

export async function maybeRepairLegacyOAuthSidecarProfiles(params: {
  cfg: OpenClawConfig;
  prompter: Pick<DoctorPrompter, "confirmAutoFix"> &
    Partial<Pick<DoctorPrompter, "confirm" | "confirmInteractiveOnly" | "repairMode">>;
  now?: () => number;
  emitNotes?: boolean;
  env?: NodeJS.ProcessEnv;
}): Promise<LegacyOAuthSidecarRepairResult> {
  const now = params.now ?? Date.now;
  const emitNotes = params.emitNotes !== false;
  const env = params.env ?? process.env;
  let stores = listAuthProfileRepairCandidates(params.cfg, env)
    .map(resolveLegacyOAuthSidecarStore)
    .filter((entry): entry is LegacyOAuthSidecarStore => entry !== null);
  let referencedRefIds = new Set(stores.flatMap((entry) => entry.profiles.map((p) => p.ref.id)));
  let unreferencedSidecars = listUnreferencedLegacyOAuthSidecars(referencedRefIds, env);

  const result: LegacyOAuthSidecarRepairResult = {
    detected: [
      ...stores.map((entry) => entry.authPath),
      ...unreferencedSidecars.map((entry) => entry.sidecarPath),
    ],
    changes: [],
    warnings: [],
  };
  if (stores.length === 0 && unreferencedSidecars.length === 0) {
    return result;
  }

  const undecryptableProfiles = findUndecryptableLegacyOAuthSidecarProfiles({
    stores,
    env,
    allowKeychainPrompt: params.prompter.repairMode?.nonInteractive !== true,
  });
  const resetApplied = await maybeResetUndecryptableNonMainAuth({
    entries: undecryptableProfiles,
    stores,
    result,
    prompter: params.prompter,
    now,
    emitNotes,
  });
  if (resetApplied) {
    stores = listAuthProfileRepairCandidates(params.cfg, env)
      .map(resolveLegacyOAuthSidecarStore)
      .filter((entry): entry is LegacyOAuthSidecarStore => entry !== null);
    referencedRefIds = new Set(stores.flatMap((entry) => entry.profiles.map((p) => p.ref.id)));
    unreferencedSidecars = listUnreferencedLegacyOAuthSidecars(referencedRefIds, env);
    if (stores.length === 0 && unreferencedSidecars.length === 0) {
      if (emitNotes && result.changes.length > 0) {
        note(result.changes.map((change) => `- ${change}`).join("\n"), "Doctor changes");
      }
      if (emitNotes && result.warnings.length > 0) {
        note(result.warnings.map((warning) => `- ${warning}`).join("\n"), "Doctor warnings");
      }
      return result;
    }
  }

  if (emitNotes) {
    note(
      [
        ...stores.map(
          (entry) =>
            `- ${shortenHomePath(entry.authPath)} has legacy Codex OAuth profiles to migrate.`,
        ),
        ...(unreferencedSidecars.length > 0
          ? [
              `- Found ${unreferencedSidecars.length} unreferenced legacy Codex OAuth sidecar credential file${unreferencedSidecars.length === 1 ? "" : "s"}.`,
              `- Unreferenced sidecar files are left in place because external agent directories outside this scan may still reference them.`,
            ]
          : []),
        `- ${formatCliCommand("openclaw doctor --fix")} migrates active profiles back to inline OAuth credentials and removes only sidecar files it successfully migrated.`,
      ].join("\n"),
      "Auth profiles",
    );
  }

  const shouldRepair = await params.prompter.confirmAutoFix({
    message: "Migrate legacy Codex OAuth credentials now?",
    initialValue: true,
  });
  if (!shouldRepair) {
    if (emitNotes && result.warnings.length > 0) {
      note(result.warnings.map((warning) => `- ${warning}`).join("\n"), "Doctor warnings");
    }
    return result;
  }

  const migratedSidecarsByRefId = new Map<string, string>();
  const unresolvedRefIds = new Set<string>();
  for (const store of stores) {
    let migratedCount = 0;
    const storeMigratedSidecarsByRefId = new Map<string, string>();
    for (const profile of store.profiles) {
      const material = loadLegacyOAuthSidecarMaterial({ ...profile, env });
      if (!material) {
        unresolvedRefIds.add(profile.ref.id);
        result.warnings.push(
          `Could not decrypt legacy OAuth sidecar for ${profile.profileId} in ${shortenHomePath(store.authPath)}; re-authenticate this profile.`,
        );
        continue;
      }
      if (applyLegacyOAuthSidecarMaterial({ raw: store.raw, profile, material })) {
        migratedCount += 1;
        storeMigratedSidecarsByRefId.set(
          profile.ref.id,
          resolveLegacyOAuthSidecarPath(profile.ref, env),
        );
      } else {
        unresolvedRefIds.add(profile.ref.id);
      }
    }

    if (migratedCount === 0) {
      continue;
    }

    try {
      const backupPath = backupLegacyOAuthSidecarStore(store.authPath, now);
      if (!("version" in store.raw)) {
        store.raw.version = AUTH_STORE_VERSION;
      }
      saveJsonFile(store.authPath, store.raw);
      for (const [refId, sidecarPath] of storeMigratedSidecarsByRefId) {
        migratedSidecarsByRefId.set(refId, sidecarPath);
      }
      result.changes.push(
        `Migrated ${migratedCount} legacy Codex OAuth profile${migratedCount === 1 ? "" : "s"} in ${shortenHomePath(store.authPath)} to inline credentials (backup: ${shortenHomePath(backupPath)}).`,
      );
    } catch (err) {
      for (const refId of storeMigratedSidecarsByRefId.keys()) {
        unresolvedRefIds.add(refId);
      }
      result.warnings.push(
        `Failed to migrate legacy OAuth sidecars in ${shortenHomePath(store.authPath)}: ${String(err)}`,
      );
    }
  }

  for (const [refId, sidecarPath] of migratedSidecarsByRefId) {
    if (unresolvedRefIds.has(refId)) {
      continue;
    }
    try {
      fs.rmSync(sidecarPath, { force: true });
    } catch (err) {
      result.warnings.push(
        `Failed to remove migrated legacy OAuth sidecar ${shortenHomePath(sidecarPath)}: ${String(err)}`,
      );
    }
  }

  if (unreferencedSidecars.length > 0) {
    result.warnings.push(
      `Found ${unreferencedSidecars.length} unreferenced legacy Codex OAuth sidecar credential file${unreferencedSidecars.length === 1 ? "" : "s"}; left in place because external agent directories outside this scan may still reference ${unreferencedSidecars.length === 1 ? "it" : "them"}.`,
    );
  }

  if (result.changes.length > 0) {
    clearRuntimeAuthProfileStoreSnapshots();
  }
  if (emitNotes && result.changes.length > 0) {
    note(result.changes.map((change) => `- ${change}`).join("\n"), "Doctor changes");
  }
  if (emitNotes && result.warnings.length > 0) {
    note(result.warnings.map((warning) => `- ${warning}`).join("\n"), "Doctor warnings");
  }
  return result;
}

export const testing = {
  buildLegacyOAuthSecretAad: legacyOAuthSidecarTestUtils.buildLegacyOAuthSecretAad,
  buildLegacyOAuthSecretKey: legacyOAuthSidecarTestUtils.buildLegacyOAuthSecretKey,
};
export { testing as __testing };
