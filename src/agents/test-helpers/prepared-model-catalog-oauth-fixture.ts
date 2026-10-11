import { once } from "node:events";
import fs from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import path from "node:path";
import { captureClawInstallSchemaVersionFacts } from "../../claws/provenance-runtime-read.js";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import { WorkerTaskPool } from "../../infra/worker-task-pool.js";
import { loadPluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { writeConfigMachineState } from "../../state/config-machine-state-write.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { acquireTestPortBlock } from "../../test-utils/port-claims.js";
import { createOAuthRefreshFence } from "../auth-profiles/oauth-refresh-marker.js";
import { noteCommittedSharedAuthStoreOwnership } from "../auth-profiles/path-resolve.js";
import {
  loadPersistedAuthProfileStore,
  loadPersistedSharedAuthProfileStore,
} from "../auth-profiles/persisted.js";
import {
  deletePersistedAuthProfileStoreRaw,
  writePersistedAuthProfileStoreRaw,
} from "../auth-profiles/sqlite.js";
import { saveAuthProfileStore } from "../auth-profiles/store-runtime.js";
import type {
  AuthProfileCredential,
  AuthProfileStore,
  OAuthCredential,
} from "../auth-profiles/types.js";
import { createPreparedModelCatalogWorkerInput } from "../prepared-model-catalog-worker.js";
import {
  createCatalogFixture,
  PROVIDER_ID,
} from "../prepared-model-catalog-worker.test-support.js";
import type {
  PreparedModelCatalogWorkerTask,
  PreparedModelWorkerResult,
} from "../prepared-model-catalog-worker.types.js";
import { AuthStorage } from "../sessions/auth-storage.js";

type HeldCatalogOAuthRefresh = {
  pending: Promise<PreparedModelWorkerResult>;
  waitForRefresh: () => Promise<void>;
  retire: (reason: Error) => void;
  releaseResponse: () => void;
  closeWorker: () => Promise<void>;
  readCredential: () => AuthProfileCredential | undefined;
  readPeerStore: () => AuthProfileStore | null;
  readEmptyStore: () => AuthProfileStore | null;
  readConflictingCredential: () => AuthProfileCredential | undefined;
  original: OAuthCredential;
  conflictingFence?: OAuthCredential;
  rotated: OAuthCredential;
  refreshCalls: () => number;
  discoveryStarted: () => boolean;
  readRefreshFailure: () => string;
};

/** Owns a real catalog worker and a held loopback token exchange in private auth storage. */
export async function withHeldCatalogOAuthRefresh(
  params: {
    makeTempDir: (prefix: string) => string;
    signal: AbortSignal;
    sharedStatePeers?: "empty" | "matching" | "conflicting";
  },
  run: (fixture: HeldCatalogOAuthRefresh) => Promise<void>,
): Promise<void> {
  const { makeTempDir, signal } = params;
  const fixture = await createCatalogFixture(makeTempDir, 0);
  const profileId = `${PROVIDER_ID}:oauth`;
  const discoveryMarker = path.join(fixture.root, "oauth-discovery-started");
  const refreshFailure = path.join(fixture.root, "oauth-refresh-failure");
  const credential: OAuthCredential = {
    type: "oauth",
    provider: PROVIDER_ID,
    access: "original-access-not-real",
    refresh: "original-refresh-not-real",
    expires: Date.now() - 60_000,
    accountId: "fixture-account",
  };
  const rotated: OAuthCredential = {
    ...credential,
    access: "rotated-access-not-real",
    refresh: "rotated-refresh-not-real",
    expires: Date.now() + 600_000,
  };
  const peerDir = path.join(fixture.env.OPENCLAW_STATE_DIR!, "agents", "a-historical", "agent");
  const emptyDir = path.join(fixture.env.OPENCLAW_STATE_DIR!, "agents", "b-empty", "agent");
  const conflictingDir = path.join(
    fixture.env.OPENCLAW_STATE_DIR!,
    "agents",
    "z-conflicting",
    "agent",
  );
  const conflictingFence =
    params.sharedStatePeers === "conflicting"
      ? createOAuthRefreshFence({ profileId, credential })
      : undefined;
  const portClaim = await acquireTestPortBlock({ offsets: [0], signal });
  const started = createDeferredCore();
  let response: ServerResponse | undefined;
  let refreshCalls = 0;
  const server = createServer((_request, incomingResponse) => {
    refreshCalls++;
    response = incomingResponse;
    started.resolve();
  });
  const releaseResponse = () => {
    if (response && !response.writableEnded && !response.destroyed) {
      response.end(JSON.stringify(rotated));
    }
  };
  let pool: WorkerTaskPool<PreparedModelCatalogWorkerTask, PreparedModelWorkerResult> | undefined;
  try {
    server.listen(portClaim.port, "127.0.0.1");
    await once(server, "listening", { signal });
    fs.writeFileSync(
      path.join(fixture.root, "plugin", "index.cjs"),
      `module.exports = { id: ${JSON.stringify(PROVIDER_ID)}, register(api) {
api.registerProvider({
  id: ${JSON.stringify(PROVIDER_ID)}, label: "OAuth retirement fixture", auth: [],
  async refreshOAuth() {
    const response = await fetch(${JSON.stringify(`http://127.0.0.1:${portClaim.port}/refresh`)});
    return await response.json();
  },
  catalog: { order: "simple", async run(ctx) {
    require("node:fs").writeFileSync(${JSON.stringify(discoveryMarker)}, "");
    const { resolveApiKeyForProvider } = require("openclaw/plugin-sdk/provider-auth-runtime");
    let auth;
    try {
      auth = await resolveApiKeyForProvider({
      provider: ${JSON.stringify(PROVIDER_ID)}, cfg: ctx.config,
      agentDir: ctx.agentDir, workspaceDir: ctx.workspaceDir,
      profileId: ${JSON.stringify(profileId)}, lockedProfile: true
      });
    } catch (error) {
      require("node:fs").writeFileSync(${JSON.stringify(refreshFailure)}, String(error));
      throw error;
    }
    if (auth.apiKey !== ${JSON.stringify(rotated.access)}) throw new Error("Catalog did not receive the rotated OAuth credential");
    return { provider: { api: "openai-completions", baseUrl: "https://oauth.invalid/v1",
      models: [{ id: "oauth-model", name: "OAuth model" }] } };
  } }
});
} };`,
    );
    await withEnvAsync(
      {
        OPENCLAW_STATE_DIR: fixture.env.OPENCLAW_STATE_DIR,
        OPENCLAW_AGENT_DIR: fixture.agentDir,
      },
      async () => {
        const authStore = { version: 1, profiles: { [profileId]: credential } };
        if (params.sharedStatePeers) {
          writeConfigMachineState(
            "auth.sharedStore",
            { location: "state-db" },
            { env: fixture.env },
          );
          noteCommittedSharedAuthStoreOwnership({ location: "state-db" }, fixture.env);
          writePersistedAuthProfileStoreRaw(authStore);
          // Existing empty DBs and unconfigured historical peers must participate in discovery
          // without forcing a new store or preventing the shared owner from refreshing.
          writePersistedAuthProfileStoreRaw({ version: 1, profiles: {} }, fixture.agentDir);
          if (params.sharedStatePeers !== "empty") {
            writePersistedAuthProfileStoreRaw(authStore, peerDir);
          }
          writePersistedAuthProfileStoreRaw({ version: 1, profiles: {} }, emptyDir);
          deletePersistedAuthProfileStoreRaw(emptyDir);
          if (conflictingFence) {
            writePersistedAuthProfileStoreRaw(
              { version: 1, profiles: { [profileId]: conflictingFence } },
              conflictingDir,
            );
          }
        } else {
          saveAuthProfileStore(authStore, fixture.agentDir);
        }
        const metadata = loadPluginMetadataSnapshot({
          config: fixture.config,
          env: fixture.env,
          workspaceDir: fixture.workspaceDir,
        });
        const input = createPreparedModelCatalogWorkerInput({
          agentFacts: {
            input: {
              agentId: "main",
              agentDir: fixture.agentDir,
              inheritedAuthDir: fixture.agentDir,
              workspaceDir: fixture.workspaceDir,
              config: fixture.config,
              env: fixture.env,
            },
            env: fixture.env,
            authStore,
            credentials: {},
            templateAuthStorage: AuthStorage.inMemory({}),
            providerIds: [PROVIDER_ID],
            configuredModelRefs: [],
            configuredRuntimeModels: [],
            runtimeCapabilityModels: [],
            configuredGeneratedCatalogPluginIds: [],
          },
          pluginMetadataSnapshot: metadata,
        });
        pool = new WorkerTaskPool({
          workerUrl: resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.preparedModelCatalog),
          maxWorkers: 1,
          idleTimeoutMs: 0,
          restartOnError: false,
          workerOptions: {
            resourceLimits: { maxOldGenerationSizeMb: 512 },
            workerData: {
              kind: "gateway",
              sourceCaptureDirectory: makeTempDir("openclaw-catalog-oauth-captures-"),
            },
            env: fixture.env,
          },
        });
        const controller = new AbortController();
        const pending = pool.run(
          {
            value: input,
            request: {
              kind: "catalog",
              syntheticAuth: [],
              clawInstallSchemaVersions: captureClawInstallSchemaVersionFacts({
                env: fixture.env,
              }),
            },
          },
          { signal: controller.signal, timeoutMs: 30_000 },
        );
        const outcome = Promise.allSettled([pending]);
        try {
          await run({
            pending,
            waitForRefresh: async () => {
              await Promise.race([
                started.promise,
                pending.then((result) => {
                  throw new Error(
                    `catalog completed without refreshing OAuth: ${JSON.stringify(result)}`,
                  );
                }),
              ]);
            },
            retire: (reason) => controller.abort(reason),
            releaseResponse,
            closeWorker: () => pool!.close(),
            readCredential: () =>
              (params.sharedStatePeers
                ? loadPersistedSharedAuthProfileStore(fixture.env)
                : loadPersistedAuthProfileStore(fixture.agentDir)
              )?.profiles[profileId],
            readPeerStore: () => loadPersistedAuthProfileStore(peerDir),
            readEmptyStore: () => loadPersistedAuthProfileStore(emptyDir),
            readConflictingCredential: () =>
              loadPersistedAuthProfileStore(conflictingDir)?.profiles[profileId],
            original: credential,
            conflictingFence,
            rotated,
            refreshCalls: () => refreshCalls,
            discoveryStarted: () => fs.existsSync(discoveryMarker),
            readRefreshFailure: () => fs.readFileSync(refreshFailure, "utf8"),
          });
        } finally {
          releaseResponse();
          controller.abort(new Error("OAuth catalog fixture closed"));
          try {
            await pool.close();
          } finally {
            await outcome;
          }
        }
      },
    );
  } finally {
    releaseResponse();
    try {
      await pool?.close();
    } finally {
      try {
        server.closeAllConnections();
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
        });
      } finally {
        await portClaim.release();
      }
    }
  }
}
