// @vitest-environment jsdom
import { expectDefined } from "@openclaw/normalization-core";
import { nothing, render } from "lit";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ChatMetadataResult } from "../../lib/chat/chat-metadata-cache.ts";
import {
  beginChatMetadataPublication,
  peekChatMetadata,
} from "../../lib/chat/chat-metadata-store.ts";
import {
  buildFallbackSlashCommands,
  replaceSlashCommands,
  SLASH_COMMANDS,
} from "../../lib/chat/commands.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../../test-helpers/gateway-client.ts";
import { makeChatHost, requestCalls } from "./chat-host.test-support.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import * as metadataOwner from "./chat-state-refresh.ts";
import { getChatComposerState, resetChatComposerState } from "./components/chat-composer-state.ts";
import type { ChatComposerProps } from "./components/chat-composer-types.ts";
import { renderChatComposer } from "./components/chat-composer.ts";
import { installChatComposerPickerDismissal } from "./components/chat-picker-overlay.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";

// No module mocks: publications, accepted scope fences, catalog projection, and composer
// rendering are the real owners. The existing Gateway fixture replaces only transport;
// DOM measurements and fake time follow the other composer tests' per-test setup.
beforeEach(() => {
  vi.useFakeTimers();
  installTranscriptDomMocks();
  onTestFinished(installChatComposerPickerDismissal(document));
});

afterEach(() => {
  resetChatComposerState();
  replaceSlashCommands(buildFallbackSlashCommands());
  resetTranscriptTestDom();
  vi.useRealTimers();
});

function catalog(...names: string[]): ChatMetadataResult {
  return {
    commands: names.map((name) => ({
      name,
      textAliases: [`/${name}`],
      description: `Use ${name}`,
      source: "skill",
      scope: "text",
      acceptsArgs: false,
      skillDisplayName: name,
      skillModelVisible: true,
    })),
  };
}

function gateway(catalogs: ReadonlyMap<string, ChatMetadataResult>) {
  const request = createGatewayRequestMock((method, params) => {
    if (method === "models.list") {
      return { models: [] };
    }
    if (method === "chat.metadata") {
      const key =
        params && typeof params === "object" && "sessionKey" in params
          ? params.sessionKey
          : undefined;
      if (typeof key === "string") {
        return expectDefined(catalogs.get(key), `catalog for ${key}`);
      }
    }
    throw new Error(`Unexpected request: ${method}`);
  });
  return { client: createTestGatewayClient(request), request };
}

async function mountComposer(client: GatewayBrowserClient, paneId = "single") {
  let draft = "";
  let deferRendering = false;
  let renderQueued = false;
  let renderCount = 0;
  const hydration: Promise<void>[] = [];
  const container = document.body.appendChild(document.createElement("div"));
  const requestUpdate = () => {
    if (deferRendering) {
      renderQueued = true;
    } else {
      draw();
    }
  };
  // The shared host fixture supplies the session capability and lifecycle. As in the
  // metadata-session-facts tests, this commands-only test adds the pane presentation port.
  const host = {
    ...makeChatHost({
      client,
      sessionKey: `agent:work:${paneId}`,
      assistantAgentId: "work",
      connectionEpoch: 1,
    }),
    chatMetadataIsPresented: () => true,
    requestUpdate,
  } as ChatPageHost;

  // The optional export lookup lets this regression run on the pre-change source too.
  // It supplies no substitute catalog and never changes the assertions or schedules.
  // The current ChatPane passes this exact production getter.
  const readCatalog = Reflect.get(metadataOwner, "getChatCommandCatalog") as
    | typeof metadataOwner.getChatCommandCatalog
    | undefined;
  const props: ChatComposerProps = {
    paneId,
    sessionKey: host.sessionKey,
    currentAgentId: "work",
    connected: true,
    canSend: true,
    disabledReason: null,
    sending: false,
    messages: [],
    stream: null,
    queue: [],
    draft,
    modelCatalog: [],
    modelSwitching: false,
    sessions: null,
    assistantName: "Assistant",
    getDraft: () => draft,
    onDraftChange: (next) => {
      draft = next;
    },
    onRequestUpdate: requestUpdate,
    onSlashIntent: () => {
      const refresh = metadataOwner.refreshChatCommands(host);
      hydration.push(refresh);
      return refresh;
    },
    ...(readCatalog ? { getCommandCatalog: () => readCatalog(host) } : {}),
    onSend: vi.fn(),
    onSlashCommand: vi.fn(),
    onQueueRemove: vi.fn(),
  };
  function draw() {
    renderQueued = false;
    renderCount += 1;
    render(renderChatComposer({ ...props, draft }), container);
  }
  const textarea = () =>
    expectDefined(container.querySelector<HTMLTextAreaElement>("textarea"), "composer textarea");
  const names = () =>
    Array.from(container.querySelectorAll<HTMLElement>("[role=option] .slash-menu-name"))
      .map((row) => row.textContent?.trim().replace(/^\//u, ""))
      .filter((name): name is string => name?.startsWith("audit_"))
      .toSorted();
  const input = (value: string) => {
    const target = textarea();
    target.focus();
    target.value = value;
    // Native value assignment puts the caret at the end; avoid a synthetic deferred
    // select event that would independently refresh menus after the publication.
    expect(target.selectionStart).toBe(value.length);
    expect(target.selectionEnd).toBe(value.length);
    target.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
  };
  const key = (pressed: string) =>
    textarea().dispatchEvent(
      new KeyboardEvent("keydown", { key: pressed, bubbles: true, cancelable: true }),
    );
  const settle = async () => {
    await Promise.all(hydration);
    await vi.runAllTimersAsync();
    const state = getChatComposerState(paneId);
    expect(state.slashCommandRefreshPending).toBe(false);
    expect(state.skillCommandRefreshPending).toBe(false);
  };
  const publish = (result: ChatMetadataResult) => {
    const scope = { agentId: "work", sessionKey: host.sessionKey };
    const publication = beginChatMetadataPublication(client, scope);
    expect(publication.isCurrent()).toBe(true);
    publication.publish(result);
    expect(peekChatMetadata(client, scope)).toEqual(result);
  };
  onTestFinished(() => {
    metadataOwner.retireChatMetadataRequests(host);
    render(nothing, container);
    container.remove();
  });
  draw();
  await metadataOwner.refreshChatMetadata(host);
  await vi.runAllTimersAsync();
  return {
    container,
    textarea,
    names,
    input,
    key,
    settle,
    publish,
    get renderCount() {
      return renderCount;
    },
    defer() {
      deferRendering = true;
    },
    flush() {
      if (renderQueued) {
        draw();
      }
    },
  };
}

it.each(["/", "Please use /au:", "Please use $au"])(
  "refreshes a fully hydrated open %s after an accepted same-owner publication",
  async (draft) => {
    const { client, request } = gateway(
      new Map([["agent:work:single", catalog("audit_old", "audit_keep")]]),
    );
    const pane = await mountComposer(client);
    pane.input(draft);
    await pane.settle();
    expect(pane.names()).toEqual(["audit_keep", "audit_old"]);
    const before = {
      value: pane.textarea().value,
      start: pane.textarea().selectionStart,
      end: pane.textarea().selectionEnd,
    };
    pane.publish(catalog("audit_keep", "audit_new"));
    expect(
      SLASH_COMMANDS.filter((entry) => entry.source === "skill").map((entry) => entry.name),
    ).toEqual(["audit_keep", "audit_new"]);
    expect(pane.names()).toEqual(["audit_keep", "audit_new"]);
    expect({
      value: pane.textarea().value,
      start: pane.textarea().selectionStart,
      end: pane.textarea().selectionEnd,
    }).toEqual(before);
    expect(requestCalls(request, "chat.metadata")).toHaveLength(1);
    expect(requestCalls(request, "commands.list")).toHaveLength(0);
  },
);

it.each(["Please use /au:", "Please use $au"])(
  "closes %s when its accepted catalog removes all matches",
  async (draft) => {
    const { client } = gateway(new Map([["agent:work:single", catalog("audit_old")]]));
    const pane = await mountComposer(client);
    pane.input(draft);
    await pane.settle();
    pane.publish(catalog());
    expect(pane.container.querySelector("[role=listbox]")).toBeNull();
    expect(pane.textarea().hasAttribute("aria-activedescendant")).toBe(false);
    expect(pane.textarea().value).toBe(draft);
  },
);

it.each(["Please use /au:", "Please use $au"])(
  "does not reopen dismissed %s on publication",
  async (draft) => {
    const { client } = gateway(new Map([["agent:work:single", catalog("audit_old")]]));
    const pane = await mountComposer(client);
    pane.input(draft);
    await pane.settle();
    pane.key("Escape");
    expect(pane.container.querySelector("[role=listbox]")).toBeNull();
    pane.publish(catalog("audit_new"));
    expect(pane.container.querySelector("[role=listbox]")).toBeNull();
    expect(pane.textarea().hasAttribute("aria-activedescendant")).toBe(false);
  },
);

it.each(["Please use /au:", "Please use $au"])(
  "keeps the selected identity when %s changes row positions",
  async (draft) => {
    const { client } = gateway(new Map([["agent:work:single", catalog("audit_a", "audit_keep")]]));
    const pane = await mountComposer(client);
    pane.input(draft);
    await pane.settle();
    pane.key("ArrowDown");
    const selected = expectDefined(
      pane.textarea().getAttribute("aria-activedescendant"),
      "selected skill",
    );
    expect(selected).toContain("audit_keep");
    pane.publish(catalog("audit_keep", "audit_z"));
    expect(pane.names()).toEqual(["audit_keep", "audit_z"]);
    expect(pane.textarea().getAttribute("aria-activedescendant")).toBe(selected);
    expect(pane.container.querySelector(`[id="${selected}"]`)?.getAttribute("aria-selected")).toBe(
      "true",
    );
  },
);

it.each([false, true])(
  "reconciles scoped rows after coalesced split-pane renders (reverse=%s)",
  async (reverse) => {
    const { client, request } = gateway(
      new Map([
        ["agent:work:a", catalog("audit_a_old")],
        ["agent:work:b", catalog("audit_b_old")],
      ]),
    );
    const a = await mountComposer(client, "a");
    a.input("Please use $audit_");
    await a.settle();
    const b = await mountComposer(client, "b");
    b.input("Please use $audit_");
    await b.settle();
    a.defer();
    b.defer();
    const before = [a.renderCount, b.renderCount];
    const updates = [
      { pane: a, result: catalog("audit_a_new") },
      { pane: b, result: catalog("audit_b_new") },
    ];
    for (const update of reverse ? updates.toReversed() : updates) {
      update.pane.publish(update.result);
    }
    expect([a.renderCount, b.renderCount]).toEqual(before);
    // Render A while B may own the global registry, then B while A may own it.
    a.flush();
    b.flush();
    expect(a.names()).toEqual(["audit_a_new"]);
    expect(b.names()).toEqual(["audit_b_new"]);
    expect([a.renderCount, b.renderCount]).toEqual(before.map((count) => count + 1));
    expect(requestCalls(request, "chat.metadata")).toHaveLength(2);
    expect(requestCalls(request, "commands.list")).toHaveLength(0);
  },
);
