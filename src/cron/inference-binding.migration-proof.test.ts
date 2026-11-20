// Task-only investigation harness; no production changes and no provider/network I/O.
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { captureAuthProfileAuthorization } from "../agents/auth-profiles/authorization.js";
import { createOAuthManager } from "../agents/auth-profiles/oauth-manager.js";
import { mockOAuthProviderOperations } from "../agents/auth-profiles/oauth-native-provider.test-support.js";
import {
  prepareSharedAuthStoreOwnership,
  resolveSharedAuthStoreOwnership,
  resolveSharedAuthStorePath,
} from "../agents/auth-profiles/path-resolve.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "../agents/auth-profiles/runtime-snapshots.js";
import {
  closeAuthProfileReadPool,
  readPersistedAuthProfileStoreRaw,
  readPersistedSharedAuthProfileStoreRaw,
  writePersistedAuthProfileStoreRaw,
  writePersistedAuthProfileStateRaw,
} from "../agents/auth-profiles/sqlite.js";
import { loadAuthProfileStoreWithoutExternalProfilesAsync } from "../agents/auth-profiles/store-runtime.js";
import type { OAuthCredential } from "../agents/auth-profiles/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  detectSharedAuthStoreMigration,
  migrateSharedAuthStore,
} from "../infra/state-migrations.shared-auth-store.js";
import { persistProviderAuthProfileBatch } from "../plugins/provider-auth-persistence.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { makeCronJob } from "./delivery.test-helpers.js";
import type { CronInferenceBinding } from "./inference-binding.js";
import {
  captureCronInferenceBinding,
  acquireCronInferenceAuthorization,
} from "./inference-binding.runtime.js";
import { loadCronJobsStore, saveCronJobsStore } from "./store.js";

const root = process.env.AUTH_PROOF_ROOT!;
const phase = process.env.AUTH_PROOF_PHASE!;
const profileId = "openai:synthetic-migration";
const artifactDir = path.resolve(".openclaw/tmp/auth-migration-proof");
createRequire(import.meta.url)(path.join(artifactDir, "deny-network.cjs"));
const expires = 4_102_444_800_000;
function oauth(accountId = "synthetic-account-A"): OAuthCredential {
  return {
    type: "oauth",
    provider: "openai",
    accountId,
    access: "synthetic-access-A",
    refresh: "synthetic-refresh-A",
    expires,
  };
}
function select(caseName: string) {
  const stateDir = path.join(root, caseName);
  const agentDir = path.join(stateDir, "agents/main/agent");
  for (const [name, value] of Object.entries({
    HOME: path.join(root, "home"),
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: path.join(stateDir, "absent-config.json"),
    OPENCLAW_AGENT_DIR: "",
    PI_CODING_AGENT_DIR: "",
    NODE_OPTIONS: "--require=" + path.join(artifactDir, "deny-network.cjs"),
  }))
    vi.stubEnv(name, value);
  fs.mkdirSync(agentDir, { recursive: true });
  const cfg: OpenClawConfig = {
    agents: { entries: { main: { agentDir } }, defaults: { model: "openai/gpt-4.1" } },
    auth: {
      profiles: { [profileId]: { provider: "openai", mode: "oauth" } },
      order: { openai: [profileId] },
    },
  };
  return { stateDir, agentDir, cfg, storePath: path.join(stateDir, "cron/jobs.json") };
}
type Fixture = ReturnType<typeof select>;
async function close() {
  clearRuntimeAuthProfileStoreSnapshots();
  closeAuthProfileReadPool();
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
}
afterEach(async () => {
  await close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
async function settled<T>(run: () => Promise<T>): Promise<T> {
  const work = new AsyncWorkScope();
  try {
    return await work.run(run);
  } finally {
    await work.drain();
  }
}
async function capture(f: Fixture) {
  const binding = await settled(() =>
    captureCronInferenceBinding({
      cfg: f.cfg,
      agentId: "main",
      sessionEntry: {
        sessionId: "synthetic-creator",
        updatedAt: 1,
        modelProvider: "openai",
        model: "gpt-4.1",
        authProfileOverride: profileId,
        authProfileOverrideSource: "user",
      },
      runtimeSessionEntry: { agentRuntimeOverride: "openclaw" },
    }),
  );
  expect(binding).toMatchObject({
    profileId,
    runtime: "openclaw",
    authRequirement: "subscription",
  });
  if (!binding) throw new Error("No stored binding captured");
  return binding;
}
async function guard(f: Fixture, binding: CronInferenceBinding) {
  return settled(async () => {
    const auth = await acquireCronInferenceAuthorization({
      cfg: f.cfg,
      agentDir: f.agentDir,
      binding,
    });
    try {
      auth.assertCurrent();
      await auth.revalidate();
      return auth.authorizationId;
    } finally {
      auth.dispose();
    }
  });
}
async function saved(f: Fixture) {
  const store = await loadCronJobsStore(f.storePath);
  const binding = store.jobs[0]?.inferenceBinding;
  if (!binding) throw new Error("No persisted original binding");
  return binding;
}
function emit(caseName: string, data: Record<string, unknown>) {
  const result = { phase, caseName, pid: process.pid, ...data };
  fs.writeFileSync(
    path.join(root, phase + "-" + caseName + ".json"),
    JSON.stringify(result, null, 2),
  );
  console.log("AUTH_PROOF " + JSON.stringify(result));
}
function diskRows(f: Fixture, central: boolean) {
  const db = new DatabaseSync(
    central
      ? path.join(f.stateDir, "state/openclaw.sqlite")
      : path.join(f.agentDir, "openclaw-agent.sqlite"),
    { readOnly: true },
  );
  try {
    return Object.fromEntries(
      ["store", "state"].map((kind) => [
        kind,
        central
          ? (db
              .prepare(
                "SELECT value_json AS json, updated_at_ms AS updatedAt FROM config_machine_state WHERE state_key=?",
              )
              .get("authProfiles." + kind) ?? null)
          : (db
              .prepare(
                "SELECT " +
                  kind +
                  "_json AS json, updated_at AS updatedAt FROM auth_profile_" +
                  kind +
                  " WHERE " +
                  kind +
                  "_key='primary'",
              )
              .get() ?? null),
      ]),
    );
  } finally {
    db.close();
  }
}
function raw() {
  return readPersistedSharedAuthProfileStoreRaw(process.env);
}
function snapshot(f: Fixture) {
  return {
    sharedPath: resolveSharedAuthStorePath(),
    ownership: resolveSharedAuthStoreOwnership(),
    store: raw(),
    local: readPersistedAuthProfileStoreRaw(f.agentDir),
  };
}

it(
  "offline cold-process authorization investigation: " + phase,
  async () => {
    expect(path.isAbsolute(root)).toBe(true);
    expect(root.startsWith(artifactDir + path.sep)).toBe(true);
    if (phase === "seed") {
      for (const caseName of ["migration", "replacement", "missing-lifetime"]) {
        const f = select(caseName);
        if (fs.existsSync(path.join(f.agentDir, "openclaw-agent.sqlite"))) {
          await prepareSharedAuthStoreOwnership();
          const binding = await saved(f);
          expect(await guard(f, binding)).toBe(binding.authorizationId);
          await close();
          emit(caseName, { result: "accepted-resumed-persisted-seed", binding, ...snapshot(f) });
          await close();
          continue;
        }
        writePersistedAuthProfileStoreRaw(
          { version: 1, profiles: { [profileId]: oauth() } },
          f.agentDir,
        );
        writePersistedAuthProfileStateRaw(
          { version: 1, order: { openai: [profileId] }, lastGood: { openai: profileId } },
          f.agentDir,
        );
        await prepareSharedAuthStoreOwnership();
        expect(resolveSharedAuthStoreOwnership().location).toBe("legacy-main");
        expect(raw()).not.toHaveProperty("authorizationLifetimes");
        const binding = await capture(f);
        expect(await guard(f, binding)).toBe(binding.authorizationId);
        await saveCronJobsStore(f.storePath, {
          version: 1,
          jobs: [
            makeCronJob({
              id: "synthetic-heartbeat",
              name: "synthetic-heartbeat",
              inferenceBinding: binding,
            }),
          ],
        });
        await close();
        const state = snapshot(f);
        expect(state.store).toHaveProperty(["authorizationLifetimes", profileId]);
        emit(caseName, { result: "accepted", binding, ...state });
        await close();
      }
    } else if (phase === "reload" || phase === "reload-refresh") {
      const f = select("migration");
      await prepareSharedAuthStoreOwnership();
      const binding = await saved(f);
      expect(await guard(f, binding)).toBe(binding.authorizationId);
      emit("migration", { result: "accepted", binding, ...snapshot(f) });
    } else if (phase === "refresh") {
      const f = select("migration");
      await prepareSharedAuthStoreOwnership();
      const binding = await saved(f);
      expect(await guard(f, binding)).toBe(binding.authorizationId);
      const refreshCredential = vi.fn(async () => ({
        access: "synthetic-access-refreshed",
        refresh: "synthetic-refresh-refreshed",
        expires,
        accountId: "synthetic-account-A",
      }));
      mockOAuthProviderOperations({ refreshCredential });
      const store = await loadAuthProfileStoreWithoutExternalProfilesAsync(f.agentDir);
      const credential = store.profiles[profileId];
      if (credential?.type !== "oauth") throw new Error("Expected OAuth");
      await createOAuthManager().resolveOAuthAccess({
        store,
        profileId,
        credential,
        agentDir: f.agentDir,
        forceRefresh: true,
      });
      expect(refreshCredential).toHaveBeenCalledOnce();
      expect(await guard(f, binding)).toBe(binding.authorizationId);
      await close();
      expect(raw()).toHaveProperty(["profiles", profileId, "access"], "synthetic-access-refreshed");
      emit("migration", { result: "accepted", binding, ...snapshot(f) });
    } else if (phase === "migrate" || phase === "migrate-resume") {
      const f = select("migration");
      await prepareSharedAuthStoreOwnership();
      const binding = await saved(f);
      expect(await guard(f, binding)).toBe(binding.authorizationId);
      await close();
      const before = snapshot(f);
      await close();
      const diskBefore = diskRows(f, false);
      const detected = await detectSharedAuthStoreMigration({
        stateDir: f.stateDir,
        env: process.env,
        config: f.cfg,
        doctorOnlyStateMigrations: true,
      });
      expect(detected.hasLegacy).toBe(true);
      const receipt = await migrateSharedAuthStore({
        detected,
        stateDir: f.stateDir,
        env: process.env,
      });
      emit("migration-attempt", { detected, receipt, before, diskBefore });
      expect(receipt.warnings).toEqual([]);
      expect(receipt.changes).toContain("Relocated shared auth profiles into shared SQLite state.");
      await close();
      const after = snapshot(f);
      const diskAfter = diskRows(f, true);
      expect(diskAfter).toEqual(diskBefore);
      expect(after.ownership.location).toBe("state-db");
      expect(after.store).toEqual(before.store);
      expect(after.local).toBeNull();
      expect(await saved(f)).toEqual(binding);
      emit("migration", {
        result: "migrated-identical-store",
        binding,
        detected,
        receipt,
        before,
        after,
        diskBefore,
        diskAfter,
      });
    } else if (phase === "reload-migrate") {
      const f = select("migration");
      await prepareSharedAuthStoreOwnership();
      const binding = await saved(f);
      let failure: string | undefined;
      try {
        await guard(f, binding);
      } catch (error) {
        failure = String(error);
      }
      const current = await captureAuthProfileAuthorization({
        profileId,
        agentDir: f.agentDir,
        cfg: f.cfg,
        assertCurrent() {},
      });
      const currentId = current.authorizationId;
      current.dispose();
      emit("migration", {
        result: failure ? "rejected" : "accepted",
        failure,
        originalAuthorizationId: binding.authorizationId,
        currentAuthorizationId: currentId,
        ...snapshot(f),
      });
      // The invariant we want: a real, byte-preserving migration must keep the original authorization.
      expect(
        failure,
        "legitimate migration must preserve the original automation binding",
      ).toBeUndefined();
    } else if (phase === "replace" || phase === "replace-resume") {
      const f = select("replacement");
      await prepareSharedAuthStoreOwnership();
      const binding = await saved(f);
      expect(await guard(f, binding)).toBe(binding.authorizationId);
      await persistProviderAuthProfileBatch({
        profiles: [
          {
            profileId,
            credential: {
              ...oauth("synthetic-account-B"),
              access: "synthetic-access-B",
              refresh: "synthetic-refresh-B",
            },
          },
        ],
        config: f.cfg,
        stateDir: f.stateDir,
      });
      await close();
      expect(raw()).toHaveProperty(["profiles", profileId, "accountId"], "synthetic-account-B");
      emit("replacement", {
        result: "replaced-by-real-provider-persistence",
        binding,
        ...snapshot(f),
      });
    } else if (phase === "reload-replace" || phase === "reload-missing") {
      const caseName = phase === "reload-replace" ? "replacement" : "missing-lifetime";
      const f = select(caseName);
      await prepareSharedAuthStoreOwnership();
      const binding = await saved(f);
      await expect(guard(f, binding)).rejects.toThrow(
        "was replaced. Explicitly select an authorized account again.",
      );
      emit(caseName, { result: "rejected-as-required", binding, ...snapshot(f) });
    } else if (phase === "post-replace") {
      const f = select("migration");
      await prepareSharedAuthStoreOwnership();
      // A separate new synthetic control, not a rewrite of the original saved automation.
      const binding = await capture(f);
      expect(await guard(f, binding)).toBe(binding.authorizationId);
      const before = snapshot(f);
      await persistProviderAuthProfileBatch({
        profiles: [
          {
            profileId,
            credential: {
              ...oauth("synthetic-account-B"),
              access: "synthetic-access-B",
              refresh: "synthetic-refresh-B",
            },
          },
        ],
        config: f.cfg,
        stateDir: f.stateDir,
      });
      await close();
      expect(raw()).toHaveProperty(["profiles", profileId, "accountId"], "synthetic-account-B");
      emit("migration", {
        result: "new-binding-accepted-then-account-replaced",
        binding,
        before,
        after: snapshot(f),
      });
    } else if (phase === "reload-post-replace") {
      const f = select("migration");
      await prepareSharedAuthStoreOwnership();
      const previous = JSON.parse(
        fs.readFileSync(path.join(root, "post-replace-migration.json"), "utf8"),
      );
      await expect(guard(f, previous.binding)).rejects.toThrow(
        "was replaced. Explicitly select an authorized account again.",
      );
      emit("migration", { result: "replacement-rejected-after-real-migration", ...snapshot(f) });
    } else if (phase === "remove-lifetime") {
      // Separate corruption control ONLY. The main migration fixture never removes metadata.
      const f = select("missing-lifetime");
      await prepareSharedAuthStoreOwnership();
      const binding = await saved(f);
      expect(await guard(f, binding)).toBe(binding.authorizationId);
      await close();
      const db = new DatabaseSync(path.join(f.agentDir, "openclaw-agent.sqlite"));
      try {
        const row = db
          .prepare("SELECT store_json FROM auth_profile_store WHERE store_key='primary'")
          .get();
        const value = JSON.parse(String(row?.store_json));
        delete value.authorizationLifetimes;
        db.prepare("UPDATE auth_profile_store SET store_json=? WHERE store_key='primary'").run(
          JSON.stringify(value),
        );
      } finally {
        db.close();
      }
      emit("missing-lifetime", {
        result: "metadata-removed-in-separate-offline-corruption-control",
      });
    } else {
      throw new Error("Unknown proof phase: " + phase);
    }
  },
  120_000,
);
