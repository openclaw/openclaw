import { StatementSync } from "node:sqlite";
import { expect } from "vitest";
import { observeSqliteReadSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { updateUserGitHubConnection } from "../../state/user-github-connections.test-support.js";
import { setUserProfileRole } from "../../state/user-profile-writes.worker.js";
import { invalidateOperatorRolePolicy } from "../operator-role-policy.js";
import { preparePersonalProfileAction } from "./personal-profile-authorization.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

export function preparePersonalGitHubPoll(owner: string) {
  updateUserGitHubConnection(
    owner,
    (current) => {
      if (current?.pending?.kind !== "device") {
        throw new Error("Expected pending device authorization");
      }
      return { ...current, pending: { ...current.pending, nextPollAtMs: Date.now() } };
    },
    () => {},
  );
}

export async function expectReceiptBackedPersonalGitHubAuthority(options: {
  client: GatewayClient;
  context: GatewayRequestContext;
  merge: () => void;
  disconnect: () => void;
}) {
  const action = await preparePersonalProfileAction(options);
  const reads = observeSqliteReadSql(StatementSync.prototype);
  try {
    action.assertCurrent();
    expect(reads.queries).toEqual([]);

    options.merge();
    reads.queries.length = 0;
    expect(() => action.assertCurrent()).toThrow("Personal profile owner changed");
    expect(reads.queries).toEqual([]);

    options.disconnect();
    expect(() => action.assertCurrent()).toThrow("current authenticated human");
    expect(reads.queries).toEqual([]);
  } finally {
    reads.restore();
  }
}

export function revokePersonalGitHubRole(config: OpenClawConfig, profileId: string) {
  config.gateway = {
    roles: {
      definitions: { blocked: { scopes: [], agents: [], sessions: { others: "none" } } },
      default: "blocked",
    },
  };
  setUserProfileRole(profileId, "blocked");
  invalidateOperatorRolePolicy(profileId);
}
