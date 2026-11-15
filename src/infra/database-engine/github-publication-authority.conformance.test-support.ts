import { createHash } from "node:crypto";
import { getEnvironmentData, setEnvironmentData } from "node:worker_threads";
import { Client } from "pg";
import { expect, onTestFinished } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../../test/helpers/promise.js";
import { getRuntimeConfig, setRuntimeConfigSnapshot } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.js";
import { insertRepositoryGitHubPublicationAsync } from "../../gateway/github-publication-request-async.js";
import { prepareGitHubPublicationRequesterV2 } from "../../gateway/github-publication-requester.js";
import { publishOperatorRoleConfigChange } from "../../gateway/operator-role-policy.js";
import { SESSION_READ_SCOPE, SESSION_WRITE_SCOPE } from "../../gateway/operator-scopes.js";
import { createOperatorWsClient } from "../../gateway/server/ws-connection/authenticated-request-dispatch.test-support.js";
import { prepareGatewayConnectOperatorAccess } from "../../gateway/server/ws-connection/connect-operator-access.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { ensureCanonicalUserProfileForEmail } from "../../state/user-profile-writes.js";
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import { resolveRuntimeProcessEntrypointUrl } from "../runtime-process-url.js";
import { withRuntimeWorkerGeneration } from "../runtime-worker-generation.js";
import { resolveRuntimeWorkerUrl } from "../runtime-worker-url.js";
import { storageProcessTestEntrypoints } from "../storage-process-runtime.test-support.js";
import { mixedAgentConnection } from "./mixed-agent.conformance.test-support.js";
import { getPostgresPhysicalFactsForPath } from "./physical-facts.js";

/** Only the WebSocket transport is synthetic; identity, role and session policy are production owners. */
export async function preparePublicationAuthority(
  session: { agentId: string; sessionKey: string },
  signal: AbortSignal,
) {
  const profile = await ensureCanonicalUserProfileForEmail("publication-authorized@example.test");
  const foreign = await ensureCanonicalUserProfileForEmail("publication-foreign@example.test");
  const scopes = [SESSION_READ_SCOPE, SESSION_WRITE_SCOPE];
  const config = getRuntimeConfig();
  const authorizedConfig: OpenClawConfig = {
    ...config,
    gateway: {
      ...config.gateway,
      roles: {
        default: "guest",
        definitions: {
          guest: { sessions: { others: "view" }, agents: [session.agentId], scopes },
        },
      },
    },
  };
  const contexts = new Set<object>();
  const publish = (committed: OpenClawConfig) => {
    setRuntimeConfigSnapshot(committed);
    for (const context of contexts) {
      publishOperatorRoleConfigChange(context);
    }
  };
  publish(authorizedConfig);
  let policyReads = 0;
  let hostAdmissionCheck: (() => void) | undefined;
  const capture = async (profileId: string) => {
    const client = createOperatorWsClient({ connId: profileId, scopes });
    client.authenticatedUserProfile = {
      profileId,
      displayName: null,
      avatarRevision: "fixture",
      hasAvatar: false,
      updatedAt: 1,
    };
    prepareGatewayConnectOperatorAccess(client);
    const context = {
      getRuntimeConfig,
      getCommittedRuntimeConfig: () => {
        if (hostAdmissionCheck && ++policyReads === 2) {
          const check = hostAdmissionCheck;
          hostAdmissionCheck = undefined;
          check();
        }
        return getRuntimeConfig();
      },
    };
    contexts.add(context);
    const captured = await prepareGitHubPublicationRequesterV2(
      { client, context, signal },
      session,
    );
    onTestFinished(captured.release);
    return captured.requester;
  };
  return {
    profileId: profile.id,
    capture: () => capture(profile.id),
    rejectForeign: () => expect(capture(foreign.id)).rejects.toThrow(/unavailable|authoriz/i),
    restore: () => publish(authorizedConfig),
    observeHostAdmission(check: () => void) {
      policyReads = 0;
      hostAdmissionCheck = check;
    },
    revoke: () =>
      publish({
        ...authorizedConfig,
        gateway: {
          ...authorizedConfig.gateway,
          roles: {
            default: "guest",
            definitions: { guest: { sessions: { others: "none" }, agents: [], scopes: [] } },
          },
        },
      }),
  };
}

/** Hold the real source writer lock across dispatch, then revoke the authenticated principal. */
export async function denyWhileSourceReserved(
  row: Parameters<typeof insertRepositoryGitHubPublicationAsync>[0],
  source: Parameters<typeof insertRepositoryGitHubPublicationAsync>[1],
  authority: Awaited<ReturnType<typeof preparePublicationAuthority>>,
  retry: PublicationRetryProbe,
) {
  const sourcePath = resolveOpenClawAgentSqlitePath({ agentId: row.agent_id });
  const facts = getPostgresPhysicalFactsForPath(sourcePath);
  const postgres = facts ? new Client({ connectionString: mixedAgentConnection }) : undefined;
  const sqlite = facts ? undefined : openNodeSqliteDatabase(sourcePath);
  let inserting: ReturnType<typeof insertRepositoryGitHubPublicationAsync> | undefined;
  let settled = false;
  try {
    if (postgres) {
      await postgres.connect();
      const key = createHash("sha256").update(facts!.storeId).digest().readBigInt64BE();
      await postgres.query("SELECT pg_advisory_lock($1::bigint)", [key.toString()]);
    } else {
      sqlite!.exec("BEGIN IMMEDIATE");
    }
    retry.arm();
    let hostAdmissionObserved = false;
    authority.observeHostAdmission(() => {
      hostAdmissionObserved = true;
      // Negative control: the old two-read condition precedes native acquisition.
      expect(retry.hasRetried()).toBe(false);
    });
    inserting = insertRepositoryGitHubPublicationAsync(row, source);
    void inserting.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await retry.reached(inserting);
    expect(hostAdmissionObserved).toBe(true);
    expect(retry.hasRetried()).toBe(true);
    expect(settled).toBe(false);
    // A durable profile edit shares this writer's FIFO lane. Commit a runtime policy change
    // through the production publication owner instead; it can revoke while that lane waits.
    authority.revoke();
    retry.release();
    if (postgres) {
      await postgres.query("SELECT pg_advisory_unlock_all()");
    } else {
      sqlite!.exec("ROLLBACK");
    }
    await expect(inserting).rejects.toThrow(/changed|expired|closed|authoriz|unavailable|revoked/);
  } finally {
    retry.release();
    if (postgres) {
      await postgres.query("SELECT pg_advisory_unlock_all()");
    }
    if (sqlite?.isTransaction) {
      sqlite.exec("ROLLBACK");
    }
    await inserting?.catch(() => {});
    sqlite?.close();
    await postgres?.end();
  }
}

type PublicationRetryProbe = {
  arm(): void;
  hasRetried(): boolean;
  reached(operation: Promise<unknown>): Promise<void>;
  release(): void;
};

/** Bind only a test backend decorator; all policy, SQL, admission and settlement stay real. */
export async function withPublicationRetryProbe<T>(
  signal: AbortSignal,
  run: (retry: PublicationRetryProbe) => Promise<T>,
): Promise<T> {
  const key = "openclaw.test.publicationSourceRetry";
  const previous = getEnvironmentData(key);
  const barrier = new Int32Array(new SharedArrayBuffer(3 * Int32Array.BYTES_PER_ELEMENT));
  setEnvironmentData(key, barrier.buffer);
  const release = () => {
    Atomics.store(barrier, 2, 1);
    Atomics.notify(barrier, 2);
    Atomics.notify(barrier, 1);
  };
  try {
    const source = resolveRuntimeProcessEntrypointUrl("sharedStateStore");
    return await withRuntimeWorkerGeneration(
      async (bind) => {
        bind((url) =>
          url.href === source.href
            ? resolveRuntimeWorkerUrl(storageProcessTestEntrypoints.publicationSourceRetry)
            : url,
        );
        try {
          return await run({
            arm() {
              Atomics.store(barrier, 1, 0);
              Atomics.store(barrier, 2, 0);
              Atomics.store(barrier, 0, 1);
            },
            hasRetried: () => Atomics.load(barrier, 1) === 1,
            reached: (operation) =>
              withinTest(
                awaitGateBeforeSettlement(
                  (async () => {
                    while (Atomics.load(barrier, 1) === 0) {
                      if (Atomics.load(barrier, 2) === 1) {
                        throw new Error("Native source reservation never retried");
                      }
                      await Atomics.waitAsync(barrier, 1, 0).value;
                    }
                  })(),
                  operation,
                  "Native source reservation never retried",
                ),
                signal,
              ),
            release,
          });
        } finally {
          release();
        }
      },
      async () => {},
    );
  } finally {
    release();
    setEnvironmentData(key, previous);
  }
}
