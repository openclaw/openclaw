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
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { prepareUserProfileCatalogForTest } from "../../test-utils/user-profile-catalog.js";
import { extractChatToolResultCanvasPreview } from "../chat-display-projection.canvas.js";
import { handleGatewayRequest } from "../server-methods.js";
import { roleClient, rolePolicyConfig } from "../session-sharing.test-utils.js";
import { createHistoryReadContext } from "./chat-history.test-helpers.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./types.js";

async function request(
  context: GatewayRequestContext,
  client: GatewayClient,
  params: Record<string, unknown>,
  method = "canvas.document.view",
) {
  const respond = vi.fn<RespondFn>();
  await handleGatewayRequest({
    req: { type: "req", id: "widget-read", method, params },
    respond,
    client,
    isWebchatConnect: () => true,
    context,
  });
  expect(respond).toHaveBeenCalledOnce();
  return expectDefined(respond.mock.calls[0], "widget response");
}

type WidgetResult = Awaited<ReturnType<ReturnType<typeof createShowWidgetTool>["execute"]>>;
const widgetId = (result: WidgetResult) =>
  expectDefined(asOptionalRecord(asOptionalRecord(result.details)?.view)?.id, "widget ID");
const receipt = (result: WidgetResult, toolCallId: string, timestamp: number) => ({
  role: "toolResult",
  toolName: "show_widget",
  toolCallId,
  ...result,
  timestamp,
});
const textMessage = (role: "user" | "assistant", content: string, timestamp: number) => ({
  role,
  content,
  timestamp,
});
const containing = (value: Record<string, unknown>) =>
  expect.arrayContaining([expect.objectContaining(value)]);

it("reads retained widget receipts and waits only for current live presentations", async () => {
  await withOpenClawTestState(
    { scenario: "minimal", prepareProfileCatalog: true },
    async (state) => {
      const cfg = rolePolicyConfig();
      await state.writeConfig(cfg);
      setRuntimeConfigSnapshot(cfg);
      using _ = { [Symbol.dispose]: (await prepareUserProfileCatalogForTest()).release };
      const owner = roleClient("write", "widget-owner");
      const guest = roleClient("view", "widget-reader");
      guest.connect.scopes = ["operator.sessions.read"];
      const scope = {
        agentId: "main",
        sessionKey: "agent:main:widget-parent",
        sessionId: "widget-parent",
        storePath: resolveDefaultSessionStorePath("main"),
      };
      const sessionScope = (sessionId: string, sessionKey = `agent:main:${sessionId}`) => ({
        ...scope,
        sessionKey,
        sessionId,
      });
      const append = (eventId: string, message: unknown, target = scope) =>
        appendTranscriptMessage(target, { eventId, message });
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
      const makeTool = (sessionId: string) => createShowWidgetTool({ sessionId, agentId: "main" });
      const tool = makeTool(scope.sessionId);
      const show = (name: string, html: string, source = tool) =>
        source.execute(`${name}-widget-call`, { title: name, widget_code: `<p>${html}</p>` });
      const result = await show("saved", "Saved before guest viewing");
      const docId = widgetId(result);
      const messageId = "saved-widget-result";
      await append(messageId, receipt(result, "saved-widget-call", 1));
      await append("saved-reply", textMessage("assistant", "The preview is ready.", 2));
      const context = await createHistoryReadContext({
        getRuntimeConfig: () => cfg,
        getMcpAppSandboxPort: () => 18790,
      });
      context.resolveGatewayContext = () => context;
      const view = (params: Record<string, unknown>, client = guest) =>
        request(context, client, params);
      const forbidden = async (params: Record<string, unknown>) =>
        expect((await view(params))[2]).toMatchObject({ code: "FORBIDDEN" });
      const expectHtml = async (params: Record<string, unknown>, text: string) =>
        expect((await view(params))[1]).toMatchObject({ html: expect.stringContaining(text) });
      const bound = { docId, sessionKey: scope.sessionKey };
      const first = await view(bound);
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
      if (forked.status !== "created") {
        throw new Error("Missing fork");
      }
      const child = sessionScope(forked.transcript.sessionId, "agent:main:widget-child");
      await upsertSessionEntryCore(child, { ...entry, sessionId: child.sessionId });
      const inherited = await view({ ...bound, sessionKey: child.sessionKey });
      expect(inherited).toEqual([true, first[1]]);

      const abandoned = await show("abandoned", "Abandoned branch");
      const abandonedId = widgetId(abandoned);
      await append("abandoned-widget-result", receipt(abandoned, "abandoned-widget-call", 3));
      expect((await view({ ...bound, docId: abandonedId }))[0]).toBe(true);
      await appendTranscriptEvent(scope, {
        type: "leaf",
        id: "select-saved-branch",
        parentId: "abandoned-widget-result",
        targetId: "saved-reply",
        timestamp: new Date().toISOString(),
      });
      const database = toDatabaseOptions(resolveSqliteScope(scope));
      await waitForSessionTranscriptIndexReconcile(database);
      await forbidden({ ...bound, docId: abandonedId });

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
      expect((await view(bound))[1]).toEqual(first[1]);

      // Use the maintenance owner's age selection, not rewritten stored timestamps.
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
        const coldArchive = expectDefined((await readCold()).archive, "cold archive");
        expect((await view(bound))[1]).toEqual(first[1]);
        expect((await readCold()).archive).toEqual(coldArchive);
      });

      const unbound = await createCanvasDocument({
        html: "<p>Unbound document</p>",
        cspSandbox: "scripts",
      });
      const other = sessionScope("private-widget");
      await upsertSessionEntryCore(other, {
        ...entry,
        sessionId: other.sessionId,
        visibility: "draft",
      });
      const unrelatedPresentation = {
        kind: "canvas",
        view: { id: unbound.id },
        presentation: { target: "assistant_message" },
      };
      const widgetReceipt = (extra: Record<string, unknown>) => ({
        role: "toolResult",
        toolName: "show_widget",
        content: [],
        timestamp: 1,
        ...extra,
      });
      await append(
        messageId,
        widgetReceipt({
          toolCallId: "private-call",
          details: unrelatedPresentation,
        }),
        other,
      );
      await append(
        "untrusted-reference",
        textMessage("user", JSON.stringify({ kind: "canvas", view: { id: unbound.id } }), 3),
      );
      for (const params of [
        { docId },
        { ...bound, docId: unbound.id },
        { ...bound, sessionKey: "agent:main:missing" },
        { ...bound, docId: unbound.id, sessionKey: other.sessionKey },
      ]) {
        await forbidden(params);
      }
      for (const [index, invalid] of [
        { toolName: "show_widget", content: JSON.stringify(unrelatedPresentation) },
        { toolName: "show_widget", details: unrelatedPresentation, isError: true },
        { toolName: "read", details: unrelatedPresentation },
        {
          toolName: "show_widget",
          details: { ...unrelatedPresentation, presentation: { target: "node_panel" } },
        },
      ].entries()) {
        await append(
          `invalid-widget-${index}`,
          widgetReceipt({ timestamp: 4 + index, ...invalid }),
        );
        await forbidden({ ...bound, docId: unbound.id });
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
        await append(`invalid-nested-${index}`, message);
        await forbidden({ ...bound, docId: unbound.id });
      }
      expect((await view({ docId }, owner))[0]).toBe(true);
      expect((await view({ docId: unbound.id }, owner))[0]).toBe(true);

      const liveResult = await show("live", "Committed live widget");
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
          { agentId: scope.agentId, sessionId: scope.sessionId, sessionKey: scope.sessionKey },
          { trackOwner: true, exclusive: true },
        ),
        "live widget run claim",
      );
      context.chatRunState.registry.add(runId, { sessionKey: scope.sessionKey, clientRunId });
      const live = context.chatRunState.getOrCreate(clientRunId);
      live.canvasBlocks = [{ type: "canvas", ...livePreview }];
      live.bufferIsCurrent = () => true;
      try {
        expect((await view(liveRequest))[2]).toMatchObject({
          code: "UNAVAILABLE",
          retryable: true,
          details: { type: "canvas_widget_pending" },
        });
        live.bufferIsCurrent = () => false;
        await forbidden(liveRequest);
        live.bufferIsCurrent = () => true;
        releaseAgentRunContext(runId, claim);
        await forbidden(liveRequest);
        // Code Mode and tool-search persist this existing canonical receipt format.
        await append("live-widget-result", nestedActivity(liveResult));
        await expectHtml(liveRequest, "Committed live widget");
      } finally {
        releaseAgentRunContext(runId, claim);
        context.chatRunState.registry.remove(runId, clientRunId, scope.sessionKey);
        context.chatRunState.clearRun(clientRunId);
      }

      const legacyScope = sessionScope("legacy-widget");
      await upsertSessionEntryCore(legacyScope, { ...entry, sessionId: legacyScope.sessionId });
      const legacyResult = await show(
        "legacy",
        "Retained reset archive widget",
        makeTool(legacyScope.sessionId),
      );
      const legacyId = widgetId(legacyResult);
      const archives = resolveSessionArtifactDirectory(legacyScope.storePath);
      await fs.mkdir(archives, { recursive: true });
      const legacyMessages = [
        receipt(legacyResult, "legacy-widget-call", 1),
        textMessage("assistant", "The retained widget is ready.", 2),
        ...Array.from({ length: 150 }, (_value, index) =>
          textMessage("user", `Later message ${index}`, index + 3),
        ),
      ];
      await fs.writeFile(
        path.join(archives, `${legacyScope.sessionId}.jsonl.reset.2026-09-30T00-00-00.000Z`),
        [
          { type: "session", version: 3, id: legacyScope.sessionId },
          ...legacyMessages.map((message, index) => ({
            type: "message",
            id: `legacy-${index}`,
            parentId: index === 0 ? null : `legacy-${index - 1}`,
            message,
          })),
        ]
          .map((record) => JSON.stringify(record))
          .join("\n") + "\n",
      );
      const historyResponse = await request(
        context,
        guest,
        { sessionKey: legacyScope.sessionKey, limit: 200 },
        "chat.history",
      );
      expect(historyResponse[0]).toBe(true);
      expect(historyResponse[1]).toMatchObject({
        messages: containing({
          role: "assistant",
          content: containing({
            type: "canvas",
            preview: expect.objectContaining({ viewId: legacyId }),
          }),
        }),
      });
      const legacyRequest = { docId: legacyId, sessionKey: legacyScope.sessionKey };
      await expectHtml(legacyRequest, "Retained reset archive widget");
      // Ordinary history stops selecting this archive once native displayed history exists.
      await append("native-reply", textMessage("user", "New native history", 3), legacyScope);
      await forbidden(legacyRequest);

      const provisioning = createDeferred();
      const sandbox = createDeferred<number>();
      context.getMcpAppSandboxPort = () => undefined;
      context.ensureSandboxHostPort = () => {
        provisioning.resolve();
        return sandbox.promise;
      };
      const pending = view(bound);
      await provisioning.promise;
      await patchSessionEntryCore(scope, () => ({ visibility: "draft" }));
      sandbox.resolve(18790);
      const revoked = await pending;
      expect(revoked).toMatchObject([
        false,
        undefined,
        {
          code: "FORBIDDEN",
          message: expect.stringContaining("access"),
        },
      ]);
      expect((await view(bound))[0]).toBe(false);
    },
  );
});
