import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { expectDefined } from "@openclaw/normalization-core";
import { readDatabasePathIdentitySync } from "../../infra/sqlite-worker-identity.js";
import { prepareAgentDatabaseDeletionSnapshotRead } from "../../state/agent-deletion-journal.read.js";
import { readOpenClawAgentDatabaseRegistryToken } from "../../state/openclaw-agent-db.js";
import { cloneEnvWithPlatformSemantics } from "../config-env-vars.js";
import { resolveStateDir } from "../state-dir.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import {
  mergeCombinedSessionStore,
  prepareCombinedSessionStore,
  type GatewayCombinedSessionStore,
  type GatewaySessionStoreOptions,
} from "./combined-store-gateway.js";
import { storeTargetKey } from "./combined-store-paths.js";
import type { SessionEntrySummary } from "./session-accessor.types.js";
import { captureSessionActorStorageOwner } from "./session-actor-storage-binding.js";
import {
  assertSessionStoreReadCandidate,
  captureSessionStoreCandidateIdentities,
  isSessionStoreReadCandidateCurrent,
} from "./session-store-read-candidates.js";
import { prepareSessionStoreTargetInventory } from "./session-store-target-inventory.js";
import { withSessionHistoryWorkerReadCandidates } from "./session-transcript-worker-resources.js";
import { withSessionHistoryWorkerDatabases } from "./session-transcript-worker-runtime.js";
import { listConfiguredSessionStoreAgentIds } from "./targets.js";

export async function loadCombinedSessionStoreForGatewayCoreAsync(
  cfg: OpenClawConfig,
  opts: Omit<GatewaySessionStoreOptions, "loadEntries" | "onStoreLoaded"> = {},
): Promise<GatewayCombinedSessionStore> {
  const ambientStateDir = resolveStateDir(process.env);
  const selected =
    opts.includeIncognito === false
      ? undefined
      : captureSessionActorStorageOwner({ env: opts.discovery?.env });
  const env = cloneEnvWithPlatformSemantics(
    opts.discovery?.env ??
      (selected
        ? { ...process.env, OPENCLAW_STATE_DIR: path.resolve(selected.path, "../../../..") }
        : process.env),
  );
  env.OPENCLAW_STATE_DIR = resolveStateDir(env);
  const options = { ...opts, ...(opts.discovery && { discovery: { ...opts.discovery, env } }) };
  const result = loadCombinedSessionStore(cfg, options, { env, ambientStateDir });
  return result.then((value) => {
    if (resolveStateDir(process.env) !== ambientStateDir) {
      throw new Error("Session stores changed while preparing the listing. Retry the request.");
    }
    return value;
  });
}

/** Descriptive listings retain federation policy while durable rows are read by its worker. */
async function loadCombinedSessionStore(
  cfg: OpenClawConfig,
  options: Omit<GatewaySessionStoreOptions, "loadEntries" | "onStoreLoaded">,
  captured: { env: NodeJS.ProcessEnv; ambientStateDir: string },
): Promise<GatewayCombinedSessionStore> {
  const { env, ambientStateDir } = captured;
  const read = async (
    config: OpenClawConfig,
    readOptions: typeof options,
    capturedIdentities: ReturnType<typeof captureSessionStoreCandidateIdentities>,
  ): Promise<GatewayCombinedSessionStore> => {
    const prepared = prepareCombinedSessionStore(config, readOptions);
    const identities = prepared.reads.map(
      ({ storeTarget }) =>
        capturedIdentities.get(storeTarget.storePath) ??
        readDatabasePathIdentitySync(storeTarget.storePath),
    );
    // Preparation can refresh registry discovery; retain its resulting topology generation.
    const registryToken = readOpenClawAgentDatabaseRegistryToken();
    // Windows environment proxies cannot cross the worker boundary.
    const transferEnv = { ...env, OPENCLAW_STATE_DIR: env.OPENCLAW_STATE_DIR };
    return await withSessionHistoryWorkerDatabases(
      prepared.reads.map(({ storeTarget }) => ({
        agentId: storeTarget.agentId,
        path: storeTarget.storePath,
        env,
      })),
      async (owners) => {
        const entries = new Map<string, SessionEntrySummary[]>();
        for (const [index, { storeTarget }] of prepared.reads.entries()) {
          const owner = expectDefined(owners[index], "retained session store");
          const { entries: rows } = await owner.readEntries(
            { ...storeTarget, env: transferEnv, projection: prepared.projection, clone: false },
            undefined,
            identities[index],
          );
          entries.set(storeTargetKey(storeTarget), rows);
        }
        for (const [index, owner] of owners.entries()) {
          owner.assertCurrent();
          if (
            !isDeepStrictEqual(
              readDatabasePathIdentitySync(prepared.reads[index]!.storeTarget.storePath),
              identities[index],
            )
          ) {
            throw new Error("Session listing changed its captured physical owner");
          }
        }
        if (
          resolveStateDir(process.env) !== ambientStateDir ||
          registryToken !== readOpenClawAgentDatabaseRegistryToken()
        ) {
          throw new Error("Session stores changed while preparing the listing. Retry the request.");
        }
        // Memory entries are read once, when the complete listing is assembled.
        return mergeCombinedSessionStore(config, readOptions, prepared, (target) =>
          expectDefined(entries.get(storeTargetKey(target)), "prepared session entries"),
        );
      },
    );
  };
  if (!options.discovery) {
    const inventory = prepareSessionStoreTargetInventory(
      cfg,
      listConfiguredSessionStoreAgentIds(cfg),
      env,
      "recovery",
    );
    const identities = captureSessionStoreCandidateIdentities(inventory.candidates);
    for (const candidate of inventory.candidates) {
      const identity = identities.get(candidate.physicalPath);
      if (identity && !candidate.scope) {
        identities.set(candidate.path, identity);
      }
    }
    const discovery = prepareAgentDatabaseDeletionSnapshotRead({ env }, "runtime");
    return withSessionHistoryWorkerReadCandidates(inventory.candidates, async (owner) => {
      const assertCaptured = () => {
        owner.assertCurrent();
        for (const candidate of inventory.candidates) {
          if (!isSessionStoreReadCandidateCurrent(candidate)) {
            throw new Error(
              `Session database target changed outside captured discovery custody: ${candidate.path}`,
            );
          }
          assertSessionStoreReadCandidate(candidate.path, inventory.candidates);
          const identity = identities.get(candidate.physicalPath);
          if (
            identity &&
            !isDeepStrictEqual(readDatabasePathIdentitySync(candidate.path), identity)
          ) {
            throw new Error("Session listing changed its captured physical owner");
          }
        }
      };
      const result = await discovery.withCurrentSnapshot((snapshot) => {
        assertCaptured();
        return read(inventory.config, { ...options, discovery: { env, snapshot } }, identities);
      });
      assertCaptured();
      return result;
    });
  }

  return read(cfg, options, new Map());
}
