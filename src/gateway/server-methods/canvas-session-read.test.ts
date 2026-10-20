import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createCanvasDocument } from "../../canvas/documents.js";
import { createShowWidgetTool } from "../../canvas/widget-tool.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import {
  resolveDefaultSessionStorePath,
  resolveSessionArtifactDirectory,
} from "../../config/sessions/paths.js";
import {
  appendTranscriptEvent,
  appendTranscriptMessage,
  forkSessionFromParentTranscript,
  patchSessionEntryCore,
  resetSessionEntryLifecycle,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import {
  resolveSqliteScope,
  toDatabaseOptions,
} from "../../config/sessions/session-accessor.sqlite-scope.js";
import { runSessionColdStorageMaintenance } from "../../config/sessions/session-cold-storage.js";
import { waitForSessionTranscriptIndexReconcile } from "../../config/sessions/session-transcript-reconcile.js";
import { withSessionHistoryWorkerDatabase } from "../../config/sessions/session-transcript-worker-runtime.js";
import { claimAgentRunContext, releaseAgentRunContext } from "../../infra/agent-run-registry.js";
import { createNestedToolActivity } from "../../sessions/nested-tool-activity.js";
import { prepareUserProfileCatalog } from "../../state/user-profile-list.js";
import { ensureUserProfilesSchema } from "../../state/user-profiles-schema.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { extractChatToolResultCanvasPreview } from "../chat-display-projection.canvas.js";
import { handleGatewayRequest } from "../server-methods.js";
import { roleClient, rolePolicyConfig } from "../session-sharing.test-utils.js";
import { readSessionMessageByIdAsync } from "../session-transcript-readers.js";
import { createHistoryReadContext } from "./chat-history.test-helpers.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./types.js";

async function view(
  context: GatewayRequestContext,
  client: GatewayClient,
  params: Record<string, unknown>,
) {
  const respond = vi.fn<RespondFn>();
  await handleGatewayRequest({
    req: { type: "req", id: "widget-read", method: "canvas.document.view", params },
    respond,
    client,
    isWebchatConnect: () => true,
    context,
  });
  expect(respond).toHaveBeenCalledOnce();
  return expectDefined(respond.mock.calls[0], "widget response");
}

it("reads retained widget receipts and waits only for current live presentations", async () => {
  await withOpenClawTestState(
    { scenario: "minimal", prepareProfileCatalog: true },
    async (state) => {
      const cfg = rolePolicyConfig();
      await state.writeConfig(cfg);
      setRuntimeConfigSnapshot(cfg);
      ensureUserProfilesSchema({});
      using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
      const owner = roleClient("write", "widget-owner");
      const guest = roleClient("view", "widget-reader");
      guest.connect.scopes = ["operator.sessions.read"];
      const scope = {
        agentId: "main",
        sessionKey: "agent:main:widget-parent",
        sessionId: "widget-parent",
        storePath: resolveDefaultSessionStorePath("main"),
      };
      const entry = {
        sessionId: scope.sessionId,
        updatedAt: 1,
        visibility: "shared" as const,
        createdActor: {
          type: "human" as const,
          source: "profile" as const,
          id: owner.authenticatedUserProfile!.profileId,
        },
      };
      await upsertSessionEntryCore(scope, entry);
      // Existing producer/receipt shape: no new manifest field or regenerated widget is needed.
      const tool = createShowWidgetTool({
        sessionId: scope.sessionId,
        agentId: "main",
      });
      const result = await tool.execute("saved-widget-call", {
        title: "Saved preview",
        widget_code: "<p>Saved before guest viewing</p>",
      });
      const docId = expectDefined(
        asOptionalRecord(asOptionalRecord(result.details)?.view)?.id,
        "widget ID",
      );
      const messageId = "saved-widget-result";
      await appendTranscriptMessage(scope, {
        eventId: messageId,
        message: {
          role: "toolResult",
          toolName: "show_widget",
          toolCallId: "saved-widget-call",
          ...result,
          timestamp: 1,
        },
      });
      await appendTranscriptMessage(scope, {
        eventId: "saved-reply",
        message: { role: "assistant", content: "The preview is ready.", timestamp: 2 },
      });
      const context = await createHistoryReadContext({
        getRuntimeConfig: () => cfg,
        getMcpAppSandboxPort: () => 18790,
      });
      context.resolveGatewayContext = () => context;
      await expect(readSessionMessageByIdAsync(scope, messageId)).resolves.toMatchObject({
        found: true,
      });
      const bound = { docId, sessionKey: scope.sessionKey };
      const first = await view(context, guest, bound);
      expect(first[0]).toBe(true);
      expect(first[1]).toMatchObject({
        html: expect.stringContaining("Saved before guest viewing"),
        sandboxUrl: expect.stringMatching(/^\/mcp-app-sandbox\?csp=/),
      });
      const forked = await forkSessionFromParentTranscript({
        agentId: "main",
        parentEntry: entry,
        parentSessionKey: scope.sessionKey,
        sessionKey: "agent:main:widget-child",
        storePath: scope.storePath,
      });
      expect(forked.status).toBe("created");
      if (forked.status !== "created") {
        throw new Error("Missing fork");
      }
      await upsertSessionEntryCore(
        {
          agentId: scope.agentId,
          storePath: scope.storePath,
          sessionKey: "agent:main:widget-child",
        },
        { ...entry, sessionId: forked.transcript.sessionId },
      );
      await expect(
        readSessionMessageByIdAsync(
          {
            ...scope,
            sessionKey: "agent:main:widget-child",
            sessionId: forked.transcript.sessionId,
          },
          messageId,
        ),
      ).resolves.toMatchObject({ found: true });
      const inherited = await view(context, guest, {
        ...bound,
        sessionKey: "agent:main:widget-child",
      });
      expect(inherited[0]).toBe(true);
      expect(inherited[1]).toEqual(first[1]);

      const abandoned = await tool.execute("abandoned-widget-call", {
        title: "Abandoned preview",
        widget_code: "<p>Abandoned branch</p>",
      });
      const abandonedId = expectDefined(
        asOptionalRecord(asOptionalRecord(abandoned.details)?.view)?.id,
        "abandoned widget ID",
      );
      await appendTranscriptMessage(scope, {
        eventId: "abandoned-widget-result",
        message: {
          role: "toolResult",
          toolName: "show_widget",
          toolCallId: "abandoned-widget-call",
          ...abandoned,
          timestamp: 3,
        },
      });
      expect((await view(context, guest, { ...bound, docId: abandonedId }))[0]).toBe(true);
      await appendTranscriptEvent(scope, {
        type: "leaf",
        id: "select-saved-branch",
        parentId: "abandoned-widget-result",
        targetId: "saved-reply",
        timestamp: new Date().toISOString(),
      });
      const database = toDatabaseOptions(resolveSqliteScope(scope));
      await waitForSessionTranscriptIndexReconcile(database);
      expect((await view(context, guest, { ...bound, docId: abandonedId }))[2]).toMatchObject({
        code: "FORBIDDEN",
      });

      await resetSessionEntryLifecycle({
        agentId: scope.agentId,
        storePath: scope.storePath,
        target: { canonicalKey: scope.sessionKey, storeKeys: [scope.sessionKey] },
        resetBoundary: { context: "clear", reason: "reset", cwd: state.root },
        buildNextEntry: ({ currentEntry }) => ({
          ...expectDefined(currentEntry, "reset session"),
          lifecycleRevision: "after-widget-reset",
          updatedAt: Date.now(),
          sessionStartedAt: Date.now(),
        }),
      });
      await waitForSessionTranscriptIndexReconcile(database);
      expect((await view(context, guest, bound))[1]).toEqual(first[1]);

      // Exercise native age selection and archival without rewriting stored timestamps.
      const future = Date.now() + 31 * 24 * 60 * 60 * 1000;
      const clock = vi.spyOn(Date, "now").mockReturnValue(future);
      try {
        const archived = await runSessionColdStorageMaintenance({
          config: {
            ...cfg,
            session: {
              ...cfg.session,
              store: scope.storePath,
              maintenance: { coldStorage: { enabled: true, afterDays: 30 } },
            },
          },
        });
        expect(archived.archivedTranscripts).toBeGreaterThan(0);
      } finally {
        clock.mockRestore();
      }
      await withSessionHistoryWorkerDatabase(database, async (reader) => {
        const readCold = () =>
          reader.readColdMetadata({ sessionId: scope.sessionId, env: state.env });
        expect((await readCold()).archive).toBeDefined();
        expect((await view(context, guest, bound))[1]).toEqual(first[1]);
        expect((await readCold()).archive).toBeUndefined();
      });

      const unbound = await createCanvasDocument(
        { html: "<p>Unbound document</p>", cspSandbox: "scripts" },
        { stateDir: state.stateDir },
      );
      const other = {
        ...scope,
        sessionKey: "agent:main:private-widget",
        sessionId: "private-widget",
      };
      await upsertSessionEntryCore(other, {
        ...entry,
        sessionId: other.sessionId,
        visibility: "draft",
      });
      await appendTranscriptMessage(other, {
        eventId: messageId,
        message: {
          role: "toolResult",
          toolName: "show_widget",
          toolCallId: "private-call",
          details: {
            kind: "canvas",
            view: { id: unbound.id },
            presentation: { target: "assistant_message" },
          },
          content: [],
          timestamp: 1,
        },
      });
      await appendTranscriptMessage(scope, {
        eventId: "untrusted-reference",
        message: {
          role: "user",
          content: JSON.stringify({ kind: "canvas", view: { id: unbound.id } }),
          timestamp: 3,
        },
      });
      for (const params of [
        { docId },
        { ...bound, docId: unbound.id },
        { ...bound, sessionKey: "agent:main:missing" },
        { ...bound, docId: unbound.id, sessionKey: other.sessionKey },
      ]) {
        expect((await view(context, guest, params))[2]).toMatchObject({ code: "FORBIDDEN" });
      }
      const unrelatedPresentation = {
        kind: "canvas",
        view: { id: unbound.id },
        presentation: { target: "assistant_message" },
      };
      for (const [index, invalid] of [
        { toolName: "show_widget", content: JSON.stringify(unrelatedPresentation) },
        { toolName: "show_widget", details: unrelatedPresentation, isError: true },
        { toolName: "read", details: unrelatedPresentation },
        {
          toolName: "show_widget",
          details: { ...unrelatedPresentation, presentation: { target: "node_panel" } },
        },
      ].entries()) {
        await appendTranscriptMessage(scope, {
          eventId: `invalid-widget-${index}`,
          message: { role: "toolResult", content: [], timestamp: 4 + index, ...invalid },
        });
        expect((await view(context, guest, { ...bound, docId: unbound.id }))[2]).toMatchObject({
          code: "FORBIDDEN",
        });
      }
      const nestedActivity = (toolResult: unknown) =>
        createNestedToolActivity({
          runId: "widget-nested-run",
          scopeId: "widget-nested-scope",
          afterEntryId: null,
          startOrder: 0,
          toolCallId: "nested-widget-call",
          toolName: "show_widget",
          input: {},
          result: toolResult,
          isError: false,
          startedAt: 8,
          timestamp: 9,
        });
      const invalidNested = nestedActivity({ content: [], details: unrelatedPresentation });
      for (const [index, message] of [
        { ...invalidNested, customType: "unrelated" },
        { ...invalidNested, details: { ...invalidNested.details, isError: true } },
        { ...invalidNested, details: { ...invalidNested.details, toolName: "read" } },
      ].entries()) {
        await appendTranscriptMessage(scope, { eventId: `invalid-nested-${index}`, message });
        expect((await view(context, guest, { ...bound, docId: unbound.id }))[2]).toMatchObject({
          code: "FORBIDDEN",
        });
      }
      expect((await view(context, owner, { docId }))[0]).toBe(true);
      expect((await view(context, owner, { docId: unbound.id }))[0]).toBe(true);

      const liveResult = await tool.execute("live-widget-call", {
        title: "Live preview",
        widget_code: "<p>Committed live widget</p>",
      });
      const livePreview = expectDefined(
        extractChatToolResultCanvasPreview(liveResult),
        "live widget",
      );
      const liveRequest = { ...bound, docId: livePreview.preview.viewId };
      const runId = "widget-live-run";
      const clientRunId = "widget-live-client";
      const claim = expectDefined(
        claimAgentRunContext(
          runId,
          {
            agentId: scope.agentId,
            sessionId: scope.sessionId,
            sessionKey: scope.sessionKey,
          },
          { trackOwner: true, exclusive: true },
        ),
        "live widget run claim",
      );
      context.chatRunState.registry.add(runId, { sessionKey: scope.sessionKey, clientRunId });
      const live = context.chatRunState.getOrCreate(clientRunId);
      live.canvasBlocks = [{ type: "canvas", ...livePreview }];
      live.bufferIsCurrent = () => true;
      try {
        expect((await view(context, guest, liveRequest))[2]).toMatchObject({
          code: "UNAVAILABLE",
          retryable: true,
          details: { type: "canvas_widget_pending" },
        });
        live.bufferIsCurrent = () => false;
        expect((await view(context, guest, liveRequest))[2]).toMatchObject({ code: "FORBIDDEN" });
        live.bufferIsCurrent = () => true;
        releaseAgentRunContext(runId, claim);
        expect((await view(context, guest, liveRequest))[2]).toMatchObject({ code: "FORBIDDEN" });
        await appendTranscriptMessage(scope, {
          eventId: "live-widget-result",
          // Code Mode and tool-search persist this existing canonical receipt format.
          message: nestedActivity(liveResult),
        });
        expect((await view(context, guest, liveRequest))[1]).toMatchObject({
          html: expect.stringContaining("Committed live widget"),
        });
      } finally {
        releaseAgentRunContext(runId, claim);
        context.chatRunState.registry.remove(runId, clientRunId, scope.sessionKey);
        context.chatRunState.clearRun(clientRunId);
      }

      const legacyScope = {
        ...scope,
        sessionKey: "agent:main:legacy-widget",
        sessionId: "legacy-widget",
      };
      await upsertSessionEntryCore(legacyScope, { ...entry, sessionId: legacyScope.sessionId });
      const legacyResult = await createShowWidgetTool({
        sessionId: legacyScope.sessionId,
        agentId: scope.agentId,
      }).execute("legacy-widget-call", {
        title: "Retained widget",
        widget_code: "<p>Retained reset archive widget</p>",
      });
      const legacyId = expectDefined(
        asOptionalRecord(asOptionalRecord(legacyResult.details)?.view)?.id,
        "legacy widget ID",
      );
      const archives = resolveSessionArtifactDirectory(legacyScope.storePath);
      await fs.mkdir(archives, { recursive: true });
      await fs.writeFile(
        path.join(archives, `${legacyScope.sessionId}.jsonl.reset.2026-09-30T00-00-00.000Z`),
        [
          { type: "session", version: 3, id: legacyScope.sessionId },
          {
            type: "message",
            id: "legacy-result",
            parentId: null,
            message: {
              role: "toolResult",
              toolName: "show_widget",
              toolCallId: "legacy-widget-call",
              ...legacyResult,
              timestamp: 1,
            },
          },
          {
            type: "message",
            id: "legacy-reply",
            parentId: "legacy-result",
            message: {
              role: "assistant",
              content: "The retained widget is ready.",
              timestamp: 2,
            },
          },
          ...Array.from({ length: 150 }, (_value, index) => ({
            type: "message",
            id: `legacy-user-${index}`,
            parentId: index === 0 ? "legacy-reply" : `legacy-user-${index - 1}`,
            message: { role: "user", content: `Later message ${index}`, timestamp: index + 3 },
          })),
        ]
          .map((record) => JSON.stringify(record))
          .join("\n") + "\n",
      );
      const historyResponse = vi.fn<RespondFn>();
      await handleGatewayRequest({
        req: {
          type: "req",
          id: "legacy-history",
          method: "chat.history",
          params: { sessionKey: legacyScope.sessionKey, limit: 200 },
        },
        respond: historyResponse,
        client: guest,
        isWebchatConnect: () => true,
        context,
      });
      expect(historyResponse.mock.calls[0]?.[0]).toBe(true);
      expect(historyResponse.mock.calls[0]?.[1]).toMatchObject({
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: "assistant",
            content: expect.arrayContaining([
              expect.objectContaining({
                type: "canvas",
                preview: expect.objectContaining({ viewId: legacyId }),
              }),
            ]),
          }),
        ]),
      });
      const legacyRequest = { docId: legacyId, sessionKey: legacyScope.sessionKey };
      expect((await view(context, guest, legacyRequest))[1]).toMatchObject({
        html: expect.stringContaining("Retained reset archive widget"),
      });
      // Ordinary history stops selecting this archive once native displayed history exists.
      await appendTranscriptMessage(legacyScope, {
        eventId: "native-reply",
        message: { role: "user", content: "New native history", timestamp: 3 },
      });
      expect((await readSessionMessageByIdAsync(legacyScope, "native-reply")).found).toBe(true);
      expect((await view(context, guest, legacyRequest))[2]).toMatchObject({ code: "FORBIDDEN" });

      const provisioning = createDeferred();
      const sandbox = createDeferred<number>();
      context.getMcpAppSandboxPort = () => undefined;
      context.ensureSandboxHostPort = () => {
        provisioning.resolve();
        return sandbox.promise;
      };
      const pending = view(context, guest, bound);
      await provisioning.promise;
      await patchSessionEntryCore(scope, () => ({ visibility: "draft" }));
      sandbox.resolve(18790);
      const revoked = await pending;
      expect(revoked[0]).toBe(false);
      expect(revoked[1]).toBeUndefined();
      expect(revoked[2]).toMatchObject({
        code: "FORBIDDEN",
        message: expect.stringContaining("access"),
      });
      expect((await view(context, guest, bound))[0]).toBe(false);
    },
  );
});
