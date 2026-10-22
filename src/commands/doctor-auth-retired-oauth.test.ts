import { createCipheriv, createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
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

let state: OpenClawTestState;
const profileId = "openai-codex:legacy";
const ref = {
  source: "openclaw-credentials",
  provider: "openai-codex",
  id: "0123456789abcdef0123456789abcdef",
};
const material = { access: "fake-access", refresh: "fake-refresh", idToken: "fake-id" };
const accountId = "synthetic-account";
const oauthProfile = { type: "oauth", provider: ref.provider, oauthRef: ref };

beforeEach(async () => {
  state = await createOpenClawTestState({
    layout: "home",
    prefix: "openclaw-doctor-retired-oauth-",
    env: { OPENCLAW_AGENT_DIR: undefined },
  });
});

const migrateAuthProfiles = (env = state.env) =>
  maybeMigrateAuthProfileJsonStoresToSqlite({ cfg: {}, prompter: makePrompter(true), env });

const writeProfiles = (profiles: unknown) =>
  state.writeJson("agents/main/agent/auth-profiles.json", { version: 1, profiles });

function writeSidecar(value: object) {
  return state.writeJson(`credentials/auth-profiles/${ref.id}.json`, {
    version: 1,
    profileId,
    provider: ref.provider,
    ...value,
  });
}

function listMigratedArchives(sourcePath: string): string[] {
  return fs
    .readdirSync(path.dirname(sourcePath))
    .filter((entry) => entry.startsWith(`${path.basename(sourcePath)}.migrated-`))
    .map((entry) => path.join(path.dirname(sourcePath), entry));
}

function expectArchived(source: string, bytes: Buffer) {
  expect(fs.existsSync(source)).toBe(false);
  expect(fs.readFileSync(listMigratedArchives(source)[0]!)).toEqual(bytes);
}

const readProfiles = () => loadPersistedAuthProfileStore(state.agentDir())?.profiles;

afterEach(async () => {
  clearRuntimeAuthProfileStoreSnapshots();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  await state.cleanup();
});

it("retains auth sources with stale OAuth locators and recovers after the locator is corrected", async () => {
  await writeSidecar(material);
  const authPath = await writeProfiles({ [profileId]: oauthProfile });
  const original = fs.readFileSync(authPath);
  const result = await migrateAuthProfiles({
    ...state.env,
    OPENCLAW_OAUTH_DIR: path.join(state.home, "old-oauth-dir"),
  });
  expect(result.warnings.join("\n")).toContain("correct OPENCLAW_OAUTH_DIR");
  expect(fs.readFileSync(authPath)).toEqual(original);
  expect(readProfiles()?.["openai:legacy"]).toBeUndefined();

  const repaired = await migrateAuthProfiles();
  expect(repaired.warnings).toEqual([]);
  expect(readProfiles()?.["openai:legacy"]).toMatchObject(material);
  expectArchived(authPath, original);
});

it("imports pre-June oauth.json and preserves rejected entries with recovery instructions", async () => {
  const { access, refresh } = material;
  const legacyOAuth = { access, refresh, expires: 1_900_000_000_000 };
  const anthropic = { type: "api_key", provider: "anthropic", key: "not-a-real" };
  const oauthPath = await state.writeJson("credentials/oauth.json", {
    openai: legacyOAuth,
    invalid: "synthetic malformed credential",
  });
  const sourceBytes = fs.readFileSync(oauthPath);
  const authPath = await writeProfiles({ "anthropic:default": anthropic });
  const result = await migrateAuthProfiles();
  expect(result.warnings).toEqual([
    expect.stringContaining("Could not import 1 legacy OAuth credential entries"),
  ]);
  expect(result.warnings[0]).toContain(path.basename(listMigratedArchives(oauthPath)[0]!));
  expectArchived(oauthPath, sourceBytes);
  expect(readProfiles()).toEqual({
    "anthropic:default": anthropic,
    "openai:default": { type: "oauth", provider: "openai", ...legacyOAuth },
  });
  expect(fs.existsSync(authPath)).toBe(false);
  expect(listMigratedArchives(authPath)).toHaveLength(1);
});

it.each(["plaintext", "encrypted", "fallback-key", "missing-key"] as const)(
  "imports retired OAuth sidecars through SQLite and archives original bytes: %s",
  async (format) => {
    const seed = "synthetic-sidecar-key";
    const env = {
      ...state.env,
      APPDATA: path.join(state.home, "AppData", "Roaming"),
      XDG_CONFIG_HOME: path.join(state.home, ".config"),
    };
    const primaryKeyPath = path.join(
      state.home,
      process.platform === "darwin"
        ? "Library/Application Support/OpenClaw"
        : process.platform === "win32"
          ? "AppData/Roaming/OpenClaw"
          : ".config/openclaw",
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
    const encrypted = {
      algorithm: "aes-256-gcm",
      iv: Buffer.alloc(12, 7).toString("base64url"),
      tag: cipher.getAuthTag().toString("base64url"),
      ciphertext: ciphertext.toString("base64url"),
    };
    const sidecarPath = await writeSidecar(format === "plaintext" ? material : { encrypted });
    const sidecarBytes = fs.readFileSync(sidecarPath);
    const authPath = await writeProfiles({
      [profileId]: {
        ...oauthProfile,
        expires: 1_900_000_000_000,
        accountId,
      },
    });
    const authBytes = fs.readFileSync(authPath);
    const result = await migrateAuthProfiles(env);
    const imported = readProfiles()?.["openai:legacy"];
    expect(imported).toMatchObject({ type: "oauth", provider: "openai", accountId });
    if (format === "missing-key") {
      expect(imported).not.toHaveProperty("access");
      expect(result.warnings.join("\n")).toContain("openclaw models auth login --provider openai");
      expect(result.warnings.join("\n")).toContain("auth-profile-secret-key");
    } else {
      expect(imported).toMatchObject(material);
      expect(imported).not.toHaveProperty("oauthRef");
      expect(result.warnings).toEqual([]);
    }
    expectArchived(authPath, authBytes);
    expectArchived(sidecarPath, sidecarBytes);
    expect(result.changes.join("\n")).toContain(path.basename(sidecarPath));
    expect((await migrateAuthProfiles(env)).warnings).toEqual([]);
  },
);
