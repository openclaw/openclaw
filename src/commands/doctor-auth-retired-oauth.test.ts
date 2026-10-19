import { createCipheriv, createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadPersistedAuthProfileStore } from "../agents/auth-profiles/persisted.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "../agents/auth-profiles/runtime-snapshots.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { maybeMigrateAuthProfileJsonStoresToSqlite } from "./doctor-auth-flat-profiles.js";
import { makePrompter } from "./doctor-auth-flat-profiles.test-support.js";

const states: OpenClawTestState[] = [];

async function makeTestState(): Promise<OpenClawTestState> {
  const state = await createOpenClawTestState({
    layout: "home",
    prefix: "openclaw-doctor-retired-oauth-",
    env: { OPENCLAW_AGENT_DIR: undefined },
  });
  states.push(state);
  return state;
}

function migrateAuthProfiles(
  params: Partial<Parameters<typeof maybeMigrateAuthProfileJsonStoresToSqlite>[0]>,
) {
  return maybeMigrateAuthProfileJsonStoresToSqlite({
    cfg: {},
    prompter: makePrompter(true),
    ...params,
  });
}

function writeLegacyAuthProfilesJson(state: OpenClawTestState, value: unknown) {
  return state.writeJson("agents/main/agent/auth-profiles.json", value);
}

function listMigratedArchives(sourcePath: string): string[] {
  return fs
    .readdirSync(path.dirname(sourcePath))
    .filter((entry) => entry.startsWith(`${path.basename(sourcePath)}.migrated-`))
    .map((entry) => path.join(path.dirname(sourcePath), entry));
}

afterEach(async () => {
  clearRuntimeAuthProfileStoreSnapshots();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  for (const state of states.splice(0)) {
    await state.cleanup();
  }
});

describe("Doctor retired OAuth import", () => {
  it("retains auth sources with stale OAuth locators and recovers after the locator is corrected", async () => {
    const state = await makeTestState();
    const id = "0123456789abcdef0123456789abcdef";
    const profileId = "openai-codex:legacy";
    const material = { access: "synthetic-access", refresh: "synthetic-refresh" };
    await state.writeJson(`credentials/auth-profiles/${id}.json`, {
      version: 1,
      profileId,
      provider: "openai-codex",
      ...material,
    });
    const authPath = await writeLegacyAuthProfilesJson(state, {
      version: 1,
      profiles: {
        [profileId]: {
          type: "oauth",
          provider: "openai-codex",
          oauthRef: { source: "openclaw-credentials", provider: "openai-codex", id },
        },
      },
    });
    const original = fs.readFileSync(authPath);
    const result = await migrateAuthProfiles({
      env: { ...state.env, OPENCLAW_OAUTH_DIR: path.join(state.home, "old-oauth-dir") },
    });
    expect(result.warnings.join("\n")).toContain("correct OPENCLAW_OAUTH_DIR");
    expect(fs.readFileSync(authPath)).toEqual(original);
    expect(
      loadPersistedAuthProfileStore(state.agentDir())?.profiles["openai:legacy"],
    ).toBeUndefined();

    const repaired = await migrateAuthProfiles({ env: state.env });
    expect(repaired.warnings).toEqual([]);
    expect(
      loadPersistedAuthProfileStore(state.agentDir())?.profiles["openai:legacy"],
    ).toMatchObject(material);
    expect(fs.existsSync(authPath)).toBe(false);
    expect(fs.readFileSync(listMigratedArchives(authPath)[0]!)).toEqual(original);
  });

  it("imports pre-June oauth.json and preserves rejected entries with recovery instructions", async () => {
    const state = await makeTestState();
    const oauthPath = await state.writeJson("credentials/oauth.json", {
      openai: {
        access: "fake-access-token",
        refresh: "fake-refresh-token",
        expires: 1_900_000_000_000,
      },
      invalid: "synthetic malformed credential",
    });
    const sourceBytes = fs.readFileSync(oauthPath);
    const authPath = await writeLegacyAuthProfilesJson(state, {
      version: 1,
      profiles: {
        "anthropic:default": { type: "api_key", provider: "anthropic", key: "not-a-real" },
      },
    });

    const result = await migrateAuthProfiles({ env: state.env });

    expect(result.warnings).toEqual([
      expect.stringContaining("Could not import 1 legacy OAuth credential entries"),
    ]);
    expect(result.warnings[0]).toContain(path.basename(listMigratedArchives(oauthPath)[0]!));
    expect(fs.existsSync(oauthPath)).toBe(false);
    expect(fs.readFileSync(listMigratedArchives(oauthPath)[0]!)).toEqual(sourceBytes);
    expect(loadPersistedAuthProfileStore(state.agentDir())?.profiles).toEqual({
      "anthropic:default": { type: "api_key", provider: "anthropic", key: "not-a-real" },
      "openai:default": {
        type: "oauth",
        provider: "openai",
        access: "fake-access-token",
        refresh: "fake-refresh-token",
        expires: 1_900_000_000_000,
      },
    });
    expect(fs.existsSync(authPath)).toBe(false);
    expect(listMigratedArchives(authPath)).toHaveLength(1);
  });

  it.each(["plaintext", "encrypted", "fallback-key", "missing-key"] as const)(
    "imports retired OAuth sidecars through SQLite and archives original bytes: %s",
    async (format) => {
      const state = await makeTestState();
      const profileId = "openai-codex:legacy";
      const ref = {
        source: "openclaw-credentials",
        provider: "openai-codex",
        id: "0123456789abcdef0123456789abcdef",
      };
      const material = {
        access: "synthetic-access",
        refresh: "synthetic-refresh",
        idToken: "synthetic-id-token",
      };
      const seed = "synthetic-sidecar-key";
      const env = {
        ...state.env,
        APPDATA: path.join(state.home, "AppData", "Roaming"),
        XDG_CONFIG_HOME: path.join(state.home, ".config"),
      };
      const primaryKeyPath = path.join(
        process.platform === "darwin"
          ? path.join(state.home, "Library", "Application Support", "OpenClaw")
          : process.platform === "win32"
            ? path.join(env.APPDATA, "OpenClaw")
            : path.join(env.XDG_CONFIG_HOME, "openclaw"),
        "auth-profile-secret-key",
      );
      if (format === "encrypted" || format === "fallback-key") {
        fs.mkdirSync(path.dirname(primaryKeyPath), { recursive: true });
        fs.writeFileSync(primaryKeyPath, format === "fallback-key" ? "stale-key" : seed);
      }
      if (format === "fallback-key") {
        const fallback = path.join(state.home, ".openclaw-auth-profile-secrets");
        fs.mkdirSync(fallback, { recursive: true });
        fs.writeFileSync(path.join(fallback, "auth-profile-secret-key"), seed);
      }
      const cipher = createCipheriv(
        "aes-256-gcm",
        createHash("sha256").update(`openclaw:auth-profile-oauth:${seed}`).digest(),
        Buffer.alloc(12, 7),
      );
      cipher.setAAD(Buffer.from(`${ref.id}\0${profileId}\0${ref.provider}`));
      const ciphertext = Buffer.concat([cipher.update(JSON.stringify(material)), cipher.final()]);
      const sidecarPath = await state.writeJson(`credentials/auth-profiles/${ref.id}.json`, {
        version: 1,
        profileId,
        provider: ref.provider,
        ...(format === "plaintext"
          ? material
          : {
              encrypted: {
                algorithm: "aes-256-gcm",
                iv: Buffer.alloc(12, 7).toString("base64url"),
                tag: cipher.getAuthTag().toString("base64url"),
                ciphertext: ciphertext.toString("base64url"),
              },
            }),
      });
      const sidecarBytes = fs.readFileSync(sidecarPath);
      const authPath = await writeLegacyAuthProfilesJson(state, {
        version: 1,
        profiles: {
          [profileId]: {
            type: "oauth",
            provider: ref.provider,
            oauthRef: ref,
            expires: 1_900_000_000_000,
            accountId: "synthetic-account",
          },
        },
      });
      const authBytes = fs.readFileSync(authPath);
      const result = await migrateAuthProfiles({ env });
      const imported = loadPersistedAuthProfileStore(state.agentDir())?.profiles["openai:legacy"];
      expect(imported).toMatchObject({
        type: "oauth",
        provider: "openai",
        accountId: "synthetic-account",
      });
      if (format === "missing-key") {
        expect(imported).not.toHaveProperty("access");
        expect(result.warnings.join("\n")).toContain(
          "openclaw models auth login --provider openai",
        );
        expect(result.warnings.join("\n")).toContain("auth-profile-secret-key");
      } else {
        expect(imported).toMatchObject(material);
        expect(imported).not.toHaveProperty("oauthRef");
        expect(result.warnings).toEqual([]);
      }
      for (const [source, bytes] of [
        [authPath, authBytes],
        [sidecarPath, sidecarBytes],
      ] as const) {
        expect(fs.existsSync(source)).toBe(false);
        expect(fs.readFileSync(listMigratedArchives(source)[0]!)).toEqual(bytes);
      }
      expect(result.changes.join("\n")).toContain(path.basename(sidecarPath));
      expect((await migrateAuthProfiles({ env })).warnings).toEqual([]);
    },
  );
});
