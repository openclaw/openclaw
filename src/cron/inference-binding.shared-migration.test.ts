import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { runNodeScript } from "../../test/helpers/run-node-script.js";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createOAuthManager } from "../agents/auth-profiles/oauth-manager.js";
import { mockOAuthProviderOperations } from "../agents/auth-profiles/oauth-native-provider.test-support.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "../agents/auth-profiles/runtime-snapshots.js";
import {
  closeAuthProfileReadPool,
  readPersistedAuthProfileStoreRaw,
  writePersistedAuthProfileStoreRaw,
} from "../agents/auth-profiles/sqlite.js";
import { loadAuthProfileStoreWithoutExternalProfilesAsync } from "../agents/auth-profiles/store-runtime.js";
import type { OAuthCredential } from "../agents/auth-profiles/types.js";
import { mcpImportRuntimeEntrypoints } from "../agents/mcp-import-runtime.test-support.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import {
  detectSharedAuthStoreMigration,
  migrateSharedAuthStore,
} from "../infra/state-migrations.shared-auth-store.js";
import { persistProviderAuthProfileBatch } from "../plugins/provider-auth-persistence.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db.js";
import * as stateDb from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { makeCronJob } from "./delivery.test-helpers.js";
import type { CronInferenceBinding } from "./inference-binding.js";
import {
  acquireCronInferenceAuthorization,
  captureCronInferenceBinding,
} from "./inference-binding.runtime.js";
import { loadCronJobsStore, saveCronJobsStore } from "./store.js";
import type { CronStoredJob } from "./types.js";

const dirs = createTempDirTracker();
const oauthId = "openai:subscription";
const apiId = "openai:platform";
const credential: OAuthCredential = {
  type: "oauth",
  provider: "openai",
  access: "synthetic-access",
  refresh: "synthetic-refresh",
  expires: 4_102_444_800_000,
  accountId: "synthetic-account-A",
};
const apiCredential = {
  type: "api_key" as const,
  provider: "openai",
  key: "synthetic-platform-key",
};

async function closeStores() {
  clearRuntimeAuthProfileStoreSnapshots();
  closeAuthProfileReadPool();
  await closeOpenClawAgentDatabasesAsync();
  await stateDb.closeOpenClawStateDatabaseAsync();
}
afterEach(async () => {
  await closeStores();
  vi.restoreAllMocks();
  dirs.cleanup();
});
async function settled<T>(run: () => Promise<T>): Promise<T> {
  const work = new AsyncWorkScope();
  try {
    return await work.run(run);
  } finally {
    await work.drain();
  }
}
type Recorded = { agentId: string; agentDir: string; binding: CronInferenceBinding };
async function acquire(cfg: OpenClawConfig, recorded: Recorded) {
  return settled(async () => {
    const authority = await acquireCronInferenceAuthorization({ cfg, ...recorded });
    try {
      authority.assertCurrent();
      await authority.revalidate();
      return authority.authorizationId;
    } finally {
      authority.dispose();
    }
  });
}
async function fixture(
  run: (value: {
    stateDir: string;
    mainDir: string;
    cfg: OpenClawConfig;
    recorded: Recorded[];
    migrate: () => ReturnType<typeof migrateSharedAuthStore>;
  }) => Promise<void>,
  alias = false,
) {
  const realStateDir = dirs.make("cron-auth-relocation-");
  const stateDir = alias ? path.join(dirs.make("cron-auth-alias-"), "state") : realStateDir;
  if (alias) {
    fs.symlinkSync(realStateDir, stateDir, "dir");
  }
  const mainDir = path.join(stateDir, "agents/main/agent");
  const peerDir = path.join(stateDir, "agents/peer/agent");
  const cfg: OpenClawConfig = {
    agents: {
      defaults: { model: "openai/gpt-4.1" },
      entries: { main: { agentDir: mainDir }, peer: { agentDir: peerDir } },
    },
    auth: {
      profiles: {
        [oauthId]: { provider: "openai", mode: "oauth" },
        [apiId]: { provider: "openai", mode: "api_key" },
      },
    },
  };
  await withEnvAsync(
    {
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_AGENT_DIR: undefined,
      PI_CODING_AGENT_DIR: undefined,
      OPENCLAW_CONFIG_PATH: path.join(stateDir, "absent.json"),
      OPENAI_API_KEY: undefined,
    },
    async () => {
      writePersistedAuthProfileStoreRaw(
        { version: 1, profiles: { [oauthId]: credential, [apiId]: apiCredential } },
        mainDir,
      );
      const recorded: Recorded[] = [];
      for (const [agentId, agentDir, profileId] of [
        ["main", mainDir, oauthId],
        ["peer", peerDir, oauthId],
        ["main", mainDir, apiId],
      ] as const) {
        const binding = await settled(() =>
          captureCronInferenceBinding({
            cfg,
            agentId,
            model: "openai/gpt-4.1@" + profileId,
            runtimeSessionEntry: { agentRuntimeOverride: "openclaw" },
          }),
        );
        if (!binding) {
          throw new Error("Expected a stored automation account");
        }
        const entry = { agentId, agentDir, binding };
        expect(await acquire(cfg, entry)).toBe(binding.authorizationId);
        recorded.push(entry);
      }
      const storePath = path.join(stateDir, "cron/jobs.json");
      await saveCronJobsStore(storePath, {
        version: 1,
        jobs: recorded.map(({ binding, agentId }, i): CronStoredJob => ({
          ...makeCronJob({ id: "synthetic-" + i, agentId }),
          inferenceBinding: binding,
        })),
      });
      const jobs = (await loadCronJobsStore(storePath)).jobs;
      await closeStores();
      const migrate = async () => {
        await closeStores();
        const detected = await detectSharedAuthStoreMigration({
          stateDir,
          env: process.env,
          doctorOnlyStateMigrations: true,
        });
        const result = await migrateSharedAuthStore({ detected, stateDir, env: process.env });
        await closeStores();
        expect((await loadCronJobsStore(storePath)).jobs).toEqual(jobs);
        return result;
      };
      await run({ stateDir, mainDir, cfg, recorded, migrate });
      await closeStores();
    },
  );
}

it("keeps recorded main and inherited accounts through relocation and refresh, but rejects replacements", async () => {
  await fixture(async ({ stateDir, mainDir, cfg, recorded, migrate }) => {
    expect((await migrate()).warnings).toEqual([]);
    for (const entry of recorded) {
      expect(await acquire(cfg, entry)).toBe(entry.binding.authorizationId);
    }
    await closeStores();
    expect(readPersistedAuthProfileStoreRaw(mainDir)).toMatchObject({ profiles: {} });
    await closeStores();
    // Use the existing compiled import probe layout, not a second source-loader graph.
    const captureUrl = resolveRuntimeWorkerUrl(mcpImportRuntimeEntrypoints.authorization);
    for (const write of [true, false]) {
      const script = [
        `import assert from "node:assert/strict";`,
        `import { persistAuthProfileBatch } from ${JSON.stringify(new URL("./auth-profiles/upsert-with-lock.js", captureUrl).href)};`,
        `import { getPreparedSharedAuthStoreOwnership } from ${JSON.stringify(new URL("./auth-profiles/path-resolve.js", captureUrl).href)};`,
        `import { acquireCronInferenceAuthorization } from ${JSON.stringify(new URL("../cron/inference-binding.runtime.js", captureUrl).href)};`,
        `import { AsyncWorkScope } from ${JSON.stringify(new URL("../shared/async-work-scope.js", captureUrl).href)};`,
        `import { closeOpenClawAgentDatabasesAsync } from ${JSON.stringify(new URL("../state/openclaw-agent-db.js", captureUrl).href)};`,
        `import { closeOpenClawStateDatabaseAsync } from ${JSON.stringify(new URL("../state/openclaw-state-db.js", captureUrl).href)};`,
        `const work = new AsyncWorkScope();`,
        `try { await work.run(async () => {`,
        `assert.equal(getPreparedSharedAuthStoreOwnership(process.env), undefined);`,
        // API-key-only persistence enters cold bootstrap before ordinary ownership preparation.
        ...(write
          ? [
              `await persistAuthProfileBatch({ profiles: [{ profileId: "openai:unrelated", credential: { type: "api_key", provider: "openai", key: "synthetic-unrelated" } }] });`,
            ]
          : []),
        `for (const recorded of ${JSON.stringify(recorded)}) {`,
        `  const authority = await acquireCronInferenceAuthorization({ cfg: ${JSON.stringify(cfg)}, ...recorded });`,
        `  try { authority.assertCurrent(); console.log(authority.authorizationId); } finally { authority.dispose(); }`,
        `}`,
        `}); } finally { await work.drain(); await closeOpenClawAgentDatabasesAsync(); await closeOpenClawStateDatabaseAsync(); }`,
      ].join("\n");
      const result = await runNodeScript(
        (workerArgv) => [
          ...workerArgv(captureUrl).slice(0, -1),
          "--input-type=module",
          "-e",
          script,
        ],
        process.env,
        30_000,
      );
      expect(result.error, `${result.stderr}\n${result.stdout}`).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      for (const { binding } of recorded) {
        expect(result.stdout).toContain(binding.authorizationId);
      }
    }
    const refreshCredential = vi.fn(async () => ({
      ...credential,
      access: "synthetic-refreshed-access",
      refresh: "synthetic-refreshed-refresh",
    }));
    mockOAuthProviderOperations({ refreshCredential });
    const store = await loadAuthProfileStoreWithoutExternalProfilesAsync(mainDir);
    const current = store.profiles[oauthId];
    if (current?.type !== "oauth") {
      throw new Error("Missing synthetic OAuth account");
    }
    await createOAuthManager().resolveOAuthAccess({
      store,
      profileId: oauthId,
      credential: current,
      agentDir: mainDir,
      forceRefresh: true,
    });
    expect(refreshCredential).toHaveBeenCalledOnce();
    for (const entry of recorded) {
      expect(await acquire(cfg, entry)).toBe(entry.binding.authorizationId);
    }
    await closeStores();
    // A local override followed by removal must not resurrect the earlier inherited binding.
    writePersistedAuthProfileStoreRaw(
      {
        version: 1,
        profiles: {
          [oauthId]: {
            ...credential,
            accountId: "synthetic-local-B",
            refresh: "synthetic-local-refresh",
          },
        },
      },
      mainDir,
    );
    await expect(acquire(cfg, recorded[0]!)).rejects.toThrow(/signed in again or replaced/);
    await closeStores();
    writePersistedAuthProfileStoreRaw({ version: 1, profiles: {} }, mainDir);
    await expect(acquire(cfg, recorded[0]!)).rejects.toThrow(/signed in again or replaced/);
    for (const entry of recorded.slice(1)) {
      expect(await acquire(cfg, entry)).toBe(entry.binding.authorizationId);
    }
    // Explicit replacement, including identical API-key bytes, still starts a new lifetime.
    await persistProviderAuthProfileBatch({
      stateDir,
      config: cfg,
      profiles: [
        {
          profileId: oauthId,
          credential: {
            ...credential,
            accountId: "synthetic-shared-B",
            refresh: "synthetic-new-refresh",
          },
        },
        { profileId: apiId, credential: apiCredential },
      ],
    });
    for (const entry of recorded) {
      await expect(acquire(cfg, entry)).rejects.toThrow(/signed in again or replaced/);
    }
  });
});

it("resumes relocation after source cleanup without losing continuity or reconstructing missing lifetimes", async () => {
  await fixture(async ({ mainDir, cfg, recorded, migrate }) => {
    const transaction = stateDb.runOpenClawStateWriteTransaction;
    const fault = vi
      .spyOn(stateDb, "runOpenClawStateWriteTransaction")
      .mockImplementation((...args) => {
        if (args[2]?.operationLabel === "state-migration.shared-auth-finalize") {
          throw new Error("synthetic finalization interruption");
        }
        return transaction(...args);
      });
    expect((await migrate()).warnings.join(" ")).toContain("synthetic finalization interruption");
    fault.mockRestore();
    expect((await migrate()).warnings).toEqual([]);
    for (const entry of recorded) {
      expect(await acquire(cfg, entry)).toBe(entry.binding.authorizationId);
    }
    await closeStores();
    // Separate corruption control: remove only the credential-free source metadata.
    const db = new DatabaseSync(path.join(mainDir, "openclaw-agent.sqlite"));
    try {
      db.prepare("DELETE FROM auth_profile_store WHERE store_key = 'primary'").run();
    } finally {
      db.close();
    }
    await expect(acquire(cfg, recorded[0]!)).rejects.toThrow(/signed in again or replaced/);
  }, process.platform !== "win32");
});
