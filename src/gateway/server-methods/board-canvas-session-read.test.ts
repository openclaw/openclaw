import { expectDefined } from "@openclaw/normalization-core";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import { createShowWidgetTool } from "../../canvas/widget-tool.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { resolveDefaultSessionStorePath } from "../../config/sessions/paths.js";
import {
  appendTranscriptMessage,
  patchSessionEntryCore,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { boardStore } from "../board-store.js";
import {
  dispatchAuthorizationRequest,
  startExactAuthorizationRequest,
} from "../server-methods.authorization.test-support.js";
import { createRequestGate } from "../server-methods.request-gate.test-support.js";
import { roleClient, rolePolicyConfig } from "../session-sharing.test-utils.js";
import { createHistoryReadContext } from "./chat-history.test-helpers.js";

afterEach(() => vi.restoreAllMocks());

async function withCanvasBoard(run: (fixture: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  await withOpenClawTestState(
    { scenario: "minimal", prepareProfileCatalog: true },
    async (state) => {
      const cfg = rolePolicyConfig();
      await state.writeConfig(cfg);
      setRuntimeConfigSnapshot(cfg);
      await run(await setup(cfg));
    },
  );
}

async function setup(cfg: ReturnType<typeof rolePolicyConfig>) {
  const client = roleClient("view", "canvas-board-owner");
  client.connect.scopes = ["operator.sessions.write"];
  const scope = {
    agentId: "main",
    sessionKey: "agent:main:canvas-board-owned",
    sessionId: "canvas-board-owned",
    storePath: resolveDefaultSessionStorePath("main"),
  };
  const entry = {
    sessionId: scope.sessionId,
    updatedAt: 1,
    visibility: "shared" as const,
    createdActor: {
      type: "human" as const,
      source: "profile" as const,
      id: client.authenticatedUserProfile!.profileId,
    },
  };
  await upsertSessionEntryCore(scope, entry);
  const context = await createHistoryReadContext({
    getRuntimeConfig: () => cfg,
    getMcpAppSandboxPort: () => 18790,
  });
  context.resolveGatewayContext = () => context;
  const saveWidget = async (text: string, target = scope) => {
    const tool = createShowWidgetTool({ sessionId: target.sessionId, agentId: target.agentId });
    const result = await tool.execute("show-widget", {
      title: "Synthetic widget",
      widget_code: `<p>${text}</p>`,
    });
    const docId = expectDefined(
      asOptionalRecord(asOptionalRecord(result.details)?.view)?.id,
      "widget ID",
    );
    await appendTranscriptMessage(target, {
      eventId: "saved-widget",
      message: {
        role: "toolResult",
        toolName: "show_widget",
        toolCallId: "show-widget",
        ...result,
        timestamp: 1,
      },
    });
    return docId;
  };
  const request = async (method: string, params: Record<string, unknown>) => {
    const respond = await dispatchAuthorizationRequest(
      method,
      { sessionKey: scope.sessionKey, ...params },
      { client, context },
    );
    expect(respond).toHaveBeenCalledOnce();
    return expectDefined(respond.mock.calls[0], "board response");
  };
  return { client, context, scope, entry, saveWidget, request };
}

it("pins a saved Canvas receipt but refuses a known foreign document without copying it", async () => {
  await withCanvasBoard(async ({ scope, entry, saveWidget, request }) => {
    const docId = await saveWidget("Synthetic permitted document");
    expect((await request("canvas.document.view", { docId }))[0]).toBe(true);
    const allowed = await request("board.widget.put", {
      name: "permitted",
      content: { kind: "canvas-doc", docId },
    });
    expect(allowed[0], JSON.stringify(allowed)).toBe(true);
    await boardStore.useWidgetDocument(scope, "permitted", (document) => {
      expect(document).toMatchObject({
        html: expect.stringContaining("Synthetic permitted document"),
      });
    });
    const before = await boardStore.getSnapshot(scope);
    const foreignOwner = roleClient("write", "canvas-foreign-owner");
    const foreign = {
      ...scope,
      sessionKey: "agent:main:canvas-foreign",
      sessionId: "canvas-foreign",
    };
    await upsertSessionEntryCore(foreign, {
      ...entry,
      sessionId: foreign.sessionId,
      visibility: "draft",
      createdActor: { ...entry.createdActor, id: foreignOwner.authenticatedUserProfile!.profileId },
    });
    const foreignId = await saveWidget("Synthetic foreign document", foreign);
    await appendTranscriptMessage(scope, {
      eventId: "untrusted-reference",
      message: {
        role: "user",
        content: JSON.stringify({ kind: "canvas", view: { id: foreignId } }),
        timestamp: 2,
      },
    });
    expect(
      (
        await request("canvas.document.view", { docId: foreignId, sessionKey: foreign.sessionKey })
      )[0],
    ).toBe(false);
    expect(
      await request("board.widget.put", {
        name: "foreign-document",
        content: { kind: "canvas-doc", docId: foreignId },
      }),
    ).toMatchObject([false, undefined, { code: "FORBIDDEN" }]);
    expect(await boardStore.getSnapshot(scope)).toEqual(before);
    const view = await request("board.get", {});
    expect(view[1]).toMatchObject({
      widgets: [
        expect.objectContaining({
          name: "permitted",
          grantState: "none",
          viewTicket: expect.any(String),
        }),
      ],
    });
  });
});

it.each([false, true])(
  "keeps Canvas source authority through a queued import (revoked: %s)",
  async (revoked) => {
    await withCanvasBoard(async ({ client, context, scope, saveWidget }) => {
      const docId = await saveWidget("Synthetic retained document");
      const before = await boardStore.getSnapshot(scope);
      using gate = createRequestGate();
      const put = boardStore.putWidget.bind(boardStore);
      const waiting = vi.spyOn(boardStore, "putWidget").mockImplementation(async (...args) => {
        await gate.pause();
        return put(...args);
      });
      const { request, respond } = startExactAuthorizationRequest(
        "board.widget.put",
        {
          sessionKey: scope.sessionKey,
          name: "retained",
          content: { kind: "canvas-doc", docId },
        },
        { client, context },
      );
      await gate.during(request, async () => {
        expect(waiting).toHaveBeenCalledOnce();
        expect(respond).not.toHaveBeenCalled();
        if (revoked) {
          await patchSessionEntryCore(scope, () => ({ lifecycleRevision: "source-replaced" }));
        }
      });
      expect(respond).toHaveBeenCalledOnce();
      if (revoked) {
        expect(respond.mock.calls[0]?.[0]).toBe(false);
        expect(await boardStore.getSnapshot(scope)).toEqual(before);
      } else {
        expect(respond.mock.calls[0]?.[0]).toBe(true);
        expect((await boardStore.getSnapshot(scope)).widgets).toEqual([
          expect.objectContaining({ name: "retained" }),
        ]);
      }
    });
  },
);
