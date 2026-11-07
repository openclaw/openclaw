import { createHash } from "node:crypto";
import { Client } from "pg";
import { expect, onTestFinished } from "vitest";
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
        policyReads++;
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
    resetPolicyReads: () => {
      policyReads = 0;
    },
    // createAdmission validates once; the worker's prepare grant validates again.
    waitForWorkerAdmission: () => expect.poll(() => policyReads).toBeGreaterThanOrEqual(2),
  };
}

/** Hold the real source writer lock across dispatch, then revoke the authenticated principal. */
export async function denyWhileSourceReserved(
  row: Parameters<typeof insertRepositoryGitHubPublicationAsync>[0],
  source: Parameters<typeof insertRepositoryGitHubPublicationAsync>[1],
  authority: Awaited<ReturnType<typeof preparePublicationAuthority>>,
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
    authority.resetPolicyReads();
    inserting = insertRepositoryGitHubPublicationAsync(row, source);
    void inserting.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await authority.waitForWorkerAdmission();
    expect(settled).toBe(false);
    // A durable profile edit shares this writer's FIFO lane. Commit a runtime policy change
    // through the production publication owner instead; it can revoke while that lane waits.
    authority.revoke();
    if (postgres) {
      await postgres.query("SELECT pg_advisory_unlock_all()");
    } else {
      sqlite!.exec("ROLLBACK");
    }
    await expect(inserting).rejects.toThrow(/changed|expired|closed|authoriz|unavailable|revoked/);
  } finally {
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
