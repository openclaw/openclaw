import fs from "node:fs/promises";
import path from "node:path";
import { ProviderAuthPersistenceError } from "@openclaw/normalization-core/error-coercion";
import { afterEach, assert, describe, expect, it, vi } from "vitest";
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

  function persistenceFixture(label: string) {
    const rootDir = tempDirs.make(label);
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
    message = "Provider auth persistence failed and staged state could not be fully released.",
  ) {
    assert(failure instanceof ProviderAuthPersistenceError);
    const cleanupError: unknown = failure.errors[1];
    assert(cleanupError instanceof AggregateError);
    expect(failure.errors).toEqual([persistenceError, cleanupError]);
    expect(failure.persistenceError).toBe(persistenceError);
    expect(failure.cleanupError).toBe(cleanupError);
    expect(failure.message).toBe(message);
    expect(failure.cause).toBe(cleanupError);
    expect(cleanupError.errors).toEqual(cleanupErrors);
  }

  async function resolvePersistedToken(params: {
    agentDir: string;
    env: NodeJS.ProcessEnv;
    profileId: string;
  }) {
    const profile = readStore(params.agentDir).profiles[params.profileId];
    if (!profile || profile.type !== "token" || !profile.tokenRef) {
      throw new Error("Expected persisted protected token profile");
    }
    const resolved = await readSecret(profile.tokenRef.id, params.env);
    if (!resolved.ok) {
      throw new Error(`Expected resolved protected token: ${resolved.error.message}`);
    }
    return { profile, token: resolved.value };
  }

  it.each([1, 2])("rejects revoked login authority at write boundary %s", async (revokeAt) => {
    const fixture = persistenceFixture("openclaw-login-revocation-");
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
    const fixture = persistenceFixture("openclaw-provider-auth-store-");
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
      if (!profile || profile.type !== "token" || !profile.tokenRef) {
        throw new Error("Expected persisted Copilot tokenRef");
      }
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
    const fixture = persistenceFixture("openclaw-provider-auth-rollback-");
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
      const fixture = persistenceFixture("openclaw-provider-auth-serialized-");
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
    const fixture = persistenceFixture("openclaw-provider-auth-policy-rollback-");
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

  it("preserves the persistence failure and protected rollback diagnostics", async () => {
    const fixture = persistenceFixture("openclaw-provider-auth-dual-failure-");
    const { env } = fixture;
    const persistenceError = new Error("profile persistence failed");

    vi.spyOn(authProfiles, "persistAuthProfileBatch").mockImplementation(async (params) => {
      await changePolicy(params.profiles[0]?.credential, env);
      throw persistenceError;
    });

    const failure = await rejection(
      stageProviderAuthProfileBatch({
        profiles: [protectedTokenProfile("openai:default", "candidate-a")],
        ...fixture.args,
      }),
    );

    expectPersistenceFailure(failure, persistenceError, [
      new Error('Protected credential rollback lost ownership for profile "openai:default".'),
    ]);
  });

  it("keeps the materialization failure first when protected rollback also fails", async () => {
    const rootDir = tempDirs.make("openclaw-provider-auth-materialization-failure-");
    const stateDir = path.join(rootDir, "state");
    const persistenceError = new Error("synthetic protected write failure");
    const rollbackError = new Error("synthetic protected rollback failure");
    const rollback = vi.fn(async () => {
      throw rollbackError;
    });
    const write = vi
      .spyOn(secretStore, "writeSecretStoreEntryWithRollback")
      .mockResolvedValueOnce({ rollback })
      .mockImplementationOnce(async () => {
        throw persistenceError;
      });

    const failure = await rejection(
      stageProviderAuthProfileBatch({
        profiles: [
          protectedTokenProfile("openai:first", "candidate-a"),
          protectedTokenProfile("openai:second", "candidate-b"),
        ],
        config: {},
        stateDir,
      }),
    );
    write.mockRestore();

    assert(failure instanceof ProviderAuthPersistenceError);
    const materializationError: unknown = failure.errors[0];
    assert(materializationError instanceof Error);
    expect(materializationError.cause).toBe(persistenceError);
    expectPersistenceFailure(
      failure,
      materializationError,
      [rollbackError],
      "Provider credential persistence failed and protected-store rollback could not be confirmed.",
    );
    expect(rollback).toHaveBeenCalledOnce();
  });

  it("preserves the staging failure and lock release diagnostics", async () => {
    const stateDir = tempDirs.make("openclaw-provider-auth-release-failure-");
    const persistenceError = new Error("synthetic staging failure");
    const releaseError = new Error("synthetic lock release failure");
    const acquireFileLock = fileLock.acquireFileLock;
    vi.spyOn(fileLock, "acquireFileLock").mockImplementationOnce(async (...args) => {
      const lock = await acquireFileLock(...args);
      return {
        ...lock,
        release: async () => {
          await lock.release();
          throw releaseError;
        },
      };
    });

    const failure = await rejection(
      stageProviderAuthProfileBatch({
        profiles: [protectedTokenProfile("openai:default", "candidate-a")],
        config: {},
        stateDir,
        beforeWrite: () => {
          throw persistenceError;
        },
      }),
    );

    expectPersistenceFailure(failure, persistenceError, [releaseError]);
  });

  it("clears completed-login failure state in the immediate-commit path", async () => {
    const fixture = persistenceFixture("openclaw-provider-auth-login-reset-");
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
