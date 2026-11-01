import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { captureRuntimeConfigAsyncReader } from "../../config/config.js";
import {
  patchSessionEntryCore,
  persistSessionTranscriptTurn,
  replaceSessionEntrySync,
  resetSessionEntryLifecycle,
} from "../../config/sessions/session-accessor.js";
import { promptReport } from "../../config/sessions/system-prompt-report.test-support.js";
import * as sessionCostUsage from "../../infra/session-cost-usage.js";
import { WorkerTaskPool } from "../../infra/worker-task-pool.js";
import type { SessionsUsageResult } from "../../shared/usage-types.js";
import { prepareUserProfileCatalog } from "../../state/user-profile-list.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { invalidateOperatorRolePolicy } from "../operator-role-policy.js";
import { gatewayConnect, gatewayProfile } from "../server/client-fixtures.test-support.js";
import { bindSessionRowProjection } from "../session-row-projection-access.js";
import {
  createSessionRowProjection,
  type SessionRowProjection,
} from "../session-row-projection.js";
import { coreGatewayHandlers } from "./core-handlers.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";
import * as usageOverviewReport from "./usage-overview-report.js";
import * as usageSessionSelection from "./usage-session-selection.js";

it.for([
  "session reset",
  "incognito transition",
  "revocation after context read",
  "page backfill after revocation",
] as const)(
  "does not expose revoked usage context after %s",
  async (change, { signal, onTestFinished }) => {
    const reset = change === "session reset";
    const revoke = change === "revocation after context read";
    const backfill = change === "page backfill after revocation";
    const afterContext = revoke || backfill;
    const state = await createOpenClawTestState({
      label: "usage-context-lifecycle",
      prepareProfileCatalog: true,
    });
    const release = createDeferred();
    const targetReadStarted = createDeferred();
    const summaryLoaded = createDeferred();
    let request: Promise<unknown> | undefined;
    let projection: SessionRowProjection | undefined;
    let restoreSummaryLoader: (() => void) | undefined;
    let restoreTargetReader: (() => void) | undefined;
    let cleanupPromise: Promise<void> | undefined;
    let releaseProfileCatalog: (() => void) | undefined;
    const releaseSummary = () => release.resolve();
    const cleanup = () =>
      (cleanupPromise ??= (async () => {
        releaseSummary();
        await Promise.allSettled(request ? [request] : []);
        try {
          projection?.dispose();
          releaseProfileCatalog?.();
          await state.cleanup();
        } finally {
          restoreSummaryLoader?.();
          restoreTargetReader?.();
          signal.removeEventListener("abort", releaseSummary);
        }
      })());
    onTestFinished(cleanup);
    signal.addEventListener("abort", releaseSummary, { once: true });
    if (signal.aborted) {
      releaseSummary();
    }

    try {
      signal.throwIfAborted();
      await state.writeConfig({
        agents: { ownership: "explicit", entries: { main: {} } },
        plugins: { enabled: false },
        gateway: {
          roles: {
            default: "guest",
            definitions: {
              guest: {
                sessions: { others: revoke ? "view" : "none" },
                agents: "*",
                scopes: ["operator.read", "operator.write"],
              },
            },
          },
        },
      });
      const config = await captureRuntimeConfigAsyncReader()();
      const viewer = ensureProfileForEmail("usage-viewer@example.com");
      releaseProfileCatalog = (await prepareUserProfileCatalog()).release;
      const client: GatewayClient = {
        connect: gatewayConnect(["operator.read", "operator.write"]),
        authenticatedUserProfile: gatewayProfile(viewer.id),
      };
      const sessionId = "usage-before-change";
      const scope = {
        agentId: "main",
        sessionKey: "agent:main:usage-context",
        storePath: path.join(state.sessionsDir(), "sessions.json"),
      };
      const timestamp = Date.now();
      const originalReport = {
        ...promptReport(timestamp, 100, 0),
        systemPrompt: { chars: 100, projectContextChars: 40, nonProjectContextChars: 60 },
      };
      const changedReport = { ...originalReport, generatedAt: timestamp + 1 };
      const siblingReport = { ...originalReport, generatedAt: timestamp + 2 };
      replaceSessionEntrySync(scope, {
        sessionId,
        updatedAt: timestamp,
        createdActor: { type: "human", source: "profile", id: viewer.id },
        visibility: "shared",
        systemPromptReport: originalReport,
      });
      const sibling = {
        ...scope,
        sessionKey: "agent:main:usage-unaffected",
        sessionId: "usage-unaffected",
      };
      replaceSessionEntrySync(sibling, {
        sessionId: sibling.sessionId,
        updatedAt: timestamp - 1,
        createdActor: { type: "human", source: "profile", id: viewer.id },
        visibility: "shared",
        ...(backfill ? { systemPromptReport: siblingReport } : {}),
      });
      for (const [target, tokens] of [
        [{ ...scope, sessionId }, 17],
        [sibling, 23],
      ] as const) {
        await persistSessionTranscriptTurn(target, {
          cwd: state.workspaceDir,
          updateMode: "none",
          messages: [
            {
              message: {
                role: "assistant",
                content: "Synthetic usage",
                timestamp,
                provider: "synthetic",
                model: "synthetic",
                usage: { input: tokens, output: 0, totalTokens: tokens, cost: { total: 0 } },
              },
              now: timestamp,
            },
          ],
        });
      }
      await sessionCostUsage.loadCostUsageSummary({
        config,
        agentId: scope.agentId,
        startMs: 0,
        endMs: timestamp + 1,
      });

      projection = await createSessionRowProjection({ cfg: config, getConfig: () => config });
      const actualLoad = sessionCostUsage.loadSessionCostSummariesFromCache;
      const summaryLoader = vi
        .spyOn(sessionCostUsage, "loadSessionCostSummariesFromCache")
        .mockImplementation(async (params) => {
          const result = await actualLoad(params);
          summaryLoaded.resolve();
          if (!afterContext) {
            await release.promise;
          }
          return result;
        });
      restoreSummaryLoader = () => summaryLoader.mockRestore();
      if (afterContext) {
        const actualRead = usageSessionSelection.loadUsageSessionContext;
        const reader = vi
          .spyOn(usageSessionSelection, "loadUsageSessionContext")
          .mockImplementation(async (...args) => {
            await actualRead(...args);
            targetReadStarted.resolve();
            await release.promise;
          });
        restoreTargetReader = () => reader.mockRestore();
      }
      const respond = vi.fn();
      request = Promise.resolve(
        expectDefined(
          coreGatewayHandlers["sessions.usage"],
          "registered usage handler",
        )({
          req: { type: "req", id: "context-lifecycle", method: "sessions.usage" },
          params: {
            agentId: "main",
            range: "all",
            limit: backfill ? 1 : 2,
            includeContextWeight: true,
          },
          respond,
          client,
          isWebchatConnect: () => false,
          context: bindSessionRowProjection(
            { getRuntimeConfig: () => config } as GatewayRequestContext,
            () => projection,
          ),
        }),
      );
      await Promise.race([
        afterContext ? targetReadStarted.promise : summaryLoaded.promise,
        request.then(() => {
          throw new Error("Usage request returned before the read hold");
        }),
      ]);
      expect(respond).not.toHaveBeenCalled();
      signal.throwIfAborted();

      if (reset) {
        await resetSessionEntryLifecycle({
          agentId: scope.agentId,
          storePath: scope.storePath,
          target: { canonicalKey: scope.sessionKey, storeKeys: [scope.sessionKey] },
          buildNextEntry: ({ currentEntry }) => ({
            ...expectDefined(currentEntry, "selected entry before reset"),
            sessionId: "usage-after-reset",
            updatedAt: timestamp + 1,
            systemPromptReport: changedReport,
          }),
        });
      } else {
        await patchSessionEntryCore(scope, () => ({
          incognito: true,
          systemPromptReport: changedReport,
        }));
      }
      if (revoke) {
        invalidateOperatorRolePolicy(viewer.id);
      }
      const sql = revoke ? observeHostDataSql() : undefined;
      try {
        releaseSummary();
        await request;
        if (sql) {
          expect(sql.queries).toEqual([]);
        }
      } finally {
        sql?.restore();
      }
      expect(respond).toHaveBeenCalledOnce();
      const [ok, payload] = expectDefined(respond.mock.calls[0], "usage response");
      expect(ok).toBe(true);
      const result = payload as SessionsUsageResult;
      expect(result.sessions.map((row) => row.key)).toEqual(
        reset ? [scope.sessionKey, sibling.sessionKey] : [sibling.sessionKey],
      );
      expect(result.totals.totalTokens).toBe(reset ? 40 : 23);
      expect(
        result.sessions.find((row) => row.key === sibling.sessionKey)?.usage?.totalTokens,
      ).toBe(23);
      if (reset) {
        expect(result.sessions[0]).toMatchObject({
          key: scope.sessionKey,
          sessionId,
          hasContextWeight: false,
          contextWeight: null,
        });
      }
      if (backfill) {
        expect(result.sessions).toMatchObject([
          { key: sibling.sessionKey, hasContextWeight: true, contextWeight: siblingReport },
        ]);
      }
    } finally {
      await cleanup();
    }
  },
);

it.for([
  { revoke: false, offset: 0 },
  { revoke: true, offset: 0 },
  { revoke: true, offset: 10 },
] as const)(
  "publishes overview accounting only for sessions visible after aggregation (revoke=$revoke, offset=$offset)",
  async ({ revoke, offset }, { onTestFinished }) => {
    const state = await createOpenClawTestState({
      label: "usage-overview-revocation",
      prepareProfileCatalog: true,
    });
    const aggregated = createDeferred();
    const release = createDeferred();
    // Created after the cleanup hook is registered.
    const owned: { projection?: SessionRowProjection; releaseProfileCatalog?: () => void } = {};
    const workerRun = vi.spyOn(WorkerTaskPool.prototype, "run");
    const dispatches = () =>
      workerRun.mock.calls.flatMap(([task]) =>
        isRecord(task) &&
        (task.kind === "prepare" || task.kind === "cohorts" || task.kind === "report") &&
        isRecord(task.input) &&
        Array.isArray(task.input.rows)
          ? [task.kind]
          : [],
      );
    const actualReporter = usageOverviewReport.createUsageOverviewReporter;
    // Hold every worker report after it completes, so access can change before publication.
    const reporter = vi
      .spyOn(usageOverviewReport, "createUsageOverviewReporter")
      .mockImplementation((params) => {
        const created = actualReporter(params);
        return (
          created && {
            ...created,
            async run(rows) {
              const slice = await created.run(rows);
              aggregated.resolve();
              await release.promise;
              return slice;
            },
          }
        );
      });
    onTestFinished(async () => {
      release.resolve();
      reporter.mockRestore();
      workerRun.mockRestore();
      owned.projection?.dispose();
      owned.releaseProfileCatalog?.();
      await state.cleanup();
    });
    await state.writeConfig({
      agents: { ownership: "explicit", entries: { main: {} } },
      plugins: { enabled: false },
      gateway: {
        roles: {
          default: "guest",
          definitions: {
            guest: {
              sessions: { others: "view" },
              agents: "*",
              scopes: ["operator.read", "operator.write"],
            },
          },
        },
      },
    });
    const config = await captureRuntimeConfigAsyncReader()();
    const viewer = ensureProfileForEmail("usage-overview-viewer@example.com");
    owned.releaseProfileCatalog = (await prepareUserProfileCatalog()).release;
    const client: GatewayClient = {
      connect: gatewayConnect(["operator.read", "operator.write"]),
      authenticatedUserProfile: gatewayProfile(viewer.id),
    };
    const storePath = path.join(state.sessionsDir(), "sessions.json");
    const timestamp = Date.now();
    const sessions = [
      { sessionKey: "agent:main:usage-revoked", sessionId: "usage-revoked", tokens: 17 },
      { sessionKey: "agent:main:usage-kept", sessionId: "usage-kept", tokens: 23 },
    ];
    for (const [index, { sessionKey, sessionId, tokens }] of sessions.entries()) {
      const scope = { agentId: "main", sessionKey, sessionId, storePath };
      replaceSessionEntrySync(scope, {
        sessionId,
        updatedAt: timestamp - index,
        createdActor: { type: "human", source: "profile", id: viewer.id },
        visibility: "shared",
        ...(index === 0 ? { systemPromptReport: promptReport(timestamp, 100, 0) } : {}),
      });
      await persistSessionTranscriptTurn(scope, {
        cwd: state.workspaceDir,
        updateMode: "none",
        messages: [
          {
            message: {
              role: "assistant",
              content: "Synthetic usage",
              timestamp,
              provider: "synthetic",
              model: "synthetic",
              usage: { input: tokens, output: 0, totalTokens: tokens, cost: { total: 0 } },
            },
            now: timestamp,
          },
        ],
      });
    }
    await sessionCostUsage.loadCostUsageSummary({
      config,
      agentId: "main",
      startMs: 0,
      endMs: timestamp + 1,
    });
    owned.projection = await createSessionRowProjection({ cfg: config, getConfig: () => config });
    const context = bindSessionRowProjection(
      { getRuntimeConfig: () => config } as GatewayRequestContext,
      () => owned.projection,
    );
    const respond = vi.fn();
    const request = Promise.resolve(
      expectDefined(
        coreGatewayHandlers["sessions.usage"],
        "registered usage handler",
      )({
        req: { type: "req", id: "overview-revocation", method: "sessions.usage" },
        params: {
          agentId: "main",
          range: "all",
          projection: "overview",
          query: "model:synthetic",
          includeContextWeight: false,
          offset,
        },
        respond,
        client,
        isWebchatConnect: () => false,
        context,
      }),
    );
    await Promise.race([
      aggregated.promise,
      request.then(() => {
        throw new Error("Usage request returned before the report hold");
      }),
    ]);
    if (revoke) {
      await patchSessionEntryCore(
        { agentId: "main", sessionKey: sessions[0]!.sessionKey, storePath },
        () => ({ incognito: true }),
      );
      invalidateOperatorRolePolicy(viewer.id);
    }
    release.resolve();
    await request;
    expect(respond).toHaveBeenCalledOnce();
    const [ok, payload] = expectDefined(respond.mock.calls[0], "usage response");
    expect(ok).toBe(true);
    const result = payload as SessionsUsageResult;
    const visible = revoke ? sessions.slice(1) : sessions;
    expect(result.totals.totalTokens).toBe(visible.reduce((sum, { tokens }) => sum + tokens, 0));
    expect(result.aggregates.sessionCount).toBe(visible.length);
    expect(result.overview).toMatchObject({
      total: visible.length,
      unfilteredSessionCount: visible.length,
    });
    expect(result.sessions.map((row) => row.key)).toEqual(
      offset === 0 ? visible.map(({ sessionKey }) => sessionKey) : [],
    );
    if (!revoke) {
      // Hydrating saved context changes metadata, not this model-only aggregation.
      expect(dispatches()).toEqual(["prepare", "cohorts"]);
      expect(result.sessions[0]).toMatchObject({
        sessionId: sessions[0]!.sessionId,
        hasContextWeight: true,
      });
      expect(result.sessions[0]!.contextWeight).toBeUndefined();

      const read = async (query: string, includeContextWeight = false) => {
        workerRun.mockClear();
        const reply = vi.fn();
        await coreGatewayHandlers["sessions.usage"]!({
          req: { type: "req", id: query, method: "sessions.usage" },
          params: {
            agentId: "main",
            range: "all",
            projection: "overview",
            query,
            includeContextWeight,
          },
          respond: reply,
          client,
          isWebchatConnect: () => false,
          context,
        });
        expect(reply).toHaveBeenCalledOnce();
        const [success, response] = reply.mock.calls[0]!;
        expect(success).toBe(true);
        return response as SessionsUsageResult;
      };
      const contextOnly = await read("has:context");
      expect(dispatches()).toEqual(["prepare", "report"]);
      expect(contextOnly.totals.totalTokens).toBe(17);
      expect(contextOnly.sessions.map((row) => row.sessionId)).toEqual([sessions[0]!.sessionId]);
      const withContext = await read("model:synthetic", true);
      expect(dispatches()).toEqual(["prepare", "cohorts"]);
      expect(withContext.totals.totalTokens).toBe(40);
      expect(withContext.sessions[0]!.contextWeight).toEqual(promptReport(timestamp, 100, 0));
    }
  },
);
