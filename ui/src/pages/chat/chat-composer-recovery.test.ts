/* @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError } from "../../api/gateway.ts";
import type { ChatAttachment } from "../../lib/chat/chat-types.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import {
  getChatAttachmentDataUrl,
  registerChatAttachmentPayload,
  releaseChatAttachmentPayloads,
} from "./attachment-payload-store.ts";
import { findChatSendPayload, makeChatHost } from "./chat-host.test-support.ts";
import { ChatPaneComposerHandoff } from "./chat-pane-attachment-handoff.ts";
import { createInitializationContext } from "./chat-pane.test-support.ts";
import { retryQueuedChatMessage } from "./chat-send-actions.ts";
import { createChatState } from "./chat-state-controller.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { createPageState } from "./chat-state-page.ts";
import { installOutboxBrowserStorage } from "./outbox-browser.test-support.ts";

const disposals: Array<() => void> = [];
const attachments: ChatAttachment[] = [];
const payloadUrl = "data:application/pdf;base64,JVBERi0xLjQK";

function mount(
  transport: ReturnType<typeof makeChatHost>,
  context = { ...createInitializationContext(), sessions: transport.sessions },
  sessionKey = "agent:main:source",
) {
  const controller = createChatState<ChatPageHost>({ awaitDomCommit: async () => true });
  const lifecycle = controller.createRenderLifecycle();
  const state = createPageState(context, lifecycle, document.createElement("div"));
  Object.assign(state, {
    client: transport.client,
    connected: true,
    connectionEpoch: 0,
    hello: transport.hello,
    settings: transport.settings,
    sessionKey,
    assistantAgentId: "main",
  });
  controller.attach(state);
  controller.composerPersistence.restore();
  controller.composerPersistence.start();
  disposals.push(controller.dispose);
  return { state, controller, context, dispose: controller.dispose };
}

beforeEach(() => {
  installOutboxBrowserStorage();
  vi.stubGlobal("sessionStorage", createStorageMock());
});
afterEach(() => {
  for (const dispose of disposals.splice(0).toReversed()) {
    dispose();
  }
  releaseChatAttachmentPayloads(attachments);
  attachments.length = 0;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each([
  ["retained", "error"],
  ["retained", "rejection"],
  ["evicted", "error"],
  ["evicted", "rejection"],
  ["replaced", "error"],
  ["replaced", "rejection"],
  ["handoff", "error"],
  ["handoff", "rejection"],
  ["evicted", "ok"],
] as const)("settles a %s composer's pending command after %s", async (lifecycle, response) => {
  const acknowledgment = createDeferred<{ runId: string; status: "error" } | { status: "ok" }>();
  let attempts = 0;
  const transport = makeChatHost({
    requestHandlers: {
      "chat.send": () => (++attempts === 1 ? acknowledgment.promise : { status: "ok" }),
    },
  });
  const source = mount(transport, undefined, lifecycle === "handoff" ? "global" : undefined);
  const file = new File(["%PDF-1.4\n"], "brief.pdf", { type: "application/pdf" });
  const attachment = registerChatAttachmentPayload({
    attachment: {
      id: "command-document",
      mimeType: file.type,
      fileName: file.name,
      sizeBytes: file.size,
    },
    dataUrl: payloadUrl,
    file,
  });
  attachments.push(attachment);
  source.state.chatAttachments = [attachment];
  source.state.handleChatDraftChange("/status", []);
  let presented = true;
  const present = (pane: typeof source, region: "page" | "dock", visible: () => boolean) => {
    const handoff = new ChatPaneComposerHandoff(source.context, {
      state: () => pane.state,
      owner: () => transport.client,
      presentationOwner: () => pane.controller.composerPersistence.presentationOwner,
      region: () => region,
      presented: visible,
      pause: () => pane.controller.composerPersistence.stop(),
      takeAttachmentReads: () => pane.controller.takeAttachmentReads(),
      adoptAttachmentReads: (reads) => pane.controller.adoptAttachmentReads(reads, pane.state),
      resume: (restore) => {
        if (restore) {
          pane.controller.composerPersistence.restore();
        }
        pane.controller.composerPersistence.start();
      },
    });
    handoff.claim();
    disposals.push(() => handoff.dispose());
  };
  if (lifecycle === "handoff") {
    present(source, "page", () => presented);
  }
  const send = source.state.handleSendChat();
  await vi.waitFor(() => expect(attempts).toBe(1));
  const original = findChatSendPayload(transport);
  const pending = source.state.chatQueue[0]!;
  const reopen = () => mount(transport, source.context, source.state.sessionKey);
  if (lifecycle === "evicted" || lifecycle === "replaced") {
    source.controller.composerPersistence.persistForRouteSwitchResult();
    source.dispose();
  }
  let replacement: typeof source | undefined;
  if (lifecycle === "replaced" || lifecycle === "handoff") {
    replacement = reopen();
  }
  if (lifecycle === "handoff") {
    presented = false;
    present(replacement!, "dock", () => true);
  }
  if (response === "rejection") {
    acknowledgment.reject(
      new GatewayRequestError({ code: "INVALID_REQUEST", message: "Command rejected" }),
    );
  } else if (response === "ok") {
    acknowledgment.resolve({ status: "ok" });
  } else {
    acknowledgment.resolve({ runId: pending.sendRunId!, status: "error" });
  }
  await send;
  if (response === "ok") {
    expect(reopen().state).toMatchObject({ chatQueue: [], chatMessage: "", chatAttachments: [] });
    return;
  }
  if (lifecycle === "retained") {
    expect(source.state).toMatchObject({
      chatMessage: "/status",
      chatAttachments: [{ id: attachment.id }],
      chatQueue: [],
    });
    expect(getChatAttachmentDataUrl(source.state.chatAttachments[0]!)).toBe(payloadUrl);
    return;
  }
  const recovered = replacement ?? reopen();
  expect(recovered.state).toMatchObject({ chatMessage: "", chatAttachments: [] });
  await vi.waitFor(() => {
    expect(recovered.state.chatQueue).toMatchObject([
      { id: pending.id, text: "/status", sendRunId: pending.sendRunId, sendState: "failed" },
    ]);
    expect(getChatAttachmentDataUrl(recovered.state.chatQueue[0]!.attachments![0]!)).toBe(
      payloadUrl,
    );
  });
  await retryQueuedChatMessage(recovered.state, pending.id);
  const requests = transport.request.mock.calls.filter(([method]) => method === "chat.send");
  expect(requests).toHaveLength(2);
  expect(requests[1]![1]).toEqual({ ...original, idempotencyKey: expect.any(String) });
  expect(requests[1]![1]).not.toEqual(original);
  expect(recovered.state.chatQueue).toEqual([]);
});
