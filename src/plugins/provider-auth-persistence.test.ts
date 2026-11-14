import fs from "node:fs/promises";
import path from "node:path";
import { ProviderAuthPersistenceError } from "@openclaw/normalization-core/error-coercion";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as authProfiles from "../agents/auth-profiles.js";
import {
  ensureAuthProfileStore,
  saveAuthProfileStore,
} from "../agents/auth-profiles/store-runtime.js";
import type { AuthProfileCredential, OAuthCredential } from "../agents/auth-profiles/types.js";
import * as fileLock from "../infra/file-lock.js";
import { runSecretsAudit } from "../secrets/audit.js";
import * as secretStore from "../secrets/store/secret-store.js";
import {
  listSecretStoreEntries,
  readSecretStoreValue,
  updateSecretStoreAllowedHosts,
} from "../secrets/store/secret-store.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  persistProviderAuthProfileBatch,
  persistProviderAuthProfilesAfterLogin,
  stageProviderAuthProfileBatch,
} from "./provider-auth-persistence.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(async () => {
  vi.restoreAllMocks();
  closeOpenClawAgentDatabasesForTest();
  await closeOpenClawStateDatabaseAsync();
});

describe("provider auth protected persistence", () => {
  let fixture: ReturnType<typeof persistenceFixture>;
  beforeEach(() => {
    fixture = persistenceFixture();
  });
  const protectedTokenProfile = (
    profileId: string,
    token: string,
    provider = "openai",
    namePrefix = "OPENAI_TOKEN",
  ) => ({
    profileId,
    credential: { type: "token" as const, provider, token },
    secretStorage: { kind: "store" as const, namePrefix },
  });

  function persistenceFixture() {
    const rootDir = tempDirs.make("provider-auth-");
    const stateDir = path.join(rootDir, "state");
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const args = { stateDir, agentDir, env, config: {} };
    const profileId = "openai:default";
    return {
      rootDir,
      ...args,
      args,
      stage: (token: string, protect = true) =>
        stageProviderAuthProfileBatch({
          ...args,
          profiles: [
            protect
              ? protectedTokenProfile(profileId, token)
              : { profileId, credential: { type: "token", provider: "openai", token } },
          ],
        }),
      persist: (token: string) =>
        persistProviderAuthProfileBatch({
          ...args,
          profiles: [protectedTokenProfile(profileId, token)],
        }),
    };
  }

  const readSecret = (name: string, env: NodeJS.ProcessEnv) =>
    readSecretStoreValue({ scope: { kind: "team" }, name, database: { env } });
  const listSecrets = (env: NodeJS.ProcessEnv) =>
    listSecretStoreEntries({ scope: { kind: "team" }, database: { env } });
  async function expectSecret(name: string, env: NodeJS.ProcessEnv, value: string) {
    expect(await readSecret(name, env)).toEqual({ ok: true, value });
  }
  const readStore = (agentDir: string) =>
    ensureAuthProfileStore(agentDir, { readOnly: true, syncExternalCli: false });
  const expectedProtectedProfile = (provider: string, prefix: string) => ({
    type: "token",
    provider,
    tokenRef: {
      source: "store",
      provider: "default",
      id: expect.stringMatching(new RegExp(`^${prefix}_[A-F0-9]{24}$`)),
    },
  });

  async function changePolicy(
    credential: AuthProfileCredential | undefined,
    env: NodeJS.ProcessEnv,
  ) {
    assert(credential?.type === "token" && credential.tokenRef, "Expected protected tokenRef");
    await updateSecretStoreAllowedHosts({
      scope: { kind: "team" },
      name: credential.tokenRef.id,
      allowedHosts: ["api.example.test"],
      updatedBy: "cli",
      database: { env },
    });
    return credential.tokenRef.id;
  }

  async function rejection(promise: Promise<unknown>): Promise<unknown> {
    try {
      await promise;
    } catch (error) {
      return error;
    }
    throw new Error("Expected rejection");
  }

  function expectPersistenceFailure(
    failure: unknown,
    persistenceError: unknown,
    cleanupErrors: unknown[],
  ) {
    assert(failure instanceof ProviderAuthPersistenceError);
    const cleanupError: unknown = failure.errors[1];
    assert(cleanupError instanceof AggregateError);
    expect(failure.errors).toEqual([persistenceError, cleanupError]);
    expect(failure.persistenceError).toBe(persistenceError);
    expect(failure.cleanupError).toBe(cleanupError);
    expect(failure.cause).toBe(cleanupError);
    expect(cleanupError.errors).toEqual(cleanupErrors);
  }

  async function resolvePersistedToken(params: {
    agentDir: string;
    env: NodeJS.ProcessEnv;
    profileId: string;
  }) {
    const profile = readStore(params.agentDir).profiles[params.profileId];
    assert(profile?.type === "token" && profile.tokenRef);
    const resolved = await readSecret(profile.tokenRef.id, params.env);
    assert(resolved.ok);
    return { profile, token: resolved.value };
  }

  it.each([1, 2])("rejects revoked login authority at write boundary %s", async (revokeAt) => {
    const { stateDir, agentDir, env } = fixture;
    let writes = 0;
    const revoked = new Error("Login owner revoked");
    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      await expect(
        persistProviderAuthProfileBatch({
          profiles: [protectedTokenProfile("openai:revoked", "synthetic-revoked-token")],
          ...fixture.args,
          beforeWrite: () => {
            if (++writes === revokeAt) {
              throw revoked;
            }
          },
        }),
      ).rejects.toSatisfy(
        (error: unknown) =>
          error === revoked || (error instanceof Error && error.cause === revoked),
      );
      expect(readStore(agentDir).profiles["openai:revoked"]).toBeUndefined();
      expect(await listSecrets(env)).toEqual([]);
    });
  });

  it("stores a provider-minted token behind a resolvable ref without an audit finding", async () => {
    const { rootDir, stateDir, agentDir } = fixture;
    const configPath = path.join(rootDir, "openclaw.json");
    await fs.writeFile(configPath, "{}\n", "utf8");
    const overrides = { OPENCLAW_CONFIG_PATH: configPath, OPENCLAW_STATE_DIR: stateDir };
    const env = { ...process.env, ...overrides };

    await withEnvAsync(overrides, async () => {
      const persisted = await persistProviderAuthProfileBatch({
        profiles: [
          protectedTokenProfile(
            "github-copilot:github",
            "synthetic-device-token",
            "github-copilot",
            "GITHUB_COPILOT_TOKEN",
          ),
        ],
        ...fixture.args,
        env,
      });

      const profile = readStore(agentDir).profiles["github-copilot:github"];
      expect(profile).toEqual(persisted[0]?.credential);
      expect(profile).not.toHaveProperty("token");
      expect(profile).toMatchObject(
        expectedProtectedProfile("github-copilot", "GITHUB_COPILOT_TOKEN"),
      );
      assert(profile?.type === "token" && profile.tokenRef);
      await expectSecret(profile.tokenRef.id, env, "synthetic-device-token");

      const audit = await runSecretsAudit({ env });
      expect(
        audit.findings.some(
          (finding) =>
            finding.code === "PLAINTEXT_FOUND" &&
            finding.jsonPath === "profiles.github-copilot:github.token",
        ),
      ).toBe(false);
    });
  });

  it("retains protected material when rollback cannot restore a consumed OAuth generation", async () => {
    const { agentDir } = fixture;
    const profileId = "openai:default";
    const previous = {
      type: "oauth",
      provider: "openai",
      access: "previous-access",
      refresh: "single-use-refresh",
      expires: Date.now() + 60_000,
    } satisfies OAuthCredential;
    saveAuthProfileStore({ version: 1, profiles: { [profileId]: previous } }, agentDir);

    const persisted = await fixture.stage("replacement-token");
    await persisted.rollback();

    const { profile, token } = await resolvePersistedToken({ ...fixture.args, profileId });
    expect(profile).toMatchObject(expectedProtectedProfile("openai", "OPENAI_TOKEN"));
    expect(token).toBe("replacement-token");
  });

  it.each(["rollback", "commit"] as const)(
    "serializes stages after %s and retains the settled baseline",
    async (settlement) => {
      const { stateDir, agentDir, env, stage, persist } = fixture;
      await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        await persist("baseline-c");
        const a = await stage("candidate-a");
        let b: Awaited<ReturnType<typeof stage>>;
        if (settlement === "rollback") {
          const pending = stage("candidate-b", false);
          const settled = await Promise.race([
            pending.then(() => true),
            new Promise<false>((resolve) => {
              setTimeout(() => resolve(false), 25);
            }),
          ]);
          expect(settled).toBe(false);
          await a.rollback();
          b = await pending;
        } else {
          await a.commit();
          b = await stage("candidate-b");
        }
        await b.rollback();
        expect(
          await resolvePersistedToken({ agentDir, env, profileId: "openai:default" }),
        ).toMatchObject({
          profile: { provider: "openai", type: "token" },
          token: settlement === "rollback" ? "baseline-c" : "candidate-a",
        });
      });
    },
  );
  it("reports unconfirmed protected rollback after a policy-only owner change", async () => {
    const { stateDir, env } = fixture;
    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      await fixture.persist("baseline-c");
      const staged = await fixture.stage("candidate-a");
      const name = await changePolicy(staged.profiles[0]?.credential, env);

      const rollbackError = await rejection(staged.rollback());
      expect(rollbackError).toBeInstanceOf(AggregateError);
      await expect(staged.rollback()).rejects.toBe(rollbackError);
      await expect(staged.commit()).rejects.toBe(rollbackError);
      await expectSecret(name, env, "candidate-a");
      expect((await listSecrets(env))[0]).toMatchObject({ allowedHosts: ["api.example.test"] });

      const successor = await fixture.stage("candidate-b");
      await successor.commit();
      await expectSecret(name, env, "candidate-b");
    });
  });

  it.each(["profile", "materialization", "lock-release"] as const)(
    "preserves the original and cleanup failures at %s",
    async (stage) => {
      const persistenceError = new Error("persistence failed");
      let cleanupError = new Error("cleanup failed");
      const profiles = [protectedTokenProfile("openai:default", "candidate-a")];
      const beforeWrite =
        stage === "lock-release"
          ? () => {
              throw persistenceError;
            }
          : undefined;
      if (stage === "profile") {
        cleanupError = new Error(
          'Protected credential rollback lost ownership for profile "openai:default".',
        );
        vi.spyOn(authProfiles, "persistAuthProfileBatch").mockImplementation(async (params) => {
          await changePolicy(params.profiles[0]?.credential, fixture.env);
          throw persistenceError;
        });
      } else if (stage === "materialization") {
        profiles.push(protectedTokenProfile("openai:second", "candidate-b"));
        vi.spyOn(secretStore, "writeSecretStoreEntryWithRollback")
          .mockResolvedValueOnce({
            rollback: async () => {
              throw cleanupError;
            },
          })
          .mockRejectedValueOnce(persistenceError);
      } else {
        const acquire = fileLock.acquireFileLock;
        vi.spyOn(fileLock, "acquireFileLock").mockImplementationOnce(async (...args) => {
          const lock = await acquire(...args);
          return {
            ...lock,
            release: async () => {
              await lock.release();
              throw cleanupError;
            },
          };
        });
      }
      const failure = await rejection(
        stageProviderAuthProfileBatch({ ...fixture.args, profiles, beforeWrite }),
      );
      assert(failure instanceof ProviderAuthPersistenceError);
      if (stage === "materialization") {
        const wrapped: unknown = failure.errors[0];
        assert(wrapped instanceof Error);
        expect(wrapped.cause).toBe(persistenceError);
        expectPersistenceFailure(failure, wrapped, [cleanupError]);
      } else {
        expectPersistenceFailure(failure, persistenceError, [cleanupError]);
      }
    },
  );

  it("clears completed-login failure state in the immediate-commit path", async () => {
    const { agentDir } = fixture;
    const profileId = "openai:default";
    const lastUsed = Date.now() - 10_000;
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          [profileId]: { type: "token", provider: "openai", token: "stale-token" },
        },
        usageStats: {
          [profileId]: {
            errorCount: 3,
            cooldownUntil: Date.now() + 60_000,
            cooldownReason: "auth_permanent",
            lastUsed,
          },
        },
      },
      agentDir,
    );

    await persistProviderAuthProfilesAfterLogin({
      profiles: [
        {
          profileId,
          credential: { type: "token", provider: "openai", token: "fresh-token" },
        },
      ],
      ...fixture.args,
    });

    expect(readStore(agentDir)).toMatchObject({
      profiles: {
        [profileId]: { type: "token", provider: "openai", token: "fresh-token" },
      },
      usageStats: {
        [profileId]: { errorCount: 0, lastUsed },
      },
    });
  });
});
