import { describe, expect, it } from "vitest";
import {
  loadExactSessionEntryReadOnly,
  loadTranscriptEvents,
  persistSessionTranscriptTurn,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveSessionStoreKey } from "../gateway/session-store-key.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { repairCanonicalSessionKeys } from "./doctor-session-canonical-keys.js";
import { insertLegacySession } from "./doctor-session-canonical-keys.test-support.js";

describe("Doctor stored session addresses", () => {
  it.each(["custom-main", "global"])(
    "preserves literal main rows and lineage beside the %s request destination",
    async (variant) => {
      await withOpenClawTestState({ prefix: "doctor-stored-address-" }, async (state) => {
        const store = state.statePath("agents", "{agentId}", "sessions.json");
        const scope = {
          agentId: "main",
          env: state.env,
          storePath: store.replace("{agentId}", "main"),
        };
        const cfg: OpenClawConfig = {
          agents: { entries: { main: { default: true } } },
          session: variant === "global" ? { scope: "global", store } : { mainKey: "work", store },
        };
        const literal = "agent:main:main";
        const destination = variant === "global" ? "global" : "agent:main:work";
        const child = "agent:main:child";
        for (const sessionKey of [literal, destination, child]) {
          const target = { ...scope, sessionKey, sessionId: `window-${sessionKey}` };
          replaceSessionEntrySync(target, {
            sessionId: target.sessionId,
            updatedAt: 1,
            ...(sessionKey === child
              ? {
                  parentSessionKey: literal,
                  spawnedBy: literal,
                  forkSource: {
                    sessionKey: literal,
                    sessionId: `window-${literal}`,
                    entryId: "parent-entry",
                  },
                }
              : {}),
          });
          await persistSessionTranscriptTurn(target, {
            expectedSessionId: target.sessionId,
            messages: [{ message: { role: "user", content: sessionKey } }],
            updateMode: "none",
          });
        }
        const readRows = () =>
          [literal, destination, child].map((sessionKey) =>
            loadExactSessionEntryReadOnly({ ...scope, sessionKey }),
          );
        const before = readRows();
        expect(resolveSessionStoreKey({ cfg, sessionKey: literal, storeAgentId: "main" })).toBe(
          destination,
        );
        for (const apply of [false, true]) {
          expect(await repairCanonicalSessionKeys({ apply, cfg, env: state.env })).toMatchObject({
            foundGroups: 0,
            removedRows: 0,
            repairedGroups: 0,
          });
          expect(readRows()).toEqual(before);
          for (const sessionKey of [literal, destination, child]) {
            expect(
              await loadTranscriptEvents({
                ...scope,
                sessionKey,
                sessionId: `window-${sessionKey}`,
              }),
            ).toContainEqual(
              expect.objectContaining({
                type: "message",
                message: { role: "user", content: sessionKey },
              }),
            );
          }
        }
      });
    },
  );

  it.each(["main", "work"])(
    "still repairs a removed default agent's legacy %s address into the store owner",
    async (suffix) => {
      await withOpenClawTestState({ prefix: "doctor-legacy-default-owner-" }, async (state) => {
        const store = state.statePath("agents", "{agentId}", "sessions.json");
        const scope = {
          agentId: "ops",
          env: state.env,
          storePath: store.replace("{agentId}", "ops"),
        };
        const cfg: OpenClawConfig = {
          agents: { entries: { ops: { default: true } } },
          session: { mainKey: "work", store },
        };
        const sessionKey = `agent:main:${suffix}`;
        insertLegacySession({
          ...scope,
          sessionKey,
          entry: { sessionId: "legacy-history", updatedAt: 1 },
          eventText: "kept legacy history",
        });
        expect(
          await repairCanonicalSessionKeys({ apply: false, cfg, env: state.env }),
        ).toMatchObject({ foundGroups: 1, repairedGroups: 0 });
        expect(
          await repairCanonicalSessionKeys({ apply: true, cfg, env: state.env }),
        ).toMatchObject({ foundGroups: 1, repairedGroups: 1, removedRows: 1 });
        expect(loadExactSessionEntryReadOnly({ ...scope, sessionKey })).toBeUndefined();
        const repairedScope = { ...scope, sessionKey: "agent:ops:work" };
        expect(loadExactSessionEntryReadOnly(repairedScope)?.entry.sessionId).toBe(
          "legacy-history",
        );
        expect(
          await loadTranscriptEvents({ ...repairedScope, sessionId: "legacy-history" }),
        ).toContainEqual(
          expect.objectContaining({ message: { role: "user", content: "kept legacy history" } }),
        );
        expect(
          await repairCanonicalSessionKeys({ apply: true, cfg, env: state.env }),
        ).toMatchObject({ foundGroups: 0, repairedGroups: 0 });
      });
    },
  );
});
