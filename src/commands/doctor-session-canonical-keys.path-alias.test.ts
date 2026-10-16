import fs from "node:fs";
import { expect, it } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import {
  loadExactSessionEntryReadOnly,
  loadTranscriptEvents,
} from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  insertLegacySession,
  repairCanonicalSessionKeys,
} from "./doctor-session-canonical-keys.test-support.js";

it.each([false, true])(
  "preserves history through case-variant agent paths (foreign winner: %s)",
  async (foreignWinner) => {
    await withOpenClawTestState({ prefix: "doctor-agent-path-alias-" }, async (state) => {
      const upperDirectory = state.statePath("agents", "BA-EA");
      const lowerDirectory = state.statePath("agents", "ba-ea");
      fs.mkdirSync(upperDirectory, { recursive: true });
      // Exercise native case aliases on macOS and the same physical alias on case-sensitive hosts.
      if (!fs.existsSync(lowerDirectory)) {
        fs.symlinkSync(upperDirectory, lowerDirectory, "junction");
      }
      const scope = {
        agentId: "ba-ea",
        env: state.env,
        storePath: state.statePath("agents", "BA-EA", "sessions", "sessions.json"),
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
            storePath: state.statePath("agents", "main", "sessions", "sessions.json"),
          }
        : scope;
      if (foreignWinner) {
        insertLegacySession({
          ...scope,
          sessionKey: canonicalKey,
          entry: { sessionId: "older-history", updatedAt: 1 },
          eventText: "Retain the older destination in its archive.",
        });
      }
      insertLegacySession({
        ...source,
        sessionKey: legacyKey,
        entry: { sessionId: "kept-history", updatedAt: 2 },
        eventText: "Preserve this transcript through Doctor.",
      });
      expect(await repairCanonicalSessionKeys({ apply: true, cfg, env: state.env })).toMatchObject({
        repairedGroups: 1,
        removedRows: 1,
      });
      expect(loadExactSessionEntryReadOnly({ ...scope, sessionKey: legacyKey })).toBeUndefined();
      expect(loadExactSessionEntryReadOnly({ ...source, sessionKey: legacyKey })).toBeUndefined();
      expect(
        loadExactSessionEntryReadOnly({ ...scope, sessionKey: canonicalKey })?.entry.sessionId,
      ).toBe("kept-history");
      expect(
        await loadTranscriptEvents({
          ...scope,
          sessionKey: canonicalKey,
          sessionId: "kept-history",
        }),
      ).toContainEqual(
        expect.objectContaining({
          message: { role: "user", content: "Preserve this transcript through Doctor." },
        }),
      );
      expect(await repairCanonicalSessionKeys({ apply: true, cfg, env: state.env })).toMatchObject({
        foundGroups: 0,
        repairedGroups: 0,
      });
    });
  },
);
