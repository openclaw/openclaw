import "../test-utils/prepare-compiled-subprocesses.js";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { patchSessionEntryCore } from "../config/sessions/session-accessor.sqlite-entry.js";
import { withIncognitoSessionActor } from "../config/sessions/session-incognito-binding.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withPluginMetadataSnapshotScope } from "../plugins/current-plugin-metadata-snapshot.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { openIncognitoTestActor } from "../state/openclaw-agent-execution-incognito.test-support.js";
import { maybeGenerateSessionTitle } from "./dashboard-session-title.js";

const generate = vi.hoisted(() => vi.fn());
// mock-isolation: keep provider execution outside the controlled title-inference lifetime.
vi.mock("../auto-reply/reply/conversation-label-generator.js", () => ({
  generateConversationLabelWithFallback: generate,
}));

const dirs = useAutoCleanupTempDirTracker(afterAll);
const authority = { assertCurrent() {} };
const cfg: OpenClawConfig = {
  agents: { entries: { main: {} }, defaults: { model: { primary: "openai/gpt-5.5" } } },
};
let actor: Awaited<ReturnType<typeof openIncognitoTestActor>>;
beforeAll(async () => {
  actor = await openIncognitoTestActor(
    { OPENCLAW_STATE_DIR: dirs.make("title-actor-") },
    authority,
  );
});
afterAll(async () => actor?.close());

it("titles the bound session through actor history and commits without host session SQL", async () => {
  const sessionKey = "agent:main:dashboard:incognito-title";
  const entry: SessionEntry = { sessionId: "title", updatedAt: Date.now(), incognito: true };
  await actor.sessions.create(authority, { sessionKey, entry });
  generate.mockResolvedValue("Workspace planning");
  // Title requests inherit the Gateway's admitted metadata generation.
  await withPluginMetadataSnapshotScope(
    createPluginMetadataSnapshotFixture(),
    async () => {
      const sql = observeHostDataSql();
      try {
        expect(
          await withIncognitoSessionActor(actor, () =>
            maybeGenerateSessionTitle({
              cfg,
              agentId: "main",
              sessionKey,
              sessionId: entry.sessionId,
              storePath: actor.path,
              userMessage: "Plan my workspace",
            }),
          ),
        ).toBe(true);
        expect((await actor.sessions.read(authority, { sessionKey })).entry?.displayName).toBe(
          "Workspace planning",
        );
        expect(sql.queries).toEqual([]);
      } finally {
        sql.restore();
      }
    },
    { config: cfg, trustConfigIdentity: true },
  );
});

it("refuses a title after the same session ID acquires another lifecycle during inference", async () => {
  const sessionKey = "agent:main:dashboard:incognito-title-race";
  const entry: SessionEntry = { sessionId: "title-race", updatedAt: Date.now(), incognito: true };
  await actor.sessions.create(authority, { sessionKey, entry });
  const entered = createDeferred();
  const resume = createDeferred<string>();
  generate.mockImplementation(() => {
    entered.resolve();
    return resume.promise;
  });
  const pending = withIncognitoSessionActor(actor, () =>
    maybeGenerateSessionTitle({
      cfg,
      agentId: "main",
      sessionKey,
      sessionId: entry.sessionId,
      storePath: actor.path,
      userMessage: "Plan my workspace",
    }),
  );
  const settled = pending.then(
    () => undefined,
    () => undefined,
  );
  try {
    await awaitGateBeforeSettlement(entered.promise, pending, "title inference was skipped");
    await withIncognitoSessionActor(actor, () =>
      patchSessionEntryCore({ agentId: actor.agentId, storePath: actor.path, sessionKey }, () => ({
        lifecycleRevision: "next",
      })),
    );
    resume.resolve("Stale title");
    await expect(pending).rejects.toThrow(/generation|current/i);
    expect(
      (await actor.sessions.read(authority, { sessionKey })).entry?.displayName,
    ).toBeUndefined();
  } finally {
    resume.resolve("Stale title");
    await settled;
  }
});
