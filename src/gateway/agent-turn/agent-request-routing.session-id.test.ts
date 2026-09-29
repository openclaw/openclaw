import { expect, it, vi } from "vitest";
import * as commandSession from "../../agents/command/session.js";
import { backfillSessionKey } from "../../agents/embedded-agent-runner/run/session-bootstrap.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import * as sessionAccessor from "../../config/sessions/session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "../../config/sessions/session-sqlite-target.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import * as nodeSqlite from "../../infra/node-sqlite.js";
import { unregisterOpenClawAgentDatabase } from "../../state/openclaw-agent-db-registry.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  inspectOpenClawAgentDatabaseOwner,
  isOpenClawAgentDatabaseOpen,
} from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { prepareAgentRequestRouting } from "./agent-request-routing.js";

it.each(
  ["Gateway", "embedded"].flatMap((caller) =>
    ["global", "unknown"].map((sessionKey) => ({ caller, sessionKey })),
  ),
)(
  "does not repeat cold $sessionKey inspection outside the existing listing in $caller",
  async ({ caller, sessionKey }) => {
    await withOpenClawTestState({ label: "session-id-cold-inspection" }, async (state) => {
      const storePath = state.statePath("sessions.json");
      const cfg: OpenClawConfig = {
        agents: { ownership: "explicit", entries: { main: {}, ops: {} } },
        session: { store: storePath },
      };
      await state.writeConfig(cfg);
      setRuntimeConfigSnapshot(cfg);
      const databasePaths: string[] = [];
      for (const agentId of ["main", "ops"]) {
        await sessionAccessor.replaceSessionEntry(
          { agentId, storePath, sessionKey },
          { sessionId: `${agentId}-session`, updatedAt: 1 },
        );
        const target = resolveSqliteTargetFromSessionStorePath(storePath, { agentId });
        databasePaths.push(target.path);
        await closeOpenClawAgentDatabaseByPathAsync(target.path);
        unregisterOpenClawAgentDatabase({ agentId, path: target.path });
        expect(isOpenClawAgentDatabaseOpen(target.path)).toBe(false);
      }

      let lookupDepth = 0;
      let listingDepth = 0;
      const opens: Array<"listing" | "extra"> = [];
      const inLookup = <T>(run: () => T): T => {
        lookupDepth++;
        try {
          return run();
        } finally {
          lookupDepth--;
        }
      };
      const openDatabase = nodeSqlite.openNodeSqliteDatabase;
      const listEntries = sessionAccessor.listSessionEntriesReadOnly;
      const resolveExisting = commandSession.resolveExistingSessionKeyForRequest;
      const resolveCore = commandSession.resolveSessionKeyForRequestCore;
      vi.spyOn(nodeSqlite, "openNodeSqliteDatabase").mockImplementation((...args) => {
        if (lookupDepth > 0) {
          opens.push(listingDepth > 0 ? "listing" : "extra");
        }
        return openDatabase(...args);
      });
      vi.spyOn(sessionAccessor, "listSessionEntriesReadOnly").mockImplementation((...args) => {
        listingDepth++;
        try {
          return listEntries(...args);
        } finally {
          listingDepth--;
        }
      });
      vi.spyOn(commandSession, "resolveExistingSessionKeyForRequest").mockImplementation((args) =>
        inLookup(() => resolveExisting(args)),
      );
      vi.spyOn(commandSession, "resolveSessionKeyForRequestCore").mockImplementation((args) =>
        inLookup(() => resolveCore(args)),
      );
      try {
        // Calibrate the observer on the same cold inspection added by the regression.
        const coldPath = databasePaths[0];
        if (!coldPath) {
          throw new Error("Expected a cold database in the lookup fixture");
        }
        inLookup(() => inspectOpenClawAgentDatabaseOwner(coldPath));
        expect(opens).toContain("extra");
        opens.length = 0;

        if (caller === "Gateway") {
          const respond = vi.fn();
          const routing = await prepareAgentRequestRouting({
            cfg,
            request: { message: "resume", sessionId: "ops-session", idempotencyKey: "lookup" },
            runId: "lookup",
            context: createDirectChatContext({ getRuntimeConfig: () => cfg }),
            respond,
            isRawModelRun: false,
            agentDedupeKeys: ["agent:lookup"],
            reserveDedupe: vi.fn(),
            bindDedupeSessionTarget: vi.fn(),
            clearDedupe: vi.fn(),
          });
          expect(respond).not.toHaveBeenCalled();
          expect(routing).toMatchObject({ agentId: "ops", requestedSessionKey: sessionKey });
        } else {
          expect(backfillSessionKey({ config: cfg, sessionId: "ops-session" })).toBe(sessionKey);
        }
        // The legacy listing still reads on the host; only the added inspection is removed.
        expect(opens).toContain("listing");
        expect(opens.filter((phase) => phase === "extra")).toEqual([]);
      } finally {
        vi.restoreAllMocks();
        clearRuntimeConfigSnapshot();
      }
    });
  },
);
