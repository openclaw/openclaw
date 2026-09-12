import { performance } from "node:perf_hooks";
import { isMainThread, threadId } from "node:worker_threads";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import {
  areDiagnosticsEnabledForProcess,
  setDiagnosticsEnabledForProcess,
} from "../../infra/diagnostic-events.js";
import {
  createDiagnosticTraceContext,
  getActiveDiagnosticTraceContext,
  runWithDiagnosticTraceContext,
  type DiagnosticTraceContext,
} from "../../infra/diagnostic-trace-context.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import * as titleReader from "../session-transcript-title-reader.js";
import {
  identifiedClient,
  listSessions,
  requestContext,
  seedSessions,
} from "./sessions-read-cache.test-support.js";
import { sessionLog } from "./sessions-shared.js";

const scheduler = vi.hoisted(() => ({ onYield: undefined as (() => Promise<void>) | undefined }));
vi.mock("node:timers/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:timers/promises")>();
  return {
    ...actual,
    setImmediate: async (...args: Parameters<typeof actual.setImmediate>) => {
      const result = await actual.setImmediate(...args);
      await scheduler.onYield?.();
      return result;
    },
  };
});

let previousDiagnostics: boolean;
let clock: number;
let records: Array<{ trace: DiagnosticTraceContext | undefined; fields: Record<string, unknown> }>;
beforeEach(() => {
  previousDiagnostics = areDiagnosticsEnabledForProcess();
  setDiagnosticsEnabledForProcess(true);
  clock = 0;
  records = [];
  vi.spyOn(sessionLog, "isEnabled").mockReturnValue(true);
  vi.spyOn(sessionLog, "warn").mockImplementation((message, fields) => {
    if (message === "slow session list") {
      records.push({ trace: getActiveDiagnosticTraceContext(), fields: fields ?? {} });
    }
  });
});
afterEach(() => {
  scheduler.onYield = undefined;
  setDiagnosticsEnabledForProcess(previousDiagnostics);
  vi.restoreAllMocks();
});

function controlProjectionClock() {
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  const read = titleReader.readSessionTitleFieldsFromTranscriptBatch;
  return vi
    .spyOn(titleReader, "readSessionTitleFieldsFromTranscriptBatch")
    .mockImplementation((...args) => {
      const result = read(...args);
      // Advance only the synchronous preparation interval; the real yield remains in production.
      clock += 20;
      return result;
    });
}

test("separates producer work, follower wait, and completed hits under their own request traces", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const config = await seedSessions();
    const context = requestContext(config);
    const client = identifiedClient("owner@example.com");
    const request = { agentId: "main", limit: 1 };
    const catalog = vi.fn(async () => undefined);
    context.readPreparedGatewayModelCatalog = catalog;
    const projection = controlProjectionClock();
    const entered = createDeferredCore();
    const release = createDeferredCore();
    scheduler.onYield = async () => {
      entered.resolve();
      await release.promise;
    };
    const ownerTrace = createDiagnosticTraceContext();
    const followerTrace = createDiagnosticTraceContext();
    const owner = runWithDiagnosticTraceContext(ownerTrace, () =>
      listSessions({ client, context, request }),
    );
    await entered.promise;
    const follower = runWithDiagnosticTraceContext(followerTrace, () =>
      listSessions({ client, context, request }),
    );
    await vi.waitFor(() => expect(catalog).toHaveBeenCalledTimes(2));
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    clock += 1_500;
    release.resolve();
    const [owned, followed] = await Promise.all([owner, follower]);
    expect(followed).toBe(owned);
    expect(projection).toHaveBeenCalledOnce();
    expect(records).toHaveLength(2);
    const ownerRecord = records.find((record) => record.trace?.traceId === ownerTrace.traceId);
    const followerRecord = records.find(
      (record) => record.trace?.traceId === followerTrace.traceId,
    );
    expect(ownerRecord).toMatchObject({
      trace: ownerTrace,
      fields: {
        cacheRole: "projection-owner",
        pid: process.pid,
        threadId,
        isMainThread,
        prepareSyncMs: 20,
        rowSyncMs: 0,
        yieldWaitMs: 1_500,
        yieldCount: 1,
        projectionPasses: 1,
        selectedRowCount: 1,
      },
    });
    expect(followerRecord).toMatchObject({
      trace: followerTrace,
      fields: {
        cacheRole: "in-flight-follower",
        selectedRowCount: 1,
        workTraceId: ownerTrace.traceId,
        workSpanId: ownerTrace.spanId,
      },
    });
    expect(followerRecord?.fields).not.toHaveProperty("prepareSyncMs");
    expect(followerRecord?.fields).not.toHaveProperty("yieldWaitMs");
    expect(followerRecord?.fields).not.toHaveProperty("projectionPasses");

    scheduler.onYield = undefined;
    catalog.mockImplementation(async () => {
      clock += 1_100;
      return undefined;
    });
    const hitTrace = createDiagnosticTraceContext();
    const hit = await runWithDiagnosticTraceContext(hitTrace, () =>
      listSessions({ client, context, request }),
    );
    expect(hit).toBe(owned);
    expect(projection).toHaveBeenCalledOnce();
    expect(records).toHaveLength(3);
    expect(records[2]).toMatchObject({
      trace: hitTrace,
      fields: { cacheRole: "completed-hit", selectedRowCount: 1 },
    });
    expect(records[2]?.fields).not.toHaveProperty("projectionPasses");
    expect(records[2]?.fields).not.toHaveProperty("workTraceId");
    expect(records[2]?.fields).not.toHaveProperty("rowSyncMs");
  });
});

test("accumulates the bounded visibility repairs without counting yielded waits as synchronous work", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const config = { agents: { list: [{ id: "main", default: true }] } };
    const newest = Date.now();
    const updatedAt = vi.spyOn(Date, "now");
    for (const [index, name] of ["first", "second", "third", "fourth"].entries()) {
      updatedAt.mockReturnValue(newest - index);
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: `agent:main:repair-${name}` },
        {
          sessionId: `repair-${name}`,
          updatedAt: newest - index,
          visibility: "shared",
          createdActor: { type: "human", source: "profile", id: "owner@example.com" },
        },
      );
    }
    updatedAt.mockRestore();
    controlProjectionClock();
    let pass = 0;
    scheduler.onYield = async () => {
      const name = ["first", "second", "third"][pass++];
      if (name) {
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey: `agent:main:repair-${name}` },
          { visibility: "draft" },
        );
      }
      clock += 500;
    };
    const result = await listSessions({
      client: identifiedClient("viewer@example.com"),
      context: requestContext(config),
      request: { agentId: "main", limit: 1 },
    });
    expect(result.sessions.map((row) => row.key)).toEqual(["agent:main:repair-fourth"]);
    expect(records).toHaveLength(1);
    expect(records[0]?.fields).toMatchObject({
      cacheRole: "projection-owner",
      projectionPasses: 4,
      rowRepairCount: 2,
      fullReloadCount: 1,
      prepareSyncMs: 80,
      rowSyncMs: 0,
      yieldWaitMs: 2_000,
      yieldCount: 4,
      phaseDurationsMs: { rows: 2_080 },
    });
  });
});

test.each(["disabled", "sink-disabled", "sink-throws", "disabled-during-request"])(
  "preserves the response when diagnostics are %s",
  async (mode) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const context = requestContext(await seedSessions());
      if (mode === "disabled") {
        setDiagnosticsEnabledForProcess(false);
      }
      if (mode === "sink-disabled") {
        vi.mocked(sessionLog.isEnabled).mockReturnValue(false);
      }
      if (mode === "sink-throws") {
        vi.mocked(sessionLog.warn).mockImplementation(() => {
          throw new Error("synthetic sink failure");
        });
      }
      vi.spyOn(performance, "now").mockImplementation(() => clock);
      context.readPreparedGatewayModelCatalog = async () => {
        clock += 1_100;
        if (mode === "disabled-during-request") {
          setDiagnosticsEnabledForProcess(false);
        }
        return undefined;
      };
      const result = await listSessions({
        client: identifiedClient("owner@example.com"),
        context,
        request: { agentId: "main", limit: 1 },
      });
      expect(result.sessions).toHaveLength(1);
      if (mode === "sink-throws") {
        expect(sessionLog.warn).toHaveBeenCalledOnce();
      } else {
        expect(sessionLog.warn).not.toHaveBeenCalled();
      }
    });
  },
);

test("preserves the original projection error even when its slow diagnostic sink throws", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const context = requestContext(await seedSessions());
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    const failure = new Error("synthetic projection failure");
    vi.spyOn(titleReader, "readSessionTitleFieldsFromTranscriptBatch").mockImplementation(() => {
      clock += 1_500;
      throw failure;
    });
    vi.mocked(sessionLog.warn).mockImplementation(() => {
      throw new Error("synthetic sink failure");
    });
    await expect(
      listSessions({
        client: identifiedClient("owner@example.com"),
        context,
        request: { agentId: "main" },
      }),
    ).rejects.toBe(failure);
    expect(sessionLog.warn).toHaveBeenCalledOnce();
  });
});
