import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { getRuntimeConfig } from "../../config/config.js";
import {
  loadSessionEntryReadOnly,
  patchSessionEntryCore,
  persistSessionTranscriptTurn,
  replaceSessionEntrySync,
  resetSessionEntryLifecycle,
} from "../../config/sessions/session-accessor.js";
import * as sessionEntryReads from "../../config/sessions/session-entry-read-runtime.js";
import * as sessionCostUsage from "../../infra/session-cost-usage.js";
import type { SessionsUsageResult } from "../../shared/usage-types.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { coreGatewayHandlers } from "./core-handlers.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

it.for(["session reset", "incognito transition", "revocation during target read"] as const)(
  "does not expose revoked usage context after %s",
  async (change, { signal, onTestFinished }) => {
    const state = await createOpenClawTestState({ label: "usage-context-lifecycle" });
    const release = createDeferred();
    const targetReadStarted = createDeferred();
    const summaryLoaded =
      createDeferred<
        Awaited<ReturnType<typeof sessionCostUsage.loadSessionCostSummariesFromCache>>
      >();
    let request: Promise<unknown> | undefined;
    let restoreSummaryLoader: (() => void) | undefined;
    let restoreTargetReader: (() => void) | undefined;
    let cleanupPromise: Promise<void> | undefined;
    const releaseSummary = () => release.resolve();
    const cleanup = () =>
      (cleanupPromise ??= (async () => {
        releaseSummary();
        await Promise.allSettled(request ? [request] : []);
        try {
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
                sessions: { others: "none" },
                agents: "*",
                scopes: ["operator.read", "operator.write"],
              },
            },
          },
        },
      });
      const config = getRuntimeConfig();
      const viewer = ensureProfileForEmail("usage-viewer@example.com");
      const client: GatewayClient = {
        connect: {
          minProtocol: 1,
          maxProtocol: 1,
          client: {
            id: "openclaw-control-ui",
            version: "test",
            platform: "test",
            mode: "webchat",
          },
          role: "operator",
          scopes: ["operator.read", "operator.write"],
        },
        authenticatedUserProfile: {
          profileId: viewer.id,
          displayName: null,
          hasAvatar: false,
          updatedAt: 1,
        },
      };
      const sessionId = "usage-before-change";
      const scope = {
        agentId: "main",
        sessionKey: "agent:main:usage-context",
        storePath: path.join(state.sessionsDir(), "sessions.json"),
      };
      const timestamp = Date.now();
      const originalReport = {
        source: "run" as const,
        generatedAt: timestamp,
        systemPrompt: { chars: 100, projectContextChars: 40, nonProjectContextChars: 60 },
        injectedWorkspaceFiles: [],
        skills: { promptChars: 0, entries: [] },
        tools: { listChars: 0, schemaChars: 0, entries: [] },
      };
      const changedReport = { ...originalReport, generatedAt: timestamp + 1 };
      replaceSessionEntrySync(scope, {
        sessionId,
        updatedAt: timestamp,
        createdActor: { type: "human", source: "profile", id: viewer.id },
        visibility: "shared",
        systemPromptReport: originalReport,
      });
      await persistSessionTranscriptTurn(
        { ...scope, sessionId },
        {
          cwd: state.workspaceDir,
          updateMode: "none",
          messages: [
            {
              message: { role: "user", content: "Synthetic usage", timestamp },
              now: timestamp,
            },
          ],
        },
      );
      await sessionCostUsage.loadCostUsageSummary({
        config,
        agentId: scope.agentId,
        startMs: 0,
        endMs: timestamp + 1,
      });

      const actualLoad = sessionCostUsage.loadSessionCostSummariesFromCache;
      const summaryLoader = vi
        .spyOn(sessionCostUsage, "loadSessionCostSummariesFromCache")
        .mockImplementation(async (params) => {
          const result = await actualLoad(params);
          summaryLoaded.resolve(result);
          await release.promise;
          return result;
        });
      restoreSummaryLoader = () => summaryLoader.mockRestore();
      if (change === "revocation during target read") {
        const actualRead = sessionEntryReads.withSessionEntryReadOnlyInWorker;
        const reader = vi
          .spyOn(sessionEntryReads, "withSessionEntryReadOnlyInWorker")
          .mockImplementationOnce(async (input, assertCurrent, consume) => {
            targetReadStarted.resolve();
            await release.promise;
            return actualRead(input, assertCurrent, consume);
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
            limit: 1,
            includeContextWeight: true,
            ...(change === "revocation during target read" ? { key: scope.sessionKey } : {}),
          },
          respond,
          client,
          isWebchatConnect: () => false,
          context: { getRuntimeConfig: () => config } as GatewayRequestContext,
        }),
      );
      const loaded = await Promise.race([
        change === "revocation during target read"
          ? targetReadStarted.promise
          : summaryLoaded.promise,
        request.then(() => {
          throw new Error("Usage request returned before the read hold");
        }),
      ]);
      if (loaded) {
        expect(loaded.cacheStatus.status).toBe("fresh");
        expect(loaded.summaries).toHaveLength(1);
      }
      expect(respond).not.toHaveBeenCalled();
      signal.throwIfAborted();

      if (change === "session reset") {
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
        sessionId: change === "session reset" ? "usage-after-reset" : sessionId,
        systemPromptReport: changedReport,
        ...(change === "session reset" ? {} : { incognito: true }),
      });

      releaseSummary();
      await request;
      expect(respond).toHaveBeenCalledOnce();
      if (change === "revocation during target read") {
        expect(summaryLoader).not.toHaveBeenCalled();
        expect(respond.mock.calls[0]).toEqual([
          false,
          undefined,
          { code: "INVALID_REQUEST", message: `Invalid session reference: ${scope.sessionKey}` },
        ]);
        return;
      }
      const [ok, payload] = expectDefined(respond.mock.calls[0], "usage response");
      expect(ok).toBe(true);
      const result = payload as SessionsUsageResult;
      expect(result.sessions).toHaveLength(1);
      expect(result.sessions[0]).toMatchObject({
        key: scope.sessionKey,
        sessionId,
        hasContextWeight: false,
        contextWeight: null,
      });
    } finally {
      await cleanup();
    }
  },
);
