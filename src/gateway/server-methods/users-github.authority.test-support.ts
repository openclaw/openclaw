import { StatementSync } from "node:sqlite";
import { expect, vi } from "vitest";
import { observeSqliteReadSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  expireUserGitHubAccessToken,
  updateUserGitHubConnection,
} from "../../state/user-github-connections.test-support.js";
import type { LegacyPersonalGitHubService } from "../github-oauth-lifecycle-host.types.js";
import { preparePersonalProfileAction } from "./personal-profile-authorization.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";
import { network, tokens } from "./users-github.test-support.js";

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

export async function preparePendingPersonalGitHubRefresh(
  owner: string,
  personal: Pick<LegacyPersonalGitHubService, "refresh">,
) {
  expireUserGitHubAccessToken(owner);
  const refresh = createDeferredCore<{ status: "refreshed"; tokens: typeof tokens }>();
  network.refresh.mockReturnValueOnce(refresh.promise);
  const pending = personal.refresh(owner);
  await vi.waitFor(() => expect(network.refresh).toHaveBeenCalledOnce());
  return { refresh, pending };
}
