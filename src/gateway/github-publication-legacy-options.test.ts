import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensurePersonalGitHubPublicationSchema } from "../state/openclaw-state-db-schema-additive.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import {
  callPersonalPublicationRpc,
  createPersonalPublicationFixture,
  personalPublicationAccount as account,
} from "./github-personal-publication.test-support.js";
import {
  claimGitHubPublicationExecution,
  createGitHubPublicationExecutionStore,
} from "./github-publication-store.js";
import {
  NEW_HEAD,
  SESSION_KEY,
  commands,
  installGitHubPublicationTestHarness,
} from "./github-publication.test-support.js";
import { insertSharedWorktreeReceipt } from "./github-shared-publication.test-support.js";
import { preparePersonalGitHubSessionAction } from "./server-methods/github-personal-authorization.js";

installGitHubPublicationTestHarness();
let fixture: Awaited<ReturnType<typeof createPersonalPublicationFixture>>;
beforeEach(async () => {
  fixture = await createPersonalPublicationFixture();
});
afterEach(() => vi.unstubAllGlobals());

describe("publication options after a retained-state upgrade", () => {
  it.each(["table", "row"])(
    "keeps account choices and personal recovery with no legacy lifecycle %s",
    async (missing) => {
      const { client, context, coordinator, generation } = fixture;
      const rpc = (method: string, params?: Record<string, unknown>) =>
        callPersonalPublicationRpc(fixture, method, params);
      const legacy = insertSharedWorktreeReceipt("legacy-terminal");
      const claimed = claimGitHubPublicationExecution(legacy.request_id, "legacy-instance");
      createGitHubPublicationExecutionStore("legacy-instance").complete(claimed, {
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
      ensurePersonalGitHubPublicationSchema(db);
      db.function("stop_personal_upgrade_admission", () => {
        controller.abort();
        return 1;
      });
      db.exec(
        "CREATE TEMP TRIGGER stop_personal_upgrade_admission AFTER INSERT ON github_personal_publication_requests BEGIN SELECT stop_personal_upgrade_admission(); END",
      );
      const action = preparePersonalGitHubSessionAction(
        { client, context, signal: controller.signal },
        { sessionKey: SESSION_KEY },
      );
      await expect(
        coordinator.requestPersonalForSession(
          {
            sessionKey: SESSION_KEY,
            idempotencyKey: "personal-after-upgrade",
            selection: { source: "personal", generation, account },
          },
          action,
        ),
      ).rejects.toThrow("current");
      db.exec("DROP TRIGGER stop_personal_upgrade_admission");
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
