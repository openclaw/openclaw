import { expect, it } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import { addSessionMember, removeSessionMember } from "../config/sessions/session-sharing-store.js";
import { readDatabasePathIdentitySync } from "../infra/sqlite-worker-identity.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../state/openclaw-agent-db-lifecycle.js";
import { registerOpenClawAgentDatabase } from "../state/openclaw-agent-db-registry.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { prepareSessionMutationFacts } from "./session-sharing-preparation.js";

it("retains original-store sharing publications after configured routing changes and retires on native close", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const original = state.statePath("original.sqlite");
    const configured = state.statePath("configured.sqlite");
    const canonicalKey = "agent:main:main";
    const scope = { agentId: "main", storePath: original, sessionKey: canonicalKey };
    replaceSessionEntrySync(scope, {
      sessionId: "original",
      lifecycleRevision: "original-revision",
      updatedAt: 1,
      visibility: "shared",
    });
    await addSessionMember(scope, { identityId: "original-member", addedBy: "owner" });
    replaceSessionEntrySync(
      { ...scope, storePath: configured },
      {
        sessionId: "configured",
        lifecycleRevision: "configured-revision",
        updatedAt: 1,
        visibility: "shared",
      },
    );
    registerOpenClawAgentDatabase({ agentId: "main", path: original, env: state.env });
    const cfg = {
      agents: { entries: { main: {} } },
      session: { store: configured, mainKey: "different-main" },
    };
    await state.writeConfig(cfg);
    setRuntimeConfigSnapshot(cfg);
    const identity = readDatabasePathIdentitySync(original);
    const prepared = await prepareSessionMutationFacts({
      cfg,
      agentId: "main",
      sessionKey: canonicalKey,
      preparedSource: {
        agentId: "main",
        path: original,
        storePath: original,
        canonicalKey,
        databaseIdentity: identity.key.slice("file:".length),
        databaseBirthtime: identity.birthtime,
        assertCurrent() {},
      },
    });
    try {
      expect(prepared.storageTarget).toEqual({
        agentId: "main",
        canonicalKey,
        storePath: original,
      });
      expect(prepared.readCurrent(cfg).target.entry.sessionId).toBe("original");
      expect(prepared.readCurrent(cfg).membership.has("original-member")).toBe(true);
      await removeSessionMember(scope, "original-member");
      expect(prepared.readCurrent(cfg).membership.has("original-member")).toBe(false);
      await closeOpenClawAgentDatabaseByPathAsync(original, "main");
      expect(() => prepared.readCurrent(cfg)).toThrow("Session access facts are unavailable");
    } finally {
      prepared.release();
    }
  });
});

it("refuses mismatched physical custody and a different logical agent without borrowing configured facts", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const original = state.statePath("original.sqlite");
    const canonicalKey = "agent:main:test";
    replaceSessionEntrySync(
      { agentId: "main", storePath: original, sessionKey: canonicalKey },
      {
        sessionId: "original",
        lifecycleRevision: "revision",
        updatedAt: 1,
      },
    );
    const cfg = { agents: { entries: { main: {} } }, session: { store: original } };
    await state.writeConfig(cfg);
    setRuntimeConfigSnapshot(cfg);
    const identity = readDatabasePathIdentitySync(original);
    const source = {
      agentId: "main",
      path: original,
      storePath: original,
      canonicalKey,
      databaseIdentity: identity.key.slice("file:".length),
      databaseBirthtime: identity.birthtime,
      assertCurrent() {},
    };
    await expect(
      prepareSessionMutationFacts({
        cfg,
        agentId: "main",
        sessionKey: canonicalKey,
        preparedSource: { ...source, databaseIdentity: "retired-generation" },
      }),
    ).rejects.toMatchObject({
      name: "SessionMutationFactsUnavailableError",
      cause: { message: "SQLite database file identity changed before existing-only open" },
    });
    await expect(
      prepareSessionMutationFacts({
        cfg,
        agentId: "main",
        sessionKey: canonicalKey,
        preparedSource: { ...source, agentId: "other" },
      }),
    ).rejects.toThrow("Session access facts are unavailable");
  });
});
