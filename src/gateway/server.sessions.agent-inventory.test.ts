/** Real tool → Gateway handler → SQLite listing boundary; no provider or turn execution. */
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { StatementSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, test, vi } from "vitest";
import type { AgentToolGatewayRequestCaller } from "../agents/tools/in-process-gateway.js";
import { createSessionsListTool } from "../agents/tools/sessions-list-tool.js";
import * as sessionAccessor from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { testState, writeSessionStore } from "./test-helpers.js";
import {
  directSessionReq,
  getGatewayConfigModule,
  setupGatewaySessionsHandlerTestHarness,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();
const MATCH_COUNT = 37;
const SELECTED_PROJECT = "inventory-project";
const SELECTED_WORKSPACE = "/synthetic/inventory/task";
const SELECTED_GROUP = "Inventory review";

// The larger lane is opt-in so the normal regression stays bounded. Both report
// actual durations/counters, never assert a host-dependent millisecond threshold.
const inventorySizes =
  process.env.OPENCLAW_SESSION_INVENTORY_PERF === "1" ? [3_474, 34_740] : [3_474];

test.each(inventorySizes)(
  "lists 37 sparse matches from %i stored rows through the real tool and Gateway handler",
  async (rowCount) => {
    const { storePath } = await createSessionStoreDir();
    testState.agentsConfig = { entries: { main: { default: true } } };
    const selected = ensureProfileForEmail("inventory-owner@example.test");
    const other = ensureProfileForEmail("inventory-other@example.test");
    const entries: Record<string, SessionEntry> = {};
    const expectedKeys: string[] = [];
    for (let index = 0; index < rowCount; index++) {
      const matches = index >= rowCount - MATCH_COUNT;
      const key = `agent:main:inventory-${index}`;
      if (matches) {
        expectedKeys.push(key);
      }
      // Every newer decoy misses exactly one selector, so no single predicate
      // can accidentally stand in for the combined inventory query.
      const missing = matches ? -1 : index % 4;
      entries[key] = {
        sessionId: `inventory-${index}`,
        updatedAt: 1_781_000_000_000 - index,
        createdVia: "operator",
        createdActor: {
          type: "human",
          source: "profile",
          id: missing === 0 ? other.id : selected.id,
        },
        projectId: missing === 1 ? "other-project" : SELECTED_PROJECT,
        spawnedCwd: missing === 2 ? "/synthetic/other-task" : SELECTED_WORKSPACE,
        category: missing === 3 ? "Other group" : SELECTED_GROUP,
        visibility: "shared",
      };
    }
    await writeSessionStore({ entries, storePath, agentId: "main" });
    const { getRuntimeConfig } = await getGatewayConfigModule();
    const current = getRuntimeConfig();
    const cfg: OpenClawConfig = {
      ...current,
      tools: { ...current.tools, sessions: { ...current.tools?.sessions, visibility: "all" } },
    };
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    const callGateway: AgentToolGatewayRequestCaller = async <T>(
      request: Parameters<AgentToolGatewayRequestCaller>[0],
    ) => {
      if (!isRecord(request.params)) {
        throw new Error("Expected structured Gateway request params");
      }
      requests.push({ method: request.method, params: request.params });
      const response = await directSessionReq<T>(request.method, request.params, {
        context: { getRuntimeConfig: () => cfg },
      });
      if (!response.ok) {
        throw new Error(response.error?.message ?? "Gateway inventory request failed");
      }
      return expectDefined(response.payload, "Gateway inventory payload");
    };
    const tool = createSessionsListTool({
      config: cfg,
      agentSessionKey: "agent:main:main",
      requesterProfileId: selected.id,
      callGateway,
    });
    const sql = {
      all: vi.spyOn(StatementSync.prototype, "all"),
      get: vi.spyOn(StatementSync.prototype, "get"),
      iterate: vi.spyOn(StatementSync.prototype, "iterate"),
      run: vi.spyOn(StatementSync.prototype, "run"),
    };
    const materialization = {
      list: vi.spyOn(sessionAccessor, "listSessionEntriesReadOnly"),
      fullLookup: vi.spyOn(sessionAccessor, "listSessionEntriesCore"),
      exactBatch: vi.spyOn(sessionAccessor, "loadExactSessionEntryCandidatesReadOnlyBatch"),
    };
    const transcripts = [
      vi.spyOn(sessionAccessor, "readSessionTranscriptTitleProbeBatch"),
      vi.spyOn(sessionAccessor, "readSessionTranscriptWatermarkBatch"),
      vi.spyOn(sessionAccessor, "readSessionTranscriptMessageEventPage"),
      vi.spyOn(sessionAccessor, "loadTranscriptEvents"),
    ];
    const eventLoop = monitorEventLoopDelay({ resolution: 10 });
    eventLoop.enable();
    const warmDurations: number[] = [];
    const sampleCount = process.env.OPENCLAW_SESSION_INVENTORY_PERF === "1" ? 20 : 2;
    const phases = [
      "first",
      ...Array.from({ length: sampleCount }, (_, index) => "warm-" + (index + 1)),
    ];
    try {
      // The first read follows fixture seeding, not a fresh process/database open.
      // Warm requests reuse metadata caches, but the harness creates a new Gateway
      // context each time, so measurements exclude completed-response-cache hits.
      for (const phase of phases) {
        requests.length = 0;
        for (const spy of [
          ...Object.values(sql),
          ...Object.values(materialization),
          ...transcripts,
        ]) {
          spy.mockClear();
        }
        const startedAt = performance.now();
        const result = await tool.execute(`inventory-${phase}`, {
          relationship: "owned",
          projectId: SELECTED_PROJECT,
          workspaceDir: SELECTED_WORKSPACE,
          group: SELECTED_GROUP,
        });
        const elapsedMs = performance.now() - startedAt;
        if (phase !== "first") {
          warmDurations.push(elapsedMs);
        }
        const details = result.details;
        expect(requests).toHaveLength(1);
        expect(requests[0]).toMatchObject({
          method: "sessions.list",
          params: {
            profileRelation: { profileId: selected.id, relationship: "owned" },
            projectId: SELECTED_PROJECT,
            workspaceDir: SELECTED_WORKSPACE,
            group: SELECTED_GROUP,
            includeDerivedTitles: false,
            includeLastMessage: false,
          },
        });
        expect(details).toMatchObject({ count: MATCH_COUNT, hasMore: false });
        if (!isRecord(details) || !Array.isArray(details.sessions)) {
          throw new Error("Expected sessions_list details with sessions");
        }
        const returnedKeys = details.sessions.map((row: unknown) => {
          if (!isRecord(row)) {
            throw new Error("Expected inventory row");
          }
          expect(row).toMatchObject({
            owner: { actor: { id: selected.id } },
            group: SELECTED_GROUP,
          });
          expect(row).not.toHaveProperty("messages");
          expect(row).not.toHaveProperty("derivedTitle");
          expect(row).not.toHaveProperty("lastMessagePreview");
          return row.key;
        });
        expect(returnedKeys).toEqual(expectedKeys);
        for (const transcript of transcripts) {
          // Empty batch calls are no-ops; metadata listing must never request transcript rows.
          expect(
            transcript.mock.calls.every(([scopes]) => Array.isArray(scopes) && scopes.length === 0),
          ).toBe(true);
        }
        expect(materialization.fullLookup).not.toHaveBeenCalled();
        console.info(
          "session-inventory-boundary",
          JSON.stringify({
            rows: rowCount,
            matches: MATCH_COUNT,
            phase,
            elapsedMs,
            gatewayRequests: requests.length,
            responseBytes: Buffer.byteLength(JSON.stringify(details, null, 2)),
            rssBytes: process.memoryUsage().rss,
            processPeakRssBytes: process.resourceUsage().maxRSS * 1024,
            sqlCalls: Object.fromEntries(
              Object.entries(sql).map(([name, spy]) => [name, spy.mock.calls.length]),
            ),
            materializationCalls: Object.fromEntries(
              Object.entries(materialization).map(([name, spy]) => [name, spy.mock.calls.length]),
            ),
          }),
        );
      }
      const sorted = warmDurations.toSorted((left, right) => left - right);
      console.info(
        "session-inventory-summary",
        JSON.stringify({
          rows: rowCount,
          samples: sorted.length,
          warmP50Ms: sorted[Math.ceil(sorted.length * 0.5) - 1],
          warmP95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
          eventLoopMaxMs: eventLoop.count > 0 ? eventLoop.max / 1e6 : null,
        }),
      );
    } finally {
      eventLoop.disable();
      for (const spy of [
        ...Object.values(sql),
        ...Object.values(materialization),
        ...transcripts,
      ]) {
        spy.mockRestore();
      }
    }
  },
);
