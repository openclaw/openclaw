import "../test-utils/prepare-compiled-subprocesses.js";
import fs from "node:fs";
import { expect, it } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { hasOpenClawAgentDatabaseAsyncResources } from "../state/openclaw-agent-db-resources.js";
import {
  closeOpenClawAgentDatabaseByPathAsync as closeDatabase,
  openOpenClawAgentDatabase as openDatabase,
} from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { retainGatewaySessionEntryReadOnly as retainRead } from "./session-utils-read-lifetime.js";

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
      const entry = { sessionId: "same", lifecycleRevision: "same", updatedAt: 1 };
      for (const storePath of [original, replacement]) {
        await upsertSessionEntryCore({ agentId: "main", storePath, sessionKey }, entry);
        // Settle seed workers, then restore the warm handle before testing read lifetime.
        await closeDatabase(storePath);
        openDatabase({ agentId: "main", path: storePath });
      }
      fs.symlinkSync(originalDirectory, aliasDirectory, "junction");
      const config = {
        agents: { entries: { main: { workspace: state.workspaceDir } } },
        session: { store: alias },
      };
      await state.writeConfig(config);
      setRuntimeConfigSnapshot(config);
      if (change === "cold-store close") {
        await closeDatabase(original);
      } else if (change === "same-file reopen") {
        openDatabase({ agentId: "main", path: alias });
      }
      const read = await retainRead(sessionKey, "main");
      try {
        expect(read.entry?.sessionId).toBe("same");
        expect(read.isCurrentAtResponse()).toBe(true);
        if (change === "alias replacement") {
          fs.rmSync(aliasDirectory, { recursive: true });
          fs.symlinkSync(replacementDirectory, aliasDirectory, "junction");
        } else {
          await closeDatabase(read.readSource!.path);
          if (change === "same-file reopen") {
            const successor = await retainRead(sessionKey, "main");
            expect(successor.isCurrentAtResponse()).toBe(true);
            successor.release();
          }
        }
        expect(read.isCurrentAtResponse()).toBe(false);
      } finally {
        read.release();
      }
      expect(read.isCurrent()).toBe(false);
      await closeDatabase(read.readSource!.path);
      expect(hasOpenClawAgentDatabaseAsyncResources()).toBe(false);
    });
  },
);
