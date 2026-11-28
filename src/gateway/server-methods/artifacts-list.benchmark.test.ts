import fs from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import {
  replaceSessionEntry,
  waitForSessionTranscriptProjection,
} from "../../config/sessions/session-accessor.js";
import { replaceTranscriptEvents } from "../../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import { historyLane } from "../../config/sessions/session-transcript-worker-resources.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../../state/openclaw-agent-db-lifecycle.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { artifactsHandlers } from "./artifacts.js";
import type { RespondFn } from "./types.js";

it.each(["default", "custom", "configured alias", "selected alias"] as const)(
  "retains the artifact history reader between lists and closes its %s store",
  async (store) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const alias = store === "configured alias" || store === "selected alias";
      const physicalPath =
        store === "default"
          ? resolveOpenClawAgentSqlitePath({ agentId: "main", env: state.env })
          : state.statePath(alias ? "physical.sqlite" : "custom.sqlite");
      const selectedPath = state.statePath("custom.sqlite");
      const configuredPath = alias ? state.statePath("custom.json") : physicalPath;
      if (alias) {
        await fs.symlink(physicalPath, selectedPath, "file");
      }
      const config = {
        agents: { entries: { main: {} } },
        ...(store === "default" ? {} : { session: { store: configuredPath } }),
      };
      await state.writeConfig(config);
      setRuntimeConfigSnapshot(config);
      const scope = {
        agentId: "main",
        sessionKey: "agent:main:artifact-reader-lifetime",
        sessionId: "artifact-reader-lifetime",
        storePath: physicalPath,
      };
      await replaceSessionEntry(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      await replaceTranscriptEvents(scope, [
        { type: "session", version: 3, id: scope.sessionId },
        {
          type: "message",
          id: "artifact",
          parentId: null,
          message: {
            role: "assistant",
            content: [{ type: "file", title: "result.txt", data: "aGVsbG8=" }],
          },
        },
      ]);
      await waitForSessionTranscriptProjection(scope);
      await closeOpenClawAgentDatabaseByPathAsync(physicalPath, "main");
      const context = createDirectChatContext({ getRuntimeConfig: () => config });
      const read = async () => {
        const respond = vi.fn<RespondFn>();
        await artifactsHandlers["artifacts.list"]!({
          params: { sessionKey: scope.sessionKey },
          context,
          client: null,
          req: { type: "req", id: "artifact-lifetime", method: "artifacts.list" },
          isWebchatConnect: () => false,
          respond,
        });
        expect(respond.mock.calls[0]?.[0]).toBe(true);
        return respond.mock.calls[0]?.[1];
      };
      const first = await read();
      expect(first).toMatchObject({
        artifacts: [{ title: "result.txt", sizeBytes: 5, sessionKey: scope.sessionKey }],
      });
      const close = vi.spyOn(historyLane.pool, "closeResources");
      try {
        expect(await read()).toEqual(first);
        expect(close).not.toHaveBeenCalled();
      } finally {
        close.mockRestore();
      }
      const claimSoleCustody = () => {
        const raw = new DatabaseSync(physicalPath);
        try {
          raw.exec("PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT");
        } finally {
          raw.close();
        }
      };
      expect(claimSoleCustody).toThrow(/database is locked/);
      await closeOpenClawAgentDatabaseByPathAsync(
        store === "selected alias" ? selectedPath : configuredPath,
        "main",
      );
      expect(claimSoleCustody).not.toThrow();
    });
  },
);
