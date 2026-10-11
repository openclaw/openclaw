import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { patchSessionEntryCore } from "../config/sessions/session-accessor.sqlite-entry.js";
import { memorySessionActorOwners } from "../config/sessions/session-actor-memory-owner.js";
import { readSessionActorStorageResult } from "../config/sessions/session-actor-storage-result.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withPluginMetadataSnapshotScope } from "../plugins/current-plugin-metadata-snapshot.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { maybeGenerateSessionTitle } from "./dashboard-session-title.js";

const generate = vi.hoisted(() => vi.fn());
// mock-isolation: Supply inference results without loading model runtimes; title persistence uses the real memory actor.
vi.mock("../auto-reply/reply/conversation-label-generator.js", () => ({
  generateConversationLabelWithFallback: generate,
}));
const authority = { assertCurrent() {} };
const cfg: OpenClawConfig = {
  agents: { entries: { main: {} }, defaults: { model: { primary: "openai/gpt-5.5" } } },
};
const env = { OPENCLAW_STATE_DIR: "/synthetic/dashboard-title" };
afterEach(() => memorySessionActorOwners.reset());

async function fixture() {
  const sessionKey = "agent:main:dashboard:incognito-title";
  const owner = memorySessionActorOwners.get({
    agentId: "main",
    path: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env }),
  });
  const actor = await owner.acquire(
    { database: owner.identity, sessionKey },
    { assertCurrent() {}, assertReadable() {} },
  );
  try {
    readSessionActorStorageResult(
      await actor.storage!.mutate(
        {
          type: "session.entry.create",
          input: { entry: { sessionId: "title", updatedAt: 1, incognito: true } },
        },
        authority,
      ),
    );
  } finally {
    await actor.release();
  }
  const scope = { agentId: "main", sessionKey, storePath: owner.path };
  return {
    owner,
    scope,
    generate: () =>
      withPluginMetadataSnapshotScope(
        createPluginMetadataSnapshotFixture(),
        () =>
          maybeGenerateSessionTitle({
            cfg,
            ...scope,
            sessionId: "title",
            userMessage: "Plan my workspace",
          }),
        { config: cfg, trustConfigIdentity: true },
      ),
  };
}

it("titles an unbound memory session and commits without session SQL", async () => {
  const target = await fixture();
  generate.mockResolvedValue("Workspace planning");
  const sql = observeHostDataSql();
  try {
    expect(await target.generate()).toBe(true);
    expect(target.owner.readSession(target.scope.sessionKey, authority)?.entry?.displayName).toBe(
      "Workspace planning",
    );
    expect(sql.queries).toEqual([]);
  } finally {
    sql.restore();
  }
});

it("keeps a user title saved while automatic title inference is running", async () => {
  const target = await fixture();
  const entered = createDeferred();
  const resume = createDeferred<string>();
  generate.mockImplementation(() => {
    entered.resolve();
    return resume.promise;
  });
  const pending = target.generate();
  const settled = pending.then(
    () => undefined,
    () => undefined,
  );
  try {
    await awaitGateBeforeSettlement(entered.promise, pending, "title inference was skipped");
    await patchSessionEntryCore(target.scope, () => ({ displayName: "My chosen title" }));
    resume.resolve("Generated title");
    expect(await pending).toBe(false);
    expect(target.owner.readSession(target.scope.sessionKey, authority)?.entry?.displayName).toBe(
      "My chosen title",
    );
  } finally {
    resume.resolve("Generated title");
    await settled;
  }
});
