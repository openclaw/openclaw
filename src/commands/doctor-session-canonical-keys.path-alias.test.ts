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
      const scope = {
        agentId: "ba-ea",
        env: state.env,
        storePath: agentPath("BA-EA", "sessions", "sessions.json"),
      };
      const canonicalScope = {
        ...scope,
        storePath: agentPath("ba-ea", "sessions", "sessions.json"),
      };
      const cfg: OpenClawConfig = {
        agents: { entries: { "ba-ea": {}, ...(foreignWinner ? { main: {} } : {}) } },
      };
      setRuntimeConfigSnapshot(cfg);
      const legacyKey = "agent:BA-EA:telegram:direct:123";
      const canonicalKey = "agent:ba-ea:telegram:direct:123";
      const source = foreignWinner
        ? {
            ...scope,
            agentId: "main",
            storePath: agentPath("main", "sessions", "sessions.json"),
          }
        : scope;
      insertLegacySession({
        ...canonicalScope,
        sessionKey: canonicalKey,
        entry: { sessionId: "older-history", updatedAt: 1 },
        eventText: "Retain the older destination in its archive.",
      });
      insertLegacySession({
        ...source,
        sessionKey: legacyKey,
        entry: { sessionId: "kept-history", updatedAt: 2 },
        eventText: "Preserve this transcript through Doctor.",
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
        expect(
          await loadTranscriptEvents({
            ...aliasScope,
            sessionKey: canonicalKey,
            sessionId: "kept-history",
          }),
        ).toEqual([
          expect.objectContaining({
            id: "kept-history-message",
            message: { role: "user", content: "Preserve this transcript through Doctor." },
          }),
        ]);
      }
      const olderArchives = report.archivedTranscriptDirectories.flatMap((directory) =>
        fs
          .readdirSync(directory)
          .filter((name) => name.startsWith("older-history.jsonl.deleted."))
          .map((name) => readSessionArchiveContentSync(path.join(directory, name))),
      );
      expect(olderArchives).toHaveLength(1);
      expect(
        olderArchives[0]!
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line)),
      ).toEqual([
        expect.objectContaining({
          id: "older-history-message",
          message: { role: "user", content: "Retain the older destination in its archive." },
        }),
      ]);
      expect(await repair()).toMatchObject({ foundGroups: 0, repairedGroups: 0 });
    });
  },
);
