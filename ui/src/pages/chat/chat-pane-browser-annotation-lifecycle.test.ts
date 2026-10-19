import { afterEach, expect, it, vi } from "vitest";
/* @vitest-environment jsdom */
/* @vitest-environment-options {"url":"http://chat-pane-browser-annotation-lifecycle.test/"} */
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { chatInputOwnerForContext } from "../../app/chat-input-owner.ts";
import type { BrowserAnnotationDraft } from "../../components/browser/browser-annotation.ts";
import type { ChatAttachment } from "../../lib/chat/chat-types.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import { resolveUiConversationIdentity } from "../../lib/sessions/session-key.ts";
import "../../lib/toast-host.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import {
  getChatAttachmentDataUrl,
  registerChatAttachmentPayload,
  releaseChatAttachmentPayload,
} from "./attachment-payload-store.ts";
import { ChatPaneRuntime } from "./chat-pane-render.ts";
import {
  createGatewayBrowserClientFixture,
  createSessionCapabilityFixture,
  createPaneTestHost,
  getPaneTestRuntime,
  createSessionContext,
  createTestChatPane,
  type TestChatPane,
} from "./chat-pane.test-support.ts";
import { storedChatOutboxScopeKey } from "./composer-persistence.ts";

type AnnotationPane = TestChatPane & {
  receiveBrowserAnnotation: (event: Event) => void;
  removeBrowserAnnotation: (attachment: ChatAttachment) => void;
};

afterEach(() => vi.restoreAllMocks());

function receive(pane: TestChatPane, event = annotationEvent()) {
  (pane as AnnotationPane).receiveBrowserAnnotation(event);
}

function annotationPane(
  client = {} as GatewayBrowserClient,
  sessions = createSessionCapabilityFixture(),
) {
  const result = createTestChatPane({ client, sessions });
  result.pane.active = true;
  return result;
}

function annotatedPane(sessions = createSessionCapabilityFixture(), noClient = false) {
  const owner = createGatewayBrowserClientFixture();
  const result = annotationPane(owner, sessions);
  if (noClient) {
    result.pane.connectedClient = null;
    (result.pane.context.gateway.snapshot as { client: GatewayBrowserClient | null }).client = null;
  }
  receive(result.pane);
  const annotation = result.state.chatAttachments[0]!;
  const ordinary = storedAttachment("ordinary", false);
  result.state.chatAttachments.push(ordinary);
  return { ...result, owner, annotation, ordinary };
}

function consume(pane: TestChatPane, owner: GatewayBrowserClient) {
  const handoff = pane.context.chatAttachmentHandoff;
  const scope = resolveUiConversationIdentity(pane.state, pane.state.sessionKey);
  const key = {
    owner,
    paneId: pane.paneId,
    scopeKey: storedChatOutboxScopeKey(scope),
  };
  return () => handoff.consume(key);
}

function reconnect(pane: TestChatPane, client: GatewayBrowserClient) {
  pane.applyGatewaySnapshot({
    ...pane.context.gateway.snapshot,
    client,
    phase: "reconnecting",
    hello: null,
  });
}

function annotationEvent(minimal = false) {
  return new CustomEvent<BrowserAnnotationDraft>("openclaw:browser-annotation", {
    detail: {
      modelContext: minimal ? "Context" : "Generated page context",
      dataUrl: "data:image/png;base64,aGVsbG8=",
      fileName: "annotated-page.png",
      card: {
        title: minimal ? "" : "Example Domain",
        displayUrl: "example.com",
        markedRegionCount: minimal ? 1 : 2,
        inspectedElement: !minimal,
      },
    },
    cancelable: true,
  });
}

function storedAttachment(id: string, browserAnnotation: boolean) {
  const { modelContext, card } = annotationEvent().detail;
  return registerChatAttachmentPayload({
    attachment: {
      id,
      mimeType: "image/png",
      ...(browserAnnotation ? { browserAnnotation: { modelContext, ...card } } : {}),
    },
    dataUrl: `data:image/png;base64,${id}`,
    file: new File([id], `${id}.png`, { type: "image/png" }),
  });
}

function expectPayloads(retained: ChatAttachment[], released: ChatAttachment[] = []) {
  retained.forEach((attachment) => expect(getChatAttachmentDataUrl(attachment)).not.toBeNull());
  released.forEach((attachment) => expect(getChatAttachmentDataUrl(attachment)).toBeNull());
}

function composerFallback(attachments: ReturnType<typeof storedAttachment>[]) {
  return { attachments, message: "", sequence: 1, storageFailed: false };
}

function mountedPanes(session = "current") {
  const owner = {} as GatewayBrowserClient;
  const context = createSessionContext(owner, createSessionCapabilityFixture());
  const mount = (key = session) => {
    const pane = createPaneTestHost(
      "openclaw-chat-runtime-test",
      ChatPaneRuntime,
    ) as unknown as TestChatPane;
    Object.defineProperty(pane, "isConnected", { configurable: true, value: true });
    Object.assign(pane, { context, paneId: "p1", sessionKey: `agent:main:${key}` });
    const stopAfterRestore = new Error("stop after attachment restore");
    vi.spyOn(pane.chatState.composerPersistence, "start").mockImplementation(() => {
      throw stopAfterRestore;
    });
    expect(() => getPaneTestRuntime(pane).start()).toThrow(stopAfterRestore);
    return pane;
  };
  return { owner, context, mount };
}

it("transfers the mounted package and releases fallback-only payloads on disconnect", () => {
  const { owner, mount } = mountedPanes();
  const pane = mount();
  const state = pane.state;
  const shared = storedAttachment("shared-annotation", true);
  const fallback = storedAttachment("fallback-annotation", true);
  const ordinary = storedAttachment("ordinary", false);
  state.chatAttachments = [shared, ordinary];
  state.chatComposerFallbackByScope = {
    fallback: composerFallback([shared, fallback, ordinary]),
  };
  const take = consume(pane, owner);

  pane.disconnectedCallback();

  expectPayloads([shared, fallback, ordinary]);
  const transferred = take();
  expect(transferred?.attachments).toEqual([shared, ordinary]);
  expect(transferred?.attachments[0]).toBe(shared);
  expect(transferred?.attachments[1]).toBe(ordinary);
  expect(transferred?.fallbacks.fallback).toMatchObject(
    composerFallback([shared, fallback, ordinary]),
  );
  expect(transferred?.fallbacks.fallback?.attachments).toEqual([shared, fallback, ordinary]);
  [shared, fallback, ordinary].forEach(({ id }) => releaseChatAttachmentPayload(id));
});

it("releases a real pane's late disconnect after application disposal", () => {
  const { pane, owner, annotation, ordinary } = annotatedPane({} as SessionCapability);
  const take = consume(pane, owner);
  pane.context.chatAttachmentHandoff.dispose();

  pane.disconnectedCallback();

  expectPayloads([], [annotation, ordinary]);
  expect(take()).toBeNull();
});

it("restores each retained session package under the same logical pane", () => {
  const { mount } = mountedPanes();
  const first = mount("first");
  const second = mount("second");
  const firstAttachment = storedAttachment("retained-first", false);
  const secondAttachment = storedAttachment("retained-second", false);
  first.state.chatAttachments = [firstAttachment];
  second.state.chatAttachments = [secondAttachment];

  first.disconnectedCallback();
  second.disconnectedCallback();

  const secondRemount = mount("second");
  const firstRemount = mount("first");
  expect(secondRemount.state.chatAttachments).toEqual([secondAttachment]);
  expect(firstRemount.state.chatAttachments).toEqual([firstAttachment]);
  secondRemount.discardStagedAttachments?.();
  firstRemount.discardStagedAttachments?.();
  secondRemount.disconnectedCallback();
  firstRemount.disconnectedCallback();
});

it.each(["split", "dock"] as const)(
  "lets only the active %s pane consume a shared annotation event",
  (surface) => {
    const first = annotationPane(undefined, {} as SessionCapability);
    const second = annotationPane(undefined, {} as SessionCapability);
    second.pane.context = first.pane.context;
    first.pane.active = surface === "dock";
    if (surface === "dock") {
      (second.pane as TestChatPane & { inputRegion: string }).inputRegion = "dock";
      chatInputOwnerForContext(first.pane.context).claim("dock");
    }
    const event = annotationEvent(true);
    receive(first.pane, event);
    receive(second.pane, event);
    receive(first.pane, event);

    expect(first.state.chatAttachments).toEqual([]);
    expect(second.state.chatAttachments).toHaveLength(1);
    expect(event.defaultPrevented).toBe(true);
    second.pane.discardStagedAttachments?.();
  },
);

it.each(["first-client", "replacement"] as const)(
  "keeps captured identity through %s remounts",
  (change) => {
    const { owner, context, mount } = mountedPanes(change);
    const snapshot = context.gateway.snapshot as { client: GatewayBrowserClient | null };
    if (change === "first-client") {
      snapshot.client = null;
    }
    const pane = mount();
    pane.active = true;
    snapshot.client = owner;
    receive(pane);
    const captured = pane.state.chatAttachments[0]!;
    if (change === "replacement") {
      snapshot.client = {} as GatewayBrowserClient;
    }
    pane.disconnectedCallback();
    const remount = mount();
    if (change === "first-client") {
      remount.applyGatewaySnapshot(context.gateway.snapshot);
      expect(remount.state.chatAttachments[0]).toBe(captured);
      remount.discardStagedAttachments?.();
    } else {
      expect(remount.state.chatAttachments).toEqual([]);
      expectPayloads([], [captured]);
    }
    remount.disconnectedCallback();
  },
);

it("preserves the package on same-client reconnect and clears it on replacement", () => {
  const { pane, state, owner, annotation: current, ordinary } = annotatedPane();
  state.loadAssistantIdentity = vi.fn(async () => undefined);
  const connected = pane.context.gateway.snapshot;
  pane.active = false;
  const fallback = storedAttachment("replacement-fallback", true);
  state.chatComposerFallbackByScope = { fallback: composerFallback([fallback, ordinary]) };

  reconnect(pane, owner);
  expect(state.chatAttachments).toEqual([current, ordinary]);
  expect(getChatAttachmentDataUrl(current)).not.toBeNull();

  pane.applyGatewaySnapshot(connected);
  expect(state.chatAttachments).toEqual([current, ordinary]);
  expect(getChatAttachmentDataUrl(current)).not.toBeNull();

  reconnect(pane, createGatewayBrowserClientFixture());
  expect(state.chatAttachments).toEqual([ordinary]);
  expect(state.chatComposerFallbackByScope.fallback?.attachments).toEqual([ordinary]);
  expectPayloads([ordinary], [current, fallback]);
});

it("discards a staged package captured without a client when the first client arrives", () => {
  const { pane, state, owner: client, annotation, ordinary } = annotatedPane(undefined, true);

  reconnect(pane, client);

  expect(state.chatAttachments).toEqual([ordinary]);
  expectPayloads([ordinary], [annotation]);
});

it("publishes annotation capture, removal, and Undo through the composer owner", async () => {
  const { mount } = mountedPanes();
  const pane = mount();
  pane.active = true;
  const state = pane.state;
  const source = getPaneTestRuntime(pane).chatState.composerDraft;
  const published: ChatAttachment[][] = [];
  const unsubscribe = source.subscribe(() => published.push(source.read().attachments));
  const toastHost = document.createElement("openclaw-toast-host");
  document.body.append(toastHost);

  try {
    receive(pane);
    const attachment = state.chatAttachments[0]!;
    expect(published.at(-1)).toEqual([attachment]);

    (pane as AnnotationPane).removeBrowserAnnotation(attachment);
    expect(published.at(-1)).toEqual([]);
    await waitForSolid(() =>
      expect(toastHost.querySelector(".app-toast__action")?.textContent).toBe("Undo"),
    );
    toastHost.querySelector<HTMLButtonElement>(".app-toast__action")!.click();

    expect(published.at(-1)).toEqual([attachment]);
    expect(state.chatAttachments[0]).toBe(attachment);
    pane.discardStagedAttachments?.();
  } finally {
    unsubscribe();
    toastHost.remove();
  }
});

it("invalidates annotation Undo when the logical Gateway client is replaced", async () => {
  const { pane, state, annotation, ordinary } = annotatedPane();
  const toastHost = document.createElement("openclaw-toast-host");
  document.body.append(toastHost);

  (pane as AnnotationPane).removeBrowserAnnotation(annotation);
  await waitForSolid(() =>
    expect(toastHost.querySelector(".app-toast__action")?.textContent).toBe("Undo"),
  );
  expect(state.chatAttachments).toEqual([ordinary]);
  expect(getChatAttachmentDataUrl(annotation)).not.toBeNull();

  reconnect(pane, {} as GatewayBrowserClient);
  toastHost.querySelector<HTMLButtonElement>(".app-toast__action")!.click();

  expect(state.chatAttachments).toEqual([ordinary]);
  expectPayloads([ordinary], [annotation]);
  toastHost.remove();
});
