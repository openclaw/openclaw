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

const history = (id: string, content: string) => [
  expect.objectContaining({ id, message: { role: "user", content } }),
];

it.each([false, true])(
  "preserves history through case-variant agent paths (foreign winner: %s)",
  async (foreignWinner) => {
    await withOpenClawTestState({ prefix: "doctor-agent-path-alias-" }, async (state) => {
      // Seed deletion history first; aliases in fresh state correctly block maintenance.
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
      for (const [target, sessionKey, sessionId, updatedAt, eventText] of [
        [canonicalScope, canonicalKey, "older-history", 1, "older history"],
        [source, legacyKey, "kept-history", 2, "kept history"],
      ] as const) {
        insertLegacySession({ ...target, sessionKey, entry: { sessionId, updatedAt }, eventText });
      }
      const winner = { sessionKey: canonicalKey, sessionId: "kept-history" };
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
        expect(await loadTranscriptEvents({ ...aliasScope, ...winner })).toEqual(
          history("kept-history-message", "kept history"),
        );
      }
      const olderArchives = report.archivedTranscriptDirectories.flatMap((directory) =>
        fs
          .readdirSync(directory)
          .filter((name) => name.startsWith("older-history.jsonl.deleted."))
          .map((name) =>
            readSessionArchiveContentSync(path.join(directory, name))
              .trim()
              .split("\n")
              .map((line) => JSON.parse(line)),
          ),
      );
      expect(olderArchives).toEqual([history("older-history-message", "older history")]);
      expect(await repair()).toMatchObject({ foundGroups: 0, repairedGroups: 0 });
    });
  },
);
