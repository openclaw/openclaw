import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { captureRuntimeConfigAsyncReader } from "../../config/config.js";
import {
  loadSessionEntryReadOnly,
  patchSessionEntryCore,
  replaceSessionEntrySync,
  resetSessionEntryLifecycle,
} from "../../config/sessions/session-accessor.js";
import * as sessionCostUsage from "../../infra/session-cost-usage.js";
import type { SessionsUsageResult } from "../../shared/usage-types.js";
import { prepareUserProfileCatalog } from "../../state/user-profile-list.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { invalidateOperatorRolePolicy } from "../operator-role-policy.js";
import { bindSessionRowProjection } from "../session-row-projection-access.js";
import {
  createSessionRowProjection,
  type SessionRowProjection,
} from "../session-row-projection.js";
import { coreGatewayHandlers } from "./core-handlers.js";
import * as usageSessionSelection from "./usage-session-selection.js";
import {
  contextReport,
  invokeUsage,
  usageClient,
  usageReply,
  usageRoleConfig,
  writeUsage,
} from "./usage.test-support.js";

it.for([
  "session reset",
  "incognito transition",
  "revocation after context read",
  "page backfill after revocation",
] as const)(
  "does not expose revoked usage context after %s",
  async (change, { signal, onTestFinished }) => {
    const reset = change === "session reset";
    const revocation = change === "revocation after context read";
    const pageBackfill = change === "page backfill after revocation";
    const holdContext = revocation || pageBackfill;
    const state = await createOpenClawTestState({
      label: "usage-context-lifecycle",
      prepareProfileCatalog: true,
    });
    const release = createDeferred();
    const targetReadStarted = createDeferred();
    const actualLoad = sessionCostUsage.loadSessionCostSummariesFromCache;
    const summaryLoaded = createDeferred<Awaited<ReturnType<typeof actualLoad>>>();
    let request: Promise<unknown> | undefined;
    let projection: SessionRowProjection | undefined;
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
          vi.restoreAllMocks();
          signal.removeEventListener("abort", releaseSummary);
        }
      })());
    onTestFinished(cleanup);
    signal.addEventListener("abort", releaseSummary, { once: true });

    try {
      signal.throwIfAborted();
      await state.writeConfig(
        usageRoleConfig(
          {
            agents: { ownership: "explicit", entries: { main: {} } },
            plugins: { enabled: false },
          },
          revocation ? "view" : "none",
        ),
      );
      const config = await captureRuntimeConfigAsyncReader()();
      const viewer = ensureProfileForEmail("usage-viewer@example.com");
      releaseProfileCatalog = (await prepareUserProfileCatalog()).release;
      const client = usageClient(viewer.id);
      const sessionId = "usage-before-change";
      const scope = {
        agentId: "main",
        sessionKey: "agent:main:usage-context",
        storePath: path.join(state.sessionsDir(), "sessions.json"),
      };
      const timestamp = Date.now();
      const originalReport = contextReport(timestamp);
      const changedReport = { ...originalReport, generatedAt: timestamp + 1 };
      const siblingReport = { ...originalReport, generatedAt: timestamp + 2 };
      const sibling = {
        ...scope,
        sessionKey: "agent:main:usage-unaffected",
        sessionId: "usage-unaffected",
      };
      for (const [target, tokens, updatedAt, report] of [
        [{ ...scope, sessionId }, 17, timestamp, originalReport],
        [sibling, 23, timestamp - 1, pageBackfill ? siblingReport : undefined],
      ] as const) {
        replaceSessionEntrySync(target, {
          sessionId: target.sessionId,
          updatedAt,
          createdActor: { type: "human", source: "profile", id: viewer.id },
          visibility: "shared",
          ...(report ? { systemPromptReport: report } : {}),
        });
        await writeUsage(target, state.workspaceDir, tokens, timestamp, 0);
      }
      await sessionCostUsage.loadCostUsageSummary({
        config,
        agentId: scope.agentId,
        startMs: 0,
        endMs: timestamp + 1,
      });

      projection = await createSessionRowProjection({ cfg: config, getConfig: () => config });
      vi.spyOn(sessionCostUsage, "loadSessionCostSummariesFromCache").mockImplementation(
        async (params) => {
          const result = await actualLoad(params);
          summaryLoaded.resolve(result);
          if (!holdContext) {
            await release.promise;
          }
          return result;
        },
      );
      if (holdContext) {
        const actualRead = usageSessionSelection.loadUsageSessionContext;
        vi.spyOn(usageSessionSelection, "loadUsageSessionContext").mockImplementation(
          async (...args) => {
            await actualRead(...args);
            targetReadStarted.resolve();
            await release.promise;
          },
        );
      }
      const respond = vi.fn();
      request = invokeUsage(
        "sessions.usage",
        {
          agentId: "main",
          range: "all",
          limit: pageBackfill ? 1 : 2,
          includeContextWeight: true,
        },
        config,
        {
          respond,
          client,
          handlers: coreGatewayHandlers,
          context: bindSessionRowProjection({ getRuntimeConfig: () => config }, () => projection),
        },
      );
      const loaded = await Promise.race([
        holdContext ? targetReadStarted.promise : summaryLoaded.promise,
        request.then(() => {
          throw new Error("Usage request returned before the read hold");
        }),
      ]);
      if (loaded) {
        expect(loaded.cacheStatus.status).toBe("fresh");
        expect(loaded.summaries).toHaveLength(2);
      }
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
      expect(loadSessionEntryReadOnly(scope)).toMatchObject({
        sessionId: reset ? "usage-after-reset" : sessionId,
        systemPromptReport: changedReport,
        ...(reset ? {} : { incognito: true }),
      });

      if (revocation) {
        invalidateOperatorRolePolicy(viewer.id);
      }
      const sql = revocation ? observeHostDataSql() : undefined;
      try {
        releaseSummary();
        await request;
        if (sql) {
          expect(sql.queries).toEqual([]);
        }
      } finally {
        sql?.restore();
      }
      const [ok, payload] = usageReply(respond);
      expect(ok).toBe(true);
      const result = payload as SessionsUsageResult;
      const unaffected = {
        key: sibling.sessionKey,
        usage: { totalTokens: 23 },
        ...(pageBackfill ? { hasContextWeight: true, contextWeight: siblingReport } : {}),
      };
      expect(result).toMatchObject({
        totals: { totalTokens: reset ? 40 : 23 },
        sessions: reset
          ? [
              { key: scope.sessionKey, sessionId, hasContextWeight: false, contextWeight: null },
              unaffected,
            ]
          : [unaffected],
      });
    } finally {
      await cleanup();
    }
  },
);
