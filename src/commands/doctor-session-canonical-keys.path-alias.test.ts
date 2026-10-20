import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { readSessionArchiveContentSync } from "../config/sessions/archive-compression.js";
import {
  loadExactSessionEntryReadOnly,
  loadTranscriptEvents,
} from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  insertLegacySession,
  repairCanonicalSessionKeys,
} from "./doctor-session-canonical-keys.test-support.js";

function expectHistory(events: unknown, id: string, content: string) {
  expect(events).toEqual([expect.objectContaining({ id, message: { role: "user", content } })]);
}

it.each([false, true])(
  "preserves history through case-variant agent paths (foreign winner: %s)",
  async (foreignWinner) => {
    await withOpenClawTestState({ prefix: "doctor-agent-path-alias-" }, async (state) => {
      // Existing installs have a deletion journal before aliases appear. A symlink in fresh
      // state correctly prevents inferring empty deletion history and blocks maintenance.
      openOpenClawStateDatabase({ env: state.env });
      const agentPath = (id: string, ...parts: string[]) => state.statePath("agents", id, ...parts);
      const upperDirectory = agentPath("BA-EA");
      const lowerDirectory = agentPath("ba-ea");
      fs.mkdirSync(upperDirectory, { recursive: true });
      // Exercise native case aliases on macOS and the same physical alias on case-sensitive hosts.
      if (!fs.existsSync(lowerDirectory)) {
        fs.symlinkSync(upperDirectory, lowerDirectory, "junction");
      }
      const scopeFor = (directory: string, agentId = "ba-ea") => ({
        agentId,
        env: state.env,
        storePath: agentPath(directory, "sessions", "sessions.json"),
      });
      const scope = scopeFor("BA-EA");
      const canonicalScope = scopeFor("ba-ea");
      const cfg: OpenClawConfig = {
        agents: { entries: { "ba-ea": {}, ...(foreignWinner ? { main: {} } : {}) } },
      };
      setRuntimeConfigSnapshot(cfg);
      const legacyKey = "agent:BA-EA:telegram:direct:123";
      const canonicalKey = "agent:ba-ea:telegram:direct:123";
      const source = foreignWinner ? scopeFor("main", "main") : scope;
      insertLegacySession({
        ...canonicalScope,
        sessionKey: canonicalKey,
        entry: { sessionId: "older-history", updatedAt: 1 },
        eventText: "older history",
      });
      insertLegacySession({
        ...source,
        sessionKey: legacyKey,
        entry: { sessionId: "kept-history", updatedAt: 2 },
        eventText: "kept history",
      });
      const repair = () => repairCanonicalSessionKeys({ apply: true, cfg, env: state.env });
      const load = (alias: typeof scope, sessionKey: string) =>
        loadExactSessionEntryReadOnly({ ...alias, sessionKey });
      const report = await repair();
      expect(report).toMatchObject({ repairedGroups: 1, removedRows: 1 });
      for (const alias of [scope, canonicalScope, source]) {
        expect(load(alias, legacyKey)).toBeUndefined();
      }
      for (const aliasScope of [scope, canonicalScope]) {
        expect(load(aliasScope, canonicalKey)?.entry.sessionId).toBe("kept-history");
        expectHistory(
          await loadTranscriptEvents({
            ...aliasScope,
            sessionKey: canonicalKey,
            sessionId: "kept-history",
          }),
          "kept-history-message",
          "kept history",
        );
      }
      const olderArchives = report.archivedTranscriptDirectories.flatMap((directory) =>
        fs
          .readdirSync(directory)
          .filter((name) => name.startsWith("older-history.jsonl.deleted."))
          .map((name) => readSessionArchiveContentSync(path.join(directory, name))),
      );
      expect(olderArchives).toHaveLength(1);
      expectHistory(
        olderArchives[0]!
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line)),
        "older-history-message",
        "older history",
      );
      expect(await repair()).toMatchObject({ foundGroups: 0, repairedGroups: 0 });
    });
  },
);
