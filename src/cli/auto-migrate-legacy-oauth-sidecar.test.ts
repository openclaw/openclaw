import { createCipheriv } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRuntimeAuthProfileStoreSnapshots } from "../agents/auth-profiles/store.js";
import { testing as oauthSidecarTesting } from "../commands/doctor-auth-oauth-sidecar.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { maybeAutoMigrateLegacyOAuthSidecarOnInteractiveCli } from "./auto-migrate-legacy-oauth-sidecar.js";

const DECLINE_MARKER_FILENAME = "legacy-oauth-sidecar-migration-declined";

const states: OpenClawTestState[] = [];

function setPlatform(value: NodeJS.Platform): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value, configurable: true });
  return () => {
    if (descriptor) {
      Object.defineProperty(process, "platform", descriptor);
    }
  };
}

function declineMarkerPath(state: OpenClawTestState): string {
  return state.statePath(DECLINE_MARKER_FILENAME);
}

async function makeStateWithLegacyOauthRef(seed: string): Promise<{
  state: OpenClawTestState;
  authPath: string;
  sidecarPath: string;
  profileId: string;
}> {
  const state = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-auto-migrate-sidecar-",
    env: {
      OPENCLAW_AGENT_DIR: undefined,
      OPENCLAW_AUTH_PROFILE_SECRET_KEY: seed,
    },
  });
  states.push(state);
  const profileId = "openai-codex:default";
  const ref = {
    source: "openclaw-credentials" as const,
    provider: "openai-codex" as const,
    id: "0123456789abcdef0123456789abcdef",
  };
  const authPath = await state.writeAuthProfiles({
    version: 1,
    profiles: {
      [profileId]: {
        type: "oauth",
        provider: "openai-codex",
        expires: 1777777777000,
        oauthRef: ref,
      },
    },
    order: { "openai-codex": [profileId] },
    lastGood: { "openai-codex": profileId },
  });
  const iv = Buffer.alloc(12, 7);
  const cipher = createCipheriv(
    "aes-256-gcm",
    oauthSidecarTesting.buildLegacyOAuthSecretKey(seed),
    iv,
  );
  cipher.setAAD(
    oauthSidecarTesting.buildLegacyOAuthSecretAad({
      ref,
      profileId,
      provider: "openai-codex",
    }),
  );
  const ciphertext = Buffer.concat([
    cipher.update(
      JSON.stringify({ access: "access-token", refresh: "refresh-token", idToken: "id-token" }),
      "utf8",
    ),
    cipher.final(),
  ]);
  const sidecarPath = await state.writeJson(
    path.join("credentials", "auth-profiles", `${ref.id}.json`),
    {
      version: 1,
      profileId,
      provider: "openai-codex",
      encrypted: {
        algorithm: "aes-256-gcm",
        iv: iv.toString("base64url"),
        tag: cipher.getAuthTag().toString("base64url"),
        ciphertext: ciphertext.toString("base64url"),
      },
    },
  );
  return { state, authPath, sidecarPath, profileId };
}

afterEach(async () => {
  clearRuntimeAuthProfileStoreSnapshots();
  for (const state of states.splice(0)) {
    await state.cleanup();
  }
});

describe("maybeAutoMigrateLegacyOAuthSidecarOnInteractiveCli", () => {
  let restorePlatform: () => void;

  beforeEach(() => {
    restorePlatform = setPlatform("darwin");
  });

  afterEach(() => {
    restorePlatform();
  });

  it.each<{ name: string; setup: () => Promise<{ env: NodeJS.ProcessEnv; isTty?: boolean }> }>([
    {
      name: "non-darwin platform",
      setup: async () => {
        restorePlatform();
        restorePlatform = setPlatform("linux");
        return { env: { HOME: "/tmp" } };
      },
    },
    {
      name: "non-TTY",
      setup: async () => {
        const { state } = await makeStateWithLegacyOauthRef("seed");
        return { env: state.env, isTty: false };
      },
    },
    {
      name: "OPENCLAW_AUTO_MIGRATE_LEGACY_OAUTH_SIDECAR=0 opt-out",
      setup: async () => {
        const { state } = await makeStateWithLegacyOauthRef("seed");
        return { env: { ...state.env, OPENCLAW_AUTO_MIGRATE_LEGACY_OAUTH_SIDECAR: "0" } };
      },
    },
    {
      name: "CI=true",
      setup: async () => {
        const { state } = await makeStateWithLegacyOauthRef("seed");
        return { env: { ...state.env, CI: "true" } };
      },
    },
    {
      name: "OPENCLAW_AUTH_STORE_READONLY=1 (embedded path)",
      setup: async () => {
        const { state } = await makeStateWithLegacyOauthRef("seed");
        return { env: { ...state.env, OPENCLAW_AUTH_STORE_READONLY: "1" } };
      },
    },
    {
      name: "no sidecar files",
      setup: async () => {
        const state = await createOpenClawTestState({
          layout: "state-only",
          prefix: "openclaw-auto-migrate-empty-",
        });
        states.push(state);
        return { env: state.env };
      },
    },
  ])("does not prompt or migrate when skipped: $name", async ({ setup }) => {
    const { env, isTty = true } = await setup();
    const confirm = vi.fn();
    await maybeAutoMigrateLegacyOAuthSidecarOnInteractiveCli({
      argv: ["node", "openclaw", "status"],
      env,
      isInteractiveTty: () => isTty,
      prompter: { confirm },
    });
    expect(confirm).not.toHaveBeenCalled();
  });

  it.each(["doctor", "update", "completion"])(
    "does not prompt for the %s primary command",
    async (primary) => {
      const { state } = await makeStateWithLegacyOauthRef("seed");
      const confirm = vi.fn();
      await maybeAutoMigrateLegacyOAuthSidecarOnInteractiveCli({
        argv: ["node", "openclaw", primary],
        env: state.env,
        isInteractiveTty: () => true,
        prompter: { confirm },
      });
      expect(confirm).not.toHaveBeenCalled();
    },
  );

  it("migrates legacy oauthRef profiles when the user accepts", async () => {
    const { state, authPath, sidecarPath, profileId } =
      await makeStateWithLegacyOauthRef("legacy-oauth-seed");
    const confirm = vi.fn(async () => true);
    await maybeAutoMigrateLegacyOAuthSidecarOnInteractiveCli({
      argv: ["node", "openclaw", "status"],
      env: state.env,
      isInteractiveTty: () => true,
      prompter: { confirm },
    });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(sidecarPath)).toBe(false);
    const written = JSON.parse(fs.readFileSync(authPath, "utf8")) as Record<string, unknown>;
    const profiles = written.profiles as Record<string, Record<string, unknown>>;
    expect(profiles[profileId]?.access).toBe("access-token");
    expect(profiles[profileId]?.refresh).toBe("refresh-token");
    expect(profiles[profileId]?.idToken).toBe("id-token");
    expect(profiles[profileId]?.oauthRef).toBeUndefined();
    expect(fs.existsSync(declineMarkerPath(state))).toBe(false);
  });

  it("writes a decline marker on decline and honors it on the next run", async () => {
    const { state } = await makeStateWithLegacyOauthRef("legacy-oauth-seed");
    const confirm = vi.fn(async () => false);
    await maybeAutoMigrateLegacyOAuthSidecarOnInteractiveCli({
      argv: ["node", "openclaw", "status"],
      env: state.env,
      isInteractiveTty: () => true,
      prompter: { confirm },
    });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(declineMarkerPath(state))).toBe(true);

    const confirmAgain = vi.fn(async () => true);
    await maybeAutoMigrateLegacyOAuthSidecarOnInteractiveCli({
      argv: ["node", "openclaw", "status"],
      env: state.env,
      isInteractiveTty: () => true,
      prompter: { confirm: confirmAgain },
    });
    expect(confirmAgain).not.toHaveBeenCalled();
  });
});
