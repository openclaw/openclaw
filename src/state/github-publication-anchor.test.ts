import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { createSqlPublicationTestConnection } from "../../test/helpers/sql-publication-connection.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import {
  captureGitHubPublicationWorkerReceipt,
  githubPublicationReceipts,
} from "./github-publication-receipts.js";
import { openTrackedStateDatabase } from "./openclaw-state-db-handle.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it.each(["commit", "rollback"])("settles lifecycle receipts on the anchor after %s", (outcome) => {
  using anchor = openTrackedStateDatabase(
    path.join(tempDirs.make("github-publication-anchor-"), "state.sqlite"),
  );
  const connection = createSqlPublicationTestConnection(anchor);
  const row = {
    publication_kind: "shared",
    request_id: "synthetic-request",
    lifecycle_revision: "synthetic-revision",
    requester_authority_json: null,
  };
  const published: unknown[] = [];
  const unsubscribe = githubPublicationReceipts.subscribeFacts((change) => {
    if (change.kind === "committed") {
      published.push(change.receipt.facts.get('["shared-lifecycle","synthetic-request"]'));
    }
  });
  try {
    const transact = () =>
      runSqliteImmediateTransactionSync(anchor, () => {
        const captured = captureGitHubPublicationWorkerReceipt(connection, () => {
          githubPublicationReceipts.stageRow(connection, "shared-lifecycle", row);
          expect(published).toEqual([]);
          return {};
        });
        expect(captured.authority).toMatchObject({
          facts: new Map([
            ['["shared-lifecycle","synthetic-request"]', { kind: "postimage", value: row }],
          ]),
        });
        if (outcome === "rollback") {
          throw new Error("synthetic rollback");
        }
      });
    if (outcome === "rollback") {
      expect(transact).toThrow("synthetic rollback");
      expect(published).toEqual([]);
    } else {
      transact();
      expect(published).toEqual([{ kind: "postimage", value: row }]);
    }
  } finally {
    unsubscribe();
  }
});
