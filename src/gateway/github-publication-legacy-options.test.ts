import fs from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { removeTempDirectoryAsync } from "../infra/sqlite-readonly-location-cleanup.js";
import { createSqliteSnapshotStagingDirectory } from "../infra/sqlite-snapshot-staging.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import {
  callPersonalPublicationRpc,
  createPersonalPublicationFixture,
  personalPublicationAccount as account,
  personalPublicationRequest,
  preparePersonalPublicationFixtureAction as prepareAction,
} from "./github-personal-publication.test-support.js";
import * as publicationStore from "./github-publication-store-async.js";
import {
  claimGitHubPublicationExecutionFixture,
  createGitHubPublicationExecutionStoreFixture,
} from "./github-publication-store.test-support.js";
import {
  NEW_HEAD,
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
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function expectOptions(expected: Record<string, unknown>) {
  const [ok, result, error] = await callPersonalPublicationRpc(fixture, "sessions.github.options");
  expect(ok, JSON.stringify(error)).toBe(true);
  expect(result).toMatchObject({
    personal: { state: "connected", generation: fixture.generation, account },
    ...expected,
  });
}

it("reads current receipts while another snapshot retains an earlier launch environment", async () => {
  const directory = await createSqliteSnapshotStagingDirectory(root, false, undefined, true);
  vi.stubEnv("OPENCLAW_GITHUB_OPTIONS_FIXTURE", "changed-after-staging-allocation");
  try {
    const row = insertSharedWorktreeReceipt("current-shared");
    await expectOptions({
      latestShared: { result: { requestId: row.request_id, status: "requested" } },
    });
    expect(fs.existsSync(directory)).toBe(true);
  } finally {
    expect(await removeTempDirectoryAsync(directory)).toBe(true);
  }
});

const lifecycleTable = "github_publication_session_lifecycles";
it.each([`DROP TABLE ${lifecycleTable}`, `DELETE FROM ${lifecycleTable}`])(
  "keeps account choices and personal recovery after %s",
  async (removeLifecycle) => {
    const { client, context, coordinator, generation } = fixture;
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
    // v2026.9.1 receipts have no lifecycle companion.
    db.exec(removeLifecycle);
    await expectOptions({
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
    const action = await prepareAction({ client, context }, controller.signal);
    await expect(
      coordinator.requestPersonalForSessionV2(
        personalPublicationRequest(fixture, "personal-after-upgrade"),
        action,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    interrupted.mockRestore();
    await expectOptions({
      latestShared: null,
      pendingPersonal: {
        result: { status: "needs_confirmation" },
        confirmation: { generation, account },
      },
    });
    expect(commands.some((argv) => argv.includes("push"))).toBe(false);
    expect(
      db
        .prepare(`SELECT request_id FROM ${lifecycleTable} WHERE request_id = ?`)
        .get(legacy.request_id),
    ).toBeUndefined();
  },
);
