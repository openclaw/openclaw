import "../test-utils/prepare-compiled-subprocesses.js";
import fs from "node:fs";
import { expect, it } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { patchSessionEntryCore } from "../config/sessions/session-accessor.sqlite-entry.js";
import {
  captureSessionEntryMetadataRead,
  captureSessionEntrySourceAssertion,
} from "../config/sessions/session-entry-source-authority.js";
import { withIncognitoSessionBinding } from "../config/sessions/session-incognito-binding.js";
import { sessionEntryCommitGuardOptions } from "../config/sessions/session-source-authority.js";
import { hasOpenClawAgentDatabaseAsyncResources } from "../state/openclaw-agent-db-resources.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { openIncognitoTestActor } from "../state/openclaw-agent-execution-incognito.test-support.js";
import { captureOpenClawAgentDatabaseExecution } from "../state/openclaw-agent-execution.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  retainGatewaySessionEntryReadOnly,
  withGatewaySessionEntryReadOnly,
} from "./session-utils-read-lifetime.js";

it("reads committed durable rows without host SQL and checks caller authority", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const cfg = { agents: { entries: { main: {} } } };
    const key = "agent:main:saved";
    const scope = { agentId: "main", sessionKey: key, env: state.env };
    const params = { cfg, key, env: state.env };
    await upsertSessionEntryCore(scope, {
      sessionId: "durable-session",
      updatedAt: 1,
      displayName: "Before write",
    });
    const read = () => withGatewaySessionEntryReadOnly(params, async (loaded) => loaded.entry);
    await read();
    const expectRead = async (displayName: string) => {
      const sql = observeHostDataSql();
      try {
        expect(await read()).toMatchObject({ sessionId: "durable-session", displayName });
        expect(sql.queries).toEqual([]);
      } finally {
        sql.restore();
      }
    };
    await expectRead("Before write");
    await patchSessionEntryCore(scope, () => ({ displayName: "After write" }), {
      requireWriteSuccess: true,
    });
    await expectRead("After write");

    const revoked = new Error("Caller no longer authorized");
    let active = true;
    let consumed = false;
    const pending = withGatewaySessionEntryReadOnly(
      {
        ...params,
        assertActive() {
          if (!active) {
            throw revoked;
          }
        },
      },
      async () => {
        consumed = true;
      },
    );
    active = false;
    await expect(pending).rejects.toBe(revoked);
    expect(consumed).toBe(false);
  });
});

it.each(["alias replacement", "cold-store close", "same-file reopen"] as const)(
  "rejects a retained metadata read after %s",
  async (change) => {
    await withOpenClawTestState({ label: "metadata-read-owner" }, async (state) => {
      const originalDirectory = state.statePath("original");
      const replacementDirectory = state.statePath("replacement");
      const aliasDirectory = state.statePath("selected");
      const original = state.statePath("original", "catalog.sqlite");
      const replacement = state.statePath("replacement", "catalog.sqlite");
      const alias = state.statePath("selected", "catalog.sqlite");
      const sessionKey = "agent:main:saved";
      for (const storePath of [original, replacement]) {
        await upsertSessionEntryCore(
          { agentId: "main", storePath, sessionKey },
          {
            sessionId: "identical-session",
            lifecycleRevision: "identical-generation",
            updatedAt: 1,
          },
        );
        // Settle seed workers, then restore the warm handle before testing read lifetime.
        await closeOpenClawAgentDatabaseByPathAsync(storePath);
        openOpenClawAgentDatabase({ agentId: "main", path: storePath });
      }
      fs.symlinkSync(originalDirectory, aliasDirectory, "junction");
      const config = {
        agents: { entries: { main: { workspace: state.workspaceDir } } },
        session: { store: alias },
      };
      await state.writeConfig(config);
      setRuntimeConfigSnapshot(config);
      if (change === "cold-store close") {
        await closeOpenClawAgentDatabaseByPathAsync(original);
      } else if (change === "same-file reopen") {
        openOpenClawAgentDatabase({ agentId: "main", path: alias });
      }
      const read = retainGatewaySessionEntryReadOnly(sessionKey, "main");
      try {
        expect(read.entry?.sessionId).toBe("identical-session");
        expect(read.isCurrentAtResponse()).toBe(true);
        if (change === "alias replacement") {
          fs.rmSync(aliasDirectory, { recursive: true });
          fs.symlinkSync(replacementDirectory, aliasDirectory, "junction");
        } else {
          await closeOpenClawAgentDatabaseByPathAsync(read.readSource!.path);
          if (change === "same-file reopen") {
            const successor = retainGatewaySessionEntryReadOnly(sessionKey, "main");
            expect(successor.isCurrentAtResponse()).toBe(true);
            successor.release();
          }
        }
        expect(read.isCurrentAtResponse()).toBe(false);
      } finally {
        read.release();
      }
      expect(read.isCurrent()).toBe(false);
      await closeOpenClawAgentDatabaseByPathAsync(read.readSource!.path);
      expect(hasOpenClawAgentDatabaseAsyncResources()).toBe(false);
    });
  },
);

it("keeps actor workspace predicates current without pinning unrelated planning metadata", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const authority = { assertCurrent() {} };
    const cfg = { agents: { entries: { main: {} } } };
    const key = "agent:main:dashboard:incognito-workspace-authority";
    const actor = await openIncognitoTestActor(state.env, authority);
    const initial = {
      sessionId: "workspace-session",
      updatedAt: 1,
      sessionDiffBaseline: {
        version: 1 as const,
        sessionId: "workspace-session",
        root: state.workspaceDir,
        files: [{ path: "before.txt", fingerprint: "baseline-fingerprint" }],
      },
    };
    await actor.sessions.create(authority, { sessionKey: key, entry: initial });
    let captured: ReturnType<typeof captureSessionEntryMetadataRead> = undefined;
    const sql = observeHostDataSql();
    try {
      const result = await withIncognitoSessionBinding({ actor }, () =>
        withGatewaySessionEntryReadOnly({ cfg, key, env: state.env }, async (loaded) => {
          expect(loaded.entry?.sessionDiffBaseline).toEqual(initial.sessionDiffBaseline);
          const scope = { agentId: "main", sessionKey: key, storePath: loaded.storePath };
          captured = captureSessionEntryMetadataRead(scope);
          const source = captureSessionEntrySourceAssertion({
            scope,
            expected: loaded.entry,
            fields: ["sessionId", "lifecycleRevision", "projectId", "worktree"],
            assertCurrent() {},
            refuse() {
              throw new Error("Workspace authority changed");
            },
          });
          await patchSessionEntryCore(scope, () => ({ displayName: "Updated title" }), {
            ...sessionEntryCommitGuardOptions(source),
            requireWriteSuccess: true,
          });
          expect(() => source()).not.toThrow();
          await patchSessionEntryCore(scope, () => ({ projectId: "attached-project" }), {
            requireWriteSuccess: true,
          });
          expect(() => source()).toThrow("Workspace authority changed");
          return captured?.readCurrent()?.projectId;
        }),
      );
      expect(result).toBe("attached-project");
      expect(sql.queries).toEqual([]);
    } finally {
      sql.restore();
      await actor.release();
      await actor.close();
    }
    const replacement = await openIncognitoTestActor(state.env, authority);
    try {
      await replacement.sessions.create(authority, { sessionKey: key, entry: initial });
      expect(() => captured?.readCurrent()).toThrow();
    } finally {
      await replacement.release();
      await replacement.close();
    }
  });
});

it("keeps unbound private reads native and distinguishes explicitly selected absence", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const cfg = { agents: { entries: { main: {} } } };
    const key = "agent:main:dashboard:incognito-native-workspace";
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: key, env: state.env },
      { sessionId: "native-workspace", updatedAt: 1, projectId: "native-project" },
    );
    const read = () =>
      withGatewaySessionEntryReadOnly({ cfg, key, env: state.env }, async (loaded) => loaded.entry);
    expect((await read())?.projectId).toBe("native-project");
    expect(captureOpenClawAgentDatabaseExecution.listIncognito(state.env)).toEqual([]);
    const sql = observeHostDataSql();
    try {
      const absent = await withIncognitoSessionBinding(
        { kind: "absent", agentId: "main", env: state.env, authority: { assertCurrent() {} } },
        read,
      );
      expect(absent).toBeUndefined();
      expect(sql.queries).toEqual([]);
    } finally {
      sql.restore();
    }
    expect(captureOpenClawAgentDatabaseExecution.listIncognito(state.env)).toEqual([]);
    expect((await read())?.projectId).toBe("native-project");
  });
});
