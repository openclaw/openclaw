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
import type { OAuthCredential } from "../agents/auth-profiles/types.js";
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
  const protectedTokenProfile = (profileId: string, token: string) => ({
    profileId,
    credential: { type: "token" as const, provider: "openai", token },
    secretStorage: { kind: "store" as const, namePrefix: "OPENAI_TOKEN" },
  });

  async function resolvePersistedToken(params: {
    agentDir: string;
    env: NodeJS.ProcessEnv;
    profileId: string;
  }) {
    const profile = ensureAuthProfileStore(params.agentDir, {
      readOnly: true,
      syncExternalCli: false,
    }).profiles[params.profileId];
    if (!profile || profile.type !== "token" || !profile.tokenRef) {
      throw new Error("Expected persisted protected token profile");
    }
    const resolved = await readSecretStoreValue({
      scope: { kind: "team" },
      name: profile.tokenRef.id,
      database: { env: params.env },
    });
    if (!resolved.ok) {
      throw new Error(`Expected resolved protected token: ${resolved.error.message}`);
    }
    return { profile, token: resolved.value };
  }

  it.each([1, 2])("rejects revoked login authority at write boundary %s", async (revokeAt) => {
    const rootDir = tempDirs.make("openclaw-login-revocation-");
    const stateDir = path.join(rootDir, "state");
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    let writes = 0;
    const revoked = new Error("Login owner revoked");
    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      await expect(
        persistProviderAuthProfileBatch({
          profiles: [protectedTokenProfile("openai:revoked", "synthetic-revoked-token")],
          config: {},
          env,
          stateDir,
          agentDir,
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
      expect(
        ensureAuthProfileStore(agentDir, { readOnly: true, syncExternalCli: false }).profiles[
          "openai:revoked"
        ],
      ).toBeUndefined();
      expect(await listSecretStoreEntries({ scope: { kind: "team" }, database: { env } })).toEqual(
        [],
      );
    });
  });

  it("stores a provider-minted token behind a resolvable ref without an audit finding", async () => {
    const rootDir = tempDirs.make("openclaw-provider-auth-store-");
    const stateDir = path.join(rootDir, "state");
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    const configPath = path.join(rootDir, "openclaw.json");
    await fs.writeFile(configPath, "{}\n", "utf8");
    const env = {
      ...process.env,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_STATE_DIR: stateDir,
    };

    await withEnvAsync(
      { OPENCLAW_CONFIG_PATH: configPath, OPENCLAW_STATE_DIR: stateDir },
      async () => {
        const persisted = await persistProviderAuthProfileBatch({
          profiles: [
            {
              profileId: "github-copilot:github",
              credential: {
                type: "token",
                provider: "github-copilot",
                token: "synthetic-device-token",
              },
              secretStorage: {
                kind: "store",
                namePrefix: "GITHUB_COPILOT_TOKEN",
              },
            },
          ],
          config: {},
          env,
          stateDir,
          agentDir,
        });

        const profile = ensureAuthProfileStore(agentDir, {
          readOnly: true,
          syncExternalCli: false,
        }).profiles["github-copilot:github"];
        expect(profile).toEqual(persisted[0]?.credential);
        expect(profile).not.toHaveProperty("token");
        expect(profile).toMatchObject({
          type: "token",
          provider: "github-copilot",
          tokenRef: {
            source: "store",
            provider: "default",
            id: expect.stringMatching(/^GITHUB_COPILOT_TOKEN_[A-F0-9]{24}$/),
          },
        });
        if (!profile || profile.type !== "token" || !profile.tokenRef) {
          throw new Error("Expected persisted Copilot tokenRef");
        }
        expect(
          await readSecretStoreValue({
            scope: { kind: "team" },
            name: profile.tokenRef.id,
            database: { env },
          }),
        ).toEqual({ ok: true, value: "synthetic-device-token" });

        const audit = await runSecretsAudit({ env });
        expect(
          audit.findings.some(
            (finding) =>
              finding.code === "PLAINTEXT_FOUND" &&
              finding.jsonPath === "profiles.github-copilot:github.token",
          ),
        ).toBe(false);
      },
    );
  });

  it("retains protected material when rollback cannot restore a consumed OAuth generation", async () => {
    const rootDir = tempDirs.make("openclaw-provider-auth-rollback-");
    const stateDir = path.join(rootDir, "state");
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const profileId = "openai:default";
    const previous = {
      type: "oauth",
      provider: "openai",
      access: "previous-access",
      refresh: "single-use-refresh",
      expires: Date.now() + 60_000,
    } satisfies OAuthCredential;
    saveAuthProfileStore({ version: 1, profiles: { [profileId]: previous } }, agentDir);

    const persisted = await stageProviderAuthProfileBatch({
      profiles: [
        {
          profileId,
          credential: {
            type: "token",
            provider: "openai",
            token: "replacement-token",
          },
          secretStorage: {
            kind: "store",
            namePrefix: "OPENAI_TOKEN",
          },
        },
      ],
      config: {},
      env,
      stateDir,
      agentDir,
    });
    await persisted.rollback();

    const profile = ensureAuthProfileStore(agentDir, {
      readOnly: true,
      syncExternalCli: false,
    }).profiles[profileId];
    expect(profile).toMatchObject({
      type: "token",
      provider: "openai",
      tokenRef: {
        source: "store",
        provider: "default",
        id: expect.stringMatching(/^OPENAI_TOKEN_[A-F0-9]{24}$/),
      },
    });
    if (!profile || profile.type !== "token" || !profile.tokenRef) {
      throw new Error("Expected retained tokenRef");
    }
    expect(
      await readSecretStoreValue({
        scope: { kind: "team" },
        name: profile.tokenRef.id,
        database: { env },
      }),
    ).toEqual({ ok: true, value: "replacement-token" });
  });

  it("serializes protected and inline same-profile stages before restoring baseline C", async () => {
    const rootDir = tempDirs.make("openclaw-provider-auth-serialized-rollback-");
    const stateDir = path.join(rootDir, "state");
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const profileId = "openai:default";
    const persist = (token: string) =>
      persistProviderAuthProfileBatch({
        profiles: [protectedTokenProfile(profileId, token)],
        config: {},
        env,
        stateDir,
        agentDir,
      });
    const stage = (token: string, protect = true) =>
      stageProviderAuthProfileBatch({
        profiles: [
          protect
            ? protectedTokenProfile(profileId, token)
            : {
                profileId,
                credential: { type: "token", provider: "openai", token },
              },
        ],
        config: {},
        env,
        stateDir,
        agentDir,
      });

    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      await persist("baseline-c");
      const a = await stage("candidate-a");
      const bPending = stage("candidate-b", false);
      const bSettledBeforeA = await Promise.race([
        bPending.then(() => true),
        new Promise<false>((resolve) => {
          setTimeout(() => resolve(false), 25);
        }),
      ]);
      expect(bSettledBeforeA).toBe(false);

      await a.rollback();
      const b = await bPending;
      await b.rollback();

      expect(await resolvePersistedToken({ agentDir, env, profileId })).toMatchObject({
        profile: { provider: "openai", type: "token" },
        token: "baseline-c",
      });
    });
  });

  it("keeps committed A after a later B stage rolls back", async () => {
    const rootDir = tempDirs.make("openclaw-provider-auth-serialized-commit-");
    const stateDir = path.join(rootDir, "state");
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const profileId = "openai:default";
    const stage = (token: string) =>
      stageProviderAuthProfileBatch({
        profiles: [protectedTokenProfile(profileId, token)],
        config: {},
        env,
        stateDir,
        agentDir,
      });

    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      await persistProviderAuthProfileBatch({
        profiles: [protectedTokenProfile(profileId, "baseline-c")],
        config: {},
        env,
        stateDir,
        agentDir,
      });
      const a = await stage("candidate-a");
      await a.commit();
      const b = await stage("candidate-b");
      await b.rollback();

      expect(await resolvePersistedToken({ agentDir, env, profileId })).toMatchObject({
        profile: { provider: "openai", type: "token" },
        token: "candidate-a",
      });
    });
  });

  it("reports unconfirmed protected rollback after a policy-only owner change", async () => {
    const rootDir = tempDirs.make("openclaw-provider-auth-policy-rollback-");
    const stateDir = path.join(rootDir, "state");
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const profileId = "openai:default";
    const database = { env };

    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      await persistProviderAuthProfileBatch({
        profiles: [protectedTokenProfile(profileId, "baseline-c")],
        config: {},
        env,
        stateDir,
        agentDir,
      });
      const staged = await stageProviderAuthProfileBatch({
        profiles: [protectedTokenProfile(profileId, "candidate-a")],
        config: {},
        env,
        stateDir,
        agentDir,
      });
      const credential = staged.profiles[0]?.credential;
      if (credential?.type !== "token" || !credential.tokenRef) {
        throw new Error("Expected staged protected tokenRef");
      }
      await updateSecretStoreAllowedHosts({
        scope: { kind: "team" },
        name: credential.tokenRef.id,
        allowedHosts: ["api.example.test"],
        updatedBy: "cli",
        database,
      });

      let rollbackError: unknown;
      try {
        await staged.rollback();
      } catch (error) {
        rollbackError = error;
      }
      expect(rollbackError).toBeInstanceOf(AggregateError);
      await expect(staged.rollback()).rejects.toBe(rollbackError);
      await expect(staged.commit()).rejects.toThrow(
        "Cannot commit provider auth persistence after rollback failed",
      );
      expect(
        await readSecretStoreValue({
          scope: { kind: "team" },
          name: credential.tokenRef.id,
          database,
        }),
      ).toEqual({ ok: true, value: "candidate-a" });
      expect(
        (await listSecretStoreEntries({ scope: { kind: "team" }, database }))[0],
      ).toMatchObject({
        allowedHosts: ["api.example.test"],
      });

      const successor = await stageProviderAuthProfileBatch({
        profiles: [protectedTokenProfile(profileId, "candidate-b")],
        config: {},
        env,
        stateDir,
        agentDir,
      });
      await successor.commit();
      expect(
        await readSecretStoreValue({
          scope: { kind: "team" },
          name: credential.tokenRef.id,
          database,
        }),
      ).toEqual({ ok: true, value: "candidate-b" });
    });
  });

  it("preserves the persistence failure and protected rollback diagnostics", async () => {
    const rootDir = tempDirs.make("openclaw-provider-auth-dual-failure-");
    const stateDir = path.join(rootDir, "state");
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const database = { env };
    const persistenceError = new Error("profile persistence failed");

    vi.spyOn(authProfiles, "persistAuthProfileBatch").mockImplementation(async (params) => {
      const credential = params.profiles[0]?.credential;
      if (credential?.type !== "token" || !credential.tokenRef) {
        throw new Error("Expected staged protected tokenRef");
      }
      await updateSecretStoreAllowedHosts({
        scope: { kind: "team" },
        name: credential.tokenRef.id,
        allowedHosts: ["api.example.test"],
        updatedBy: "cli",
        database,
      });
      throw persistenceError;
    });

    let failure: unknown;
    try {
      await stageProviderAuthProfileBatch({
        profiles: [protectedTokenProfile("openai:default", "candidate-a")],
        config: {},
        env,
        stateDir,
        agentDir,
      });
    } catch (error) {
      failure = error;
    }

    assert(failure instanceof ProviderAuthPersistenceError);
    const cleanupError: unknown = failure.errors[1];
    assert(cleanupError instanceof AggregateError);
    expect(failure.errors).toEqual([persistenceError, cleanupError]);
    expect(failure.persistenceError).toBe(persistenceError);
    expect(failure.cleanupError).toBe(cleanupError);
    expect(failure.message).toBe(
      "Provider auth persistence failed and staged state could not be fully released.",
    );
    expect(failure.cause).toBe(cleanupError);
    expect(cleanupError.errors).toEqual([
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

    let failure: unknown;
    try {
      await stageProviderAuthProfileBatch({
        profiles: [
          protectedTokenProfile("openai:first", "candidate-a"),
          protectedTokenProfile("openai:second", "candidate-b"),
        ],
        config: {},
        stateDir,
      });
    } catch (error) {
      failure = error;
    }
    write.mockRestore();

    assert(failure instanceof ProviderAuthPersistenceError);
    const materializationError: unknown = failure.errors[0];
    assert(materializationError instanceof Error);
    expect(materializationError.cause).toBe(persistenceError);
    const cleanupError: unknown = failure.errors[1];
    assert(cleanupError instanceof AggregateError);
    expect(failure.errors).toEqual([materializationError, cleanupError]);
    expect(failure.persistenceError).toBe(materializationError);
    expect(failure.cleanupError).toBe(cleanupError);
    expect(failure.message).toBe(
      "Provider credential persistence failed and protected-store rollback could not be confirmed.",
    );
    expect(cleanupError.errors).toEqual([rollbackError]);
    expect(failure.cause).toBe(cleanupError);
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

    let failure: unknown;
    try {
      await stageProviderAuthProfileBatch({
        profiles: [protectedTokenProfile("openai:default", "candidate-a")],
        config: {},
        stateDir,
        beforeWrite: () => {
          throw persistenceError;
        },
      });
    } catch (error) {
      failure = error;
    }

    assert(failure instanceof ProviderAuthPersistenceError);
    const cleanupError: unknown = failure.errors[1];
    assert(cleanupError instanceof AggregateError);
    expect(failure.errors).toEqual([persistenceError, cleanupError]);
    expect(failure.persistenceError).toBe(persistenceError);
    expect(failure.cleanupError).toBe(cleanupError);
    expect(failure.message).toBe(
      "Provider auth persistence failed and staged state could not be fully released.",
    );
    expect(cleanupError.errors).toEqual([releaseError]);
    expect(failure.cause).toBe(cleanupError);
  });

  it("clears completed-login failure state in the immediate-commit path", async () => {
    const rootDir = tempDirs.make("openclaw-provider-auth-login-reset-");
    const stateDir = path.join(rootDir, "state");
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
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
      config: {},
      env,
      stateDir,
      agentDir,
    });

    expect(
      ensureAuthProfileStore(agentDir, { readOnly: true, syncExternalCli: false }),
    ).toMatchObject({
      profiles: {
        [profileId]: { type: "token", provider: "openai", token: "fresh-token" },
      },
      usageStats: {
        [profileId]: { errorCount: 0, lastUsed },
      },
    });
  });
});
