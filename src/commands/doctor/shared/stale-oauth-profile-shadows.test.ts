import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  coercePersistedAuthProfileStore,
  loadPersistedAuthProfileStore,
} from "../../../agents/auth-profiles/persisted.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "../../../agents/auth-profiles/runtime-snapshots.js";
import { writePersistedAuthProfileStoreRaw } from "../../../agents/auth-profiles/sqlite.js";
import { saveAuthProfileStore } from "../../../agents/auth-profiles/store-runtime.js";
import type { AuthProfileStore, OAuthCredential } from "../../../agents/auth-profiles/types.js";
import { captureEnv } from "../../../test-utils/env.js";
import { cleanupSessionStateForTest } from "../../../test-utils/session-state-cleanup.js";
import { resolveLegacyAuthProfilesPath as resolveAuthStorePath } from "../../doctor-auth-legacy-paths.js";
import { beginDoctorMaintenance } from "../../doctor-maintenance.js";
import {
  collectStaleOAuthProfileShadowWarnings,
  repairStaleOAuthProfileShadows,
  scanStaleOAuthProfileShadows,
} from "./stale-oauth-profile-shadows.js";

function oauthCredential(overrides: Partial<OAuthCredential>): OAuthCredential {
  return {
    type: "oauth",
    provider: "anthropic",
    access: "access",
    refresh: "refresh",
    expires: Date.now() + 60 * 60 * 1000,
    ...overrides,
  };
}

function storeWith(profileId: string, overrides: Partial<OAuthCredential>): AuthProfileStore {
  return {
    version: 1,
    profiles: { [profileId]: oauthCredential(overrides) },
  };
}

const oauthRef = {
  source: "openclaw-credentials",
  provider: "openai-codex",
  id: "0123456789abcdef0123456789abcdef",
} as const;

async function writeRawAuthStore(
  agentDir: string,
  store: { version: number; profiles: Record<string, unknown> },
): Promise<void> {
  const hasLegacySidecarRef = Object.values(store.profiles).some(
    (profile) => typeof profile === "object" && profile !== null && "oauthRef" in profile,
  );
  if (hasLegacySidecarRef) {
    const authPath = resolveAuthStorePath(agentDir);
    await fs.mkdir(path.dirname(authPath), { recursive: true });
    await fs.writeFile(authPath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  }
  const canonical = coercePersistedAuthProfileStore(store);
  if (canonical) {
    saveAuthProfileStore(canonical, agentDir, {
      filterExternalAuthProfiles: false,
      syncExternalCli: false,
    });
  }
}

describe("stale OAuth profile shadow doctor repair", () => {
  const envSnapshot = captureEnv(["OPENCLAW_AGENT_DIR", "OPENCLAW_STATE_DIR", "OPENCLAW_HOME"]);
  let tempRoot = "";
  let stateDir = "";
  let childAgentDir = "";
  let now = 0;
  let profileId = "";
  const loadChild = () => loadPersistedAuthProfileStore(childAgentDir);
  const scan = (env = process.env) => scanStaleOAuthProfileShadows({ cfg: {}, env, now });
  const repair = (env = process.env) => repairStaleOAuthProfileShadows({ cfg: {}, env });
  function shadow(role: "main" | "child", overrides: Partial<OAuthCredential> = {}) {
    return storeWith(profileId, {
      provider: profileId.split(":")[0],
      access: `${role}-access`,
      refresh: `${role}-refresh`,
      expires: now + (role === "main" ? 3_600_000 : -60_000),
      accountId: "acct-shared",
      ...overrides,
    });
  }
  async function writePair(local = shadow("child"), main = shadow("main")) {
    await writeRawAuthStore(childAgentDir, local);
    saveAuthProfileStore(main);
  }

  beforeEach(async () => {
    clearRuntimeAuthProfileStoreSnapshots();
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-stale-oauth-shadow-"));
    stateDir = path.join(tempRoot, "state");
    childAgentDir = path.join(stateDir, "agents", "telegram", "agent");
    now = Date.now();
    profileId = "anthropic:default";
    vi.spyOn(Date, "now").mockReturnValue(now);
    process.env.OPENCLAW_STATE_DIR = stateDir;
    process.env.OPENCLAW_HOME = stateDir;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    clearRuntimeAuthProfileStoreSnapshots();
    try {
      await cleanupSessionStateForTest({ stateDir, rootPath: tempRoot });
    } finally {
      envSnapshot.restore();
    }
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it("does not classify a cross-tenant GitHub Copilot profile as a removable shadow", async () => {
    profileId = "github-copilot:default";
    await writePair(
      shadow("child", { enterpriseUrl: "acme.ghe.com", accountId: undefined }),
      shadow("main", { enterpriseUrl: "other.ghe.com", accountId: "acct-main" }),
    );
    await expect(repair()).resolves.toEqual({ changes: [], warnings: [] });
    expect(loadChild()?.profiles[profileId]).toBeDefined();
  });

  it("uses the injected env for the main auth store", async () => {
    const injectedStateDir = path.join(tempRoot, "injected-state");
    const injectedEnv = {
      ...process.env,
      OPENCLAW_STATE_DIR: injectedStateDir,
      OPENCLAW_HOME: injectedStateDir,
    };
    saveAuthProfileStore(
      storeWith(profileId, {
        expires: now + 60 * 60 * 1000,
        accountId: "acct-process-env",
      }),
      undefined,
    );
    await writeRawAuthStore(
      path.join(injectedStateDir, "agents", "main", "agent"),
      shadow("main", { accountId: "acct-injected-env" }),
    );
    const injectedChildDir = path.join(injectedStateDir, "agents", "telegram", "agent");
    await writeRawAuthStore(injectedChildDir, shadow("child", { accountId: "acct-injected-env" }));

    const { hits } = await scanStaleOAuthProfileShadows({ cfg: {}, env: injectedEnv, now });

    expect(hits).toEqual([
      expect.objectContaining({
        authPath: resolveAuthStorePath(injectedChildDir),
        profileId,
      }),
    ]);
  });

  it.each(["legacy JSON", "canonical store"])(
    "preserves sidecar-backed OAuth profiles in %s",
    async (source) => {
      profileId = "openai-codex:default";
      await writeRawAuthStore(childAgentDir, {
        version: 1,
        profiles: {
          [profileId]: {
            type: "oauth",
            provider: "openai-codex",
            accountId: "acct-shared",
            expires: now - 60_000,
            oauthRef,
          },
        },
      });
      if (source === "canonical store") {
        await fs.unlink(resolveAuthStorePath(childAgentDir));
      } else {
        saveAuthProfileStore(
          storeWith(profileId, {
            provider: "openai-codex",
            expires: now - 60_000,
            accountId: "acct-shared",
          }),
          childAgentDir,
          { syncExternalCli: false },
        );
      }
      saveAuthProfileStore(shadow("main"));

      const result = await repair();
      expect(result).toEqual({ changes: [], warnings: [] });
      const preserved = loadChild()?.profiles[profileId];
      expect(preserved).toBeDefined();
      if (source === "canonical store") {
        expect(preserved).toHaveProperty("oauthRef");
      } else {
        expect(await fs.readFile(resolveAuthStorePath(childAgentDir), "utf8")).toContain(
          "oauthRef",
        );
      }
    },
  );

  it.each(["corrupt JSON", "non-object JSON", "read error"])(
    "preserves canonical OAuth profiles and warns for legacy %s",
    async (failure) => {
      const childStore = shadow("child", { refresh: "refresh" });
      await writePair(childStore, shadow("main", { refresh: "refresh" }));
      const authPath = resolveAuthStorePath(childAgentDir);
      if (failure === "read error") {
        await fs.mkdir(authPath);
      } else {
        await fs.writeFile(authPath, failure === "corrupt JSON" ? '{"profiles":' : "null");
      }

      const result = await repair();
      expect(loadChild()?.profiles).toEqual(childStore.profiles);
      expect(result.changes).toEqual([]);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain(
        path.join("$OPENCLAW_HOME", "agents", "telegram", "agent", "auth-profiles.json"),
      );
      expect(result.warnings[0]).toContain("Inspect or restore");
    },
  );

  it("retires a local OAuth copy against OPENCLAW_AGENT_DIR under maintenance, preserving authored order", async () => {
    const mainDir = path.join(tempRoot, "relocated-main-agent");
    const env = { ...process.env, OPENCLAW_AGENT_DIR: mainDir };
    const localId = "anthropic:local";
    const localCredential = oauthCredential({ accountId: "acct-local" });
    const localHealth = { errorCount: 1, lastUsed: now - 1_000 };
    const order = [localId, profileId, "anthropic:missing"];
    await writeRawAuthStore(mainDir, shadow("main"));
    const sharedBefore = loadPersistedAuthProfileStore(mainDir);
    writePersistedAuthProfileStoreRaw(
      {
        version: 1,
        profiles: {
          ...shadow("child").profiles,
          [localId]: localCredential,
        },
        order: { anthropic: order },
        lastGood: { anthropic: profileId },
        usageStats: {
          [localId]: localHealth,
          [profileId]: {
            cooldownReason: "auth",
            failureCounts: { auth: 2 },
          },
        },
      },
      childAgentDir,
    );
    const { hits } = await scan(env);
    expect(hits).toEqual([
      expect.objectContaining({ authPath: resolveAuthStorePath(childAgentDir), profileId }),
    ]);
    const warnings = collectStaleOAuthProfileShadowWarnings({
      hits,
      doctorFixCommand: "openclaw doctor --fix",
    });
    expect(warnings[0]).toContain("openclaw doctor --fix");
    expect(loadChild()?.profiles[profileId]).toBeDefined();

    await cleanupSessionStateForTest({ stateDir });
    const maintenance = await beginDoctorMaintenance({
      root: null,
      options: { repair: true },
      runtime: { log() {}, error() {}, exit() {} },
    });
    if (!maintenance) {
      throw new Error("Doctor did not acquire maintenance");
    }
    let result;
    try {
      result = await maintenance.run(() => repair(env));
    } finally {
      await maintenance.release();
    }

    expect(result.warnings).toEqual([]);
    expect(result.changes).toHaveLength(1);
    const childStore = loadChild();
    expect(childStore?.profiles).toEqual({ [localId]: localCredential });
    expect(childStore?.usageStats).toEqual({ [localId]: localHealth });
    expect(childStore?.order?.anthropic).toEqual(order);
    expect(childStore?.lastGood?.anthropic).toBeUndefined();
    expect(loadPersistedAuthProfileStore(mainDir)).toEqual(sharedBefore);
  });

  it.each(["fresh credential", "sidecar reference", "corrupt legacy file"])(
    "rechecks a %s introduced after the scan before removal",
    async (change) => {
      profileId = "openai-codex:default";
      const credential = oauthCredential({
        provider: "openai-codex",
        expires: now - 60_000,
        accountId: "acct-shared",
      });
      const childStore = storeWith(profileId, credential);
      await writePair(childStore, shadow("main", { access: "access", refresh: "refresh" }));
      const authPath = resolveAuthStorePath(childAgentDir);
      await fs.writeFile(authPath, "{}");
      const keptStore = structuredClone(childStore);
      if (change !== "corrupt legacy file") {
        keptStore.profiles[profileId] = {
          ...credential,
          ...(change === "fresh credential" ? { expires: now + 7_200_000 } : { oauthRef }),
        };
      }
      const readFile = fs.readFile;
      let reads = 0;
      vi.spyOn(fs, "readFile").mockImplementation(async (file, options) => {
        if (file === authPath && ++reads === 2) {
          if (change === "corrupt legacy file") {
            await fs.writeFile(authPath, '{"profiles":');
          } else {
            saveAuthProfileStore(keptStore, childAgentDir, { syncExternalCli: false });
          }
        }
        return readFile(file, options);
      });

      const result = await repair();

      expect(result.changes).toEqual([]);
      expect(loadChild()?.profiles).toEqual(keptStore.profiles);
      expect(result.warnings).toHaveLength(change === "corrupt legacy file" ? 1 : 0);
      if (change === "corrupt legacy file") {
        expect(result.warnings[0]).toContain(
          path.join("$OPENCLAW_HOME", "agents", "telegram", "agent", "auth-profiles.json"),
        );
      }
    },
  );

  it("does not create an absent child auth store", async () => {
    saveAuthProfileStore(storeWith("anthropic:default", {}));
    const result = await repairStaleOAuthProfileShadows({
      cfg: { agents: { entries: { telegram: {} } } },
    });

    expect(result).toEqual({ changes: [], warnings: [] });
    expect(loadChild()).toBeNull();
  });
});
