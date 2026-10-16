import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { removeTempDirectoryAsync } from "../infra/sqlite-readonly-location-cleanup.js";
import { createSqliteSnapshotStagingDirectory } from "../infra/sqlite-snapshot-staging.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import {
  callPersonalPublicationRpc,
  createPersonalPublicationFixture,
  personalPublicationAccount as account,
  preparePersonalPublicationFixtureAction,
} from "./github-personal-publication.test-support.js";
import * as publicationStore from "./github-publication-store-async.js";
import {
  claimGitHubPublicationExecutionFixture,
  createGitHubPublicationExecutionStoreFixture,
} from "./github-publication-store.test-support.js";
import {
  NEW_HEAD,
  SESSION_KEY,
  commands,
  installGitHubPublicationTestHarness,
  root,
} from "./github-publication.test-support.js";
import { insertSharedWorktreeReceipt } from "./github-shared-publication.test-support.js";

installGitHubPublicationTestHarness();
let fixture: Awaited<ReturnType<typeof createPersonalPublicationFixture>>;
beforeEach(async () => {
  fixture = await createPersonalPublicationFixture();
});
afterEach(() => vi.unstubAllGlobals());

describe("publication options after a retained-state upgrade", () => {
  it("reads current receipts while another snapshot retains an earlier launch environment", async () => {
    const directory = await createSqliteSnapshotStagingDirectory(root, false, undefined, true);
    vi.stubEnv("OPENCLAW_GITHUB_OPTIONS_FIXTURE", "changed-after-staging-allocation");
    try {
      const row = insertSharedWorktreeReceipt("current-shared");
      const options = await callPersonalPublicationRpc(fixture, "sessions.github.options");
      expect(options[0], JSON.stringify(options[2])).toBe(true);
      expect(fs.existsSync(directory)).toBe(true);
      expect(options[1]).toMatchObject({
        personal: { state: "connected", generation: fixture.generation, account },
        latestShared: { result: { requestId: row.request_id, status: "requested" } },
      });
    } finally {
      expect(await removeTempDirectoryAsync(directory)).toBe(true);
    }
  });

  it.each(["table", "row"])(
    "keeps account choices and personal recovery with no legacy lifecycle %s",
    async (missing) => {
      const { client, context, coordinator, generation } = fixture;
      const rpc = (method: string, params?: Record<string, unknown>) =>
        callPersonalPublicationRpc(fixture, method, params);
      const legacy = insertSharedWorktreeReceipt("legacy-terminal");
      const claimed = claimGitHubPublicationExecutionFixture(legacy.request_id, "legacy-instance");
      createGitHubPublicationExecutionStoreFixture("legacy-instance").complete(claimed, {
        requestId: legacy.request_id,
        status: "published",
        repository: "openclaw/openclaw",
        branch: legacy.branch,
        url: "https://github.com/openclaw/openclaw/pull/12",
        headCommit: NEW_HEAD,
      });
      const db = openOpenClawStateDatabase().db;
      // The released v2026.9.1 writer has no lifecycle companion for this receipt.
      if (missing === "table") {
        db.exec("DROP TABLE github_publication_session_lifecycles");
      } else {
        db.prepare("DELETE FROM github_publication_session_lifecycles WHERE request_id = ?").run(
          legacy.request_id,
        );
      }
      const options = await rpc("sessions.github.options");
      expect(options[0], JSON.stringify(options[2])).toBe(true);
      expect(options[1]).toMatchObject({
        personal: { state: "connected", generation, account },
        shared: { source: "system-configured", accountId: 42, login: "roboclaw-bot" },
        pendingPersonal: null,
        latestShared: null,
      });

      const controller = new AbortController();
      const claim = publicationStore.claimPersonalGitHubPublicationAsync;
      const interrupted = vi
        .spyOn(publicationStore, "claimPersonalGitHubPublicationAsync")
        .mockImplementation(async (...args) => {
          const execution = await claim(...args);
          controller.abort();
          return execution;
        });
      const action = await preparePersonalPublicationFixtureAction(
        { client, context },
        controller.signal,
      );
      try {
        await expect(
          coordinator.requestPersonalForSessionV2(
            {
              sessionKey: SESSION_KEY,
              idempotencyKey: "personal-after-upgrade",
              selection: { source: "personal", generation, account },
            },
            action,
          ),
        ).rejects.toMatchObject({ name: "AbortError" });
      } finally {
        interrupted.mockRestore();
      }
      const recovered = await rpc("sessions.github.options");
      expect(recovered[0], JSON.stringify(recovered[2])).toBe(true);
      expect(recovered[1]).toMatchObject({
        personal: { state: "connected", generation, account },
        latestShared: null,
        pendingPersonal: {
          result: { status: "needs_confirmation" },
          confirmation: { generation, account },
        },
      });
      expect(commands.some((argv) => argv.includes("push"))).toBe(false);
      expect(
        db
          .prepare(
            "SELECT request_id FROM github_publication_session_lifecycles WHERE request_id = ?",
          )
          .get(legacy.request_id),
      ).toBeUndefined();
    },
  );
});
