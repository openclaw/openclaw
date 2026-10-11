import "../test-utils/prepare-compiled-subprocesses.js";
import fs from "node:fs";
import { expect, it } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { hasOpenClawAgentDatabaseAsyncResources } from "../state/openclaw-agent-db-resources.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { retainGatewaySessionEntryReadOnly } from "./session-utils-read-lifetime.js";

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
