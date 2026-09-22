import { expect, test, vi } from "vitest";
import { readAcpSessionMetaForEntry } from "../acp/runtime/session-meta-readonly.js";
import * as acpSessionMeta from "../acp/runtime/session-meta-readonly.js";
import {
  readAcpSessionMetaBatch,
  writeAcpSessionMetaForMigration,
} from "../acp/runtime/session-meta.js";
import type { OpenClawConfig } from "../config/config.js";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import { createSessionRowProjection, type SessionRowProjection } from "./session-row-projection.js";
import { listProjectedSessions } from "./session-utils-list.js";
import * as rowProjection from "./session-utils-row.js";
import { writeResidentEntries } from "./session-utils.perf.test-support.js";

test("retains ACP batch bounds while clean lists and inline dirty metadata reuse resident facts", async () => {
  await withStateDirEnv("openclaw-perf-acp-", async () => {
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(createEmptyPluginRegistry());
    const cfg = {
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5" },
          models: { "openai/gpt-5": { agentRuntime: { id: "openclaw" } } },
          thinkingDefault: "off",
        },
      },
    } as OpenClawConfig;
    resetConfigRuntimeState();
    setRuntimeConfigSnapshot(cfg);

    const stateKey = "agent:default:webchat:dm:state";
    const missingKey = "agent:default:webchat:dm:missing";
    const markerKey = "agent:default:webchat:dm:marker";
    const stateEntry: SessionEntry = {
      sessionId: "state-session",
      updatedAt: 3,
      modelProvider: "openai",
      model: "gpt-5",
    };
    const missingEntry: SessionEntry = {
      sessionId: "missing-session",
      updatedAt: 2,
      modelProvider: "openai",
      model: "gpt-5",
    };
    const staleAliasEntry: SessionEntry = {
      sessionId: "stale-alias-session",
      updatedAt: 1,
      modelProvider: "openai",
      model: "gpt-5",
    };
    const markerMeta = {
      backend: "marker",
      agent: "marker-agent",
      runtimeSessionName: markerKey,
      mode: "persistent" as const,
      state: "idle" as const,
      lastActivityAt: 1,
    };
    const markerEntry: SessionEntry = {
      sessionId: "marker-session",
      updatedAt: 1,
      modelProvider: "openai",
      model: "gpt-5",
      acp: markerMeta,
    };
    const stateMeta = {
      backend: "acpx",
      agent: "codex",
      runtimeSessionName: stateKey,
      mode: "persistent" as const,
      state: "idle" as const,
      lastActivityAt: 2,
    };
    writeAcpSessionMetaForMigration({
      sessionKey: stateKey,
      sessionId: stateEntry.sessionId,
      meta: stateMeta,
    });

    const perRowState = readAcpSessionMetaForEntry({ sessionKey: stateKey, entry: stateEntry });
    const perRowMissing = readAcpSessionMetaForEntry({
      sessionKey: missingKey,
      entry: missingEntry,
    });
    expect(
      readAcpSessionMetaBatch({
        entries: [
          { sessionKey: stateKey, entry: stateEntry },
          { sessionKey: stateKey, entry: staleAliasEntry },
          { sessionKey: missingKey, entry: missingEntry },
          { sessionKey: markerKey, entry: markerEntry },
        ],
      }),
    ).toEqual(
      new Map<SessionEntry, ReturnType<typeof readAcpSessionMetaForEntry>>([
        [markerEntry, markerMeta],
        [stateEntry, perRowState],
        [staleAliasEntry, undefined],
        [missingEntry, perRowMissing],
      ]),
    );

    const database = openOpenClawStateDatabase();
    const originalPrepare = database.db.prepare.bind(database.db);
    let acpSelects = 0;
    let projection: SessionRowProjection | undefined;
    const prepareSpy = vi.spyOn(database.db, "prepare").mockImplementation((sql: string) => {
      if (/^select\b.*\bacp_sessions\b/is.test(sql)) {
        acpSelects += 1;
      }
      return originalPrepare(sql);
    });
    try {
      // Composite and legacy identities share the production 500-key chunks.
      // Cross two boundaries without materializing tens of thousands of rows.
      const aboveBatchChunkSize = Array.from({ length: 501 }, (_, index) => ({
        sessionKey: `agent:default:webchat:dm:missing-${index}`,
        entry: {
          sessionId: `missing-session-${index}`,
          updatedAt: index,
        } satisfies SessionEntry,
      }));
      const chunkedBatch = readAcpSessionMetaBatch({ entries: aboveBatchChunkSize });
      expect(chunkedBatch.size).toBe(aboveBatchChunkSize.length);
      expect(chunkedBatch.get(aboveBatchChunkSize[0]!.entry)).toBeUndefined();
      expect(chunkedBatch.get(aboveBatchChunkSize.at(-1)!.entry)).toBeUndefined();
      expect(acpSelects).toBe(3);

      const runtimeEntries = Object.fromEntries(
        aboveBatchChunkSize
          .slice(0, 55)
          .map(({ sessionKey, entry }) => [
            sessionKey.replace("agent:default:", "agent:runtime:"),
            entry,
          ]),
      );
      writeResidentEntries({
        [stateKey]: stateEntry,
        [missingKey]: missingEntry,
        [markerKey]: markerEntry,
        ...runtimeEntries,
      });
      projection = await createSessionRowProjection({ cfg });
      acpSelects = 0;
      const rows = vi.spyOn(rowProjection, "readSessionRowInputs");
      const metadataReads = vi.spyOn(acpSessionMeta, "readAcpSessionMetaForEntry");
      try {
        const result = await listProjectedSessions({
          projection,
          opts: { agentId: "default", limit: 3 },
        });
        expect(result.sessions).toHaveLength(3);
        expect(acpSelects).toBe(0);
        for (const search of ["openclaw", "unmatched-runtime"]) {
          const searched = await listProjectedSessions({
            projection,
            opts: { agentId: "runtime", search, limit: 1 },
          });
          expect(searched.totalCount).toBe(search === "openclaw" ? 55 : 0);
          expect(rows).not.toHaveBeenCalled();
          expect(acpSelects).toBe(0);
        }
        expect(
          projection.snapshot({ agentId: "default", key: missingKey }).row?.runtimeSelectionLocked,
        ).toBe(false);
        writeResidentEntries(
          {
            [missingKey]: {
              ...missingEntry,
              acp: { ...markerMeta, runtimeSessionName: missingKey },
            },
          },
          1,
        );
        acpSelects = 0;
        await projection.ensureMaterialized();
        expect(rows).toHaveBeenCalledOnce();
        expect(rows.mock.calls[0]?.[0].key).toBe(missingKey);
        expect(metadataReads).not.toHaveBeenCalled();
        expect(acpSelects).toBe(0);
        expect(
          projection.snapshot({ agentId: "default", key: missingKey }).row?.runtimeSelectionLocked,
        ).toBe(true);
      } finally {
        metadataReads.mockRestore();
        rows.mockRestore();
      }
    } finally {
      projection?.dispose();
      prepareSpy.mockRestore();
    }
  });
});
