/** Real tool → Gateway handler → resident session rows; no provider or turn execution. */
import assert from "node:assert/strict";
import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, test, vi } from "vitest";
import type { AgentToolGatewayRequestCaller } from "../agents/tools/in-process-gateway.js";
import { createSessionsListTool } from "../agents/tools/sessions-list-tool.js";
import * as sessionAccessor from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { observeSessionRowBackfill } from "./session-row-backfill.test-support.js";
import { bindSessionRowProjection } from "./session-row-projection-access.js";
import { createSessionRowProjection } from "./session-row-projection.js";
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

// The larger lane is opt-in so the normal regression stays bounded.
const inventorySizes =
  process.env.OPENCLAW_SESSION_INVENTORY_PERF === "1" ? [3_474, 34_740] : [3_474];

test.each(inventorySizes)(
  "lists 37 sparse matches from %i stored rows through the real tool and Gateway handler",
  async (rowCount) => {
    const { storePath } = await createSessionStoreDir();
    testState.agentsConfig = { entries: { main: {} } };
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
    const backfilled = observeSessionRowBackfill(expectedKeys);
    const projection = await createSessionRowProjection({ cfg });
    await projection.ensureMaterialized();
    for (const key of expectedKeys) {
      projection.describe({ agentId: "main", key });
    }
    await backfilled;
    await projection.ensureMaterialized();
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    const callGateway: AgentToolGatewayRequestCaller = async <T>(
      request: Parameters<AgentToolGatewayRequestCaller>[0],
    ) => {
      assert(isRecord(request.params), "Expected structured Gateway request params");
      requests.push({ method: request.method, params: request.params });
      const response = await directSessionReq<T>(request.method, request.params, {
        context: { getRuntimeConfig: () => cfg, ...bindSessionRowProjection({}, () => projection) },
      });
      assert(response.ok, response.error?.message ?? "Gateway inventory request failed");
      return expectDefined(response.payload, "Gateway inventory payload");
    };
    const tool = createSessionsListTool({
      config: cfg,
      agentSessionKey: "agent:main:main",
      requesterProfileId: selected.id,
      callGateway,
    });
    const fullLookup = vi.spyOn(sessionAccessor, "listSessionEntriesCore");
    const transcripts = [
      vi.spyOn(sessionAccessor, "readSessionTranscriptWatermark"),
      vi.spyOn(sessionAccessor, "readSessionTranscriptMessageEventPage"),
      vi.spyOn(sessionAccessor, "loadTranscriptEvents"),
    ];
    const spies = [fullLookup, ...transcripts];
    const sampleCount = process.env.OPENCLAW_SESSION_INVENTORY_PERF === "1" ? 20 : 2;
    const phases = [
      "first",
      ...Array.from({ length: sampleCount }, (_, index) => "warm-" + (index + 1)),
    ];
    try {
      // The warmed Gateway serves this inventory from its resident metadata.
      for (const phase of phases) {
        requests.length = 0;
        for (const spy of spies) {
          spy.mockClear();
        }
        const result = await tool.execute(`inventory-${phase}`, {
          relationship: "owned",
          projectId: SELECTED_PROJECT,
          workspaceDir: SELECTED_WORKSPACE,
          group: SELECTED_GROUP,
        });
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
        assert(
          isRecord(details) && Array.isArray(details.sessions),
          "Expected sessions_list details with sessions",
        );
        const returnedKeys = details.sessions.map((row: unknown) => {
          assert(isRecord(row), "Expected inventory row");
          expect(row).toMatchObject({
            owner: { actor: { id: selected.id } },
            group: SELECTED_GROUP,
          });
          for (const field of ["messages", "derivedTitle", "lastMessagePreview"]) {
            expect(row).not.toHaveProperty(field);
          }
          return row.key;
        });
        expect(returnedKeys).toEqual(expectedKeys);
        for (const spy of spies) {
          expect(spy).not.toHaveBeenCalled();
        }
      }
    } finally {
      projection.dispose();
      for (const spy of spies) {
        spy.mockRestore();
      }
    }
  },
);
