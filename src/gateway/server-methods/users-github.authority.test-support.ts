import { StatementSync } from "node:sqlite";
import { expect } from "vitest";
import { observeSqliteReadSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { updateUserGitHubConnection } from "../../state/user-github-connections.test-support.js";
import { preparePersonalGitHubActionV2 } from "./github-personal-authorization.js";
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
  const action = await preparePersonalGitHubActionV2(options);
  const reads = observeSqliteReadSql(StatementSync.prototype);
  try {
    action.assertCurrent();
    expect(reads.queries).toEqual([]);

    options.merge();
    reads.queries.length = 0;
    expect(() => action.assertCurrent()).toThrow("My GitHub owner changed");
    expect(reads.queries).toEqual([]);

    options.disconnect();
    expect(() => action.assertCurrent()).toThrow("current authenticated human");
    expect(reads.queries).toEqual([]);
  } finally {
    reads.restore();
  }
}
