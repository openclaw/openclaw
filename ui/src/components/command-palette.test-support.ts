import { afterEach, beforeEach, expect, onTestFinished, vi } from "vitest";
import type { SessionsSearchResult } from "../../../packages/gateway-protocol/src/index.js";
import type { SessionsListResult } from "../api/types.ts";
import { createAgentSelectionCapability } from "../app/agent-selection.ts";
import { createApplicationConfigCapability } from "../app/config.ts";
import type { ApplicationContext, ApplicationGateway } from "../app/context.ts";
import { createWebPushCapability } from "../app/web-push.ts";
import { createAgentIdentityCapability } from "../lib/agents/identity.ts";
import { createAgentCapability } from "../lib/agents/index.ts";
import { invalidateChatMetadataStore } from "../lib/chat/chat-metadata-cache.ts";
import { invalidateCronCatalog } from "../lib/cron/catalog.ts";
import { modelCatalogEventInvalidation } from "../lib/model-catalog-cache.ts";
import { createApplicationGatewaySnapshot } from "../test-helpers/application-context-fixtures.ts";
import {
  createApplicationContextProvider,
  createApplicationGateway,
} from "../test-helpers/application-context.ts";
import {
  createTestGatewayClient,
  type GatewayRequestHandler,
} from "../test-helpers/gateway-client.ts";
import { installDialogPolyfill } from "../test-helpers/modal-dialog.ts";
import type { CommandPalette } from "./command-palette.tsx";

export function registerCommandPaletteTestHooks({ mockScroll = true } = {}) {
  let restoreDialogPolyfill: () => void;
  let scrollIntoViewDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    restoreDialogPolyfill = installDialogPolyfill();
    scrollIntoViewDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");
    if (mockScroll) {
      Object.defineProperty(Element.prototype, "scrollIntoView", {
        configurable: true,
        value: vi.fn(),
      });
    }
  });

  afterEach(() => {
    document.body.replaceChildren();
    restoreDialogPolyfill();
    if (scrollIntoViewDescriptor) {
      Object.defineProperty(Element.prototype, "scrollIntoView", scrollIntoViewDescriptor);
    } else {
      delete (Element.prototype as Partial<Element>).scrollIntoView;
    }
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
}

export function createGateway(
  connected: boolean,
  options: { methods?: string[]; request?: GatewayRequestHandler } = {},
) {
  const request =
    options.request ??
    ((method: string) =>
      method === "sessions.search" ? { results: [], sessions: [] } : { models: [] });
  const client = createTestGatewayClient((...args) => {
    // Creation catalogs must not consume scripted search replies.
    if (args[0] === "environments.list") {
      return { environments: [], profiles: [] };
    }
    if (
      args[0] === "agents.list" &&
      args[1] &&
      typeof args[1] === "object" &&
      "includeSessionPlacement" in args[1] &&
      args[1].includeSessionPlacement === true
    ) {
      return { agents: [], sessionPlacement: {} };
    }
    return request(...args);
  });
  const { gateway, publish, publishEvent } = createApplicationGateway(
    createApplicationGatewaySnapshot({
      client,
      phase: connected ? "connected" : "reconnecting",
      hello: options.methods ? ({ features: { methods: options.methods } } as never) : null,
      assistantAgentId: "main",
      sessionKey: "main",
    }),
  );
  Object.assign(gateway, {
    connection: { gatewayUrl: "ws://localhost", token: "", bootstrapToken: "", password: "" },
    setSessionKey: () => undefined,
  });
  return {
    gateway,
    emit(this: void, event: string, payload: unknown = {}) {
      if (event === "cron" || event === "config.changed") {
        invalidateCronCatalog(client);
      }
      const invalidation = modelCatalogEventInvalidation({ event, payload });
      if (invalidation) {
        invalidateChatMetadataStore(client, undefined, undefined, invalidation);
      }
      publishEvent({ type: "event", event, payload });
    },
    setConnected(this: void, nextConnected: boolean) {
      if (!nextConnected) {
        invalidateCronCatalog(client);
        invalidateChatMetadataStore(client);
      }
      publish({
        ...gateway.snapshot,
        phase: nextConnected ? "connected" : "reconnecting",
      });
    },
  };
}

export function createContext(
  gateway: ApplicationGateway,
  list: ApplicationContext["sessions"]["list"] = vi.fn(async () => null),
): ApplicationContext {
  const agents = createAgentCapability(gateway);
  // Search scenarios acquire their own roster without triggering creation reads.
  agents.ensureList = async () => null;
  const agentSelection = createAgentSelectionCapability(gateway, agents);
  onTestFinished(() => {
    agentSelection.dispose();
    agents.dispose();
  });
  return {
    gateway,
    config: createApplicationConfigCapability({ resourceBasePath: "" }),
    agentSelection,
    agents,
    agentIdentity: createAgentIdentityCapability(gateway),
    sessions: {
      list,
      state: { result: null },
      subscribe: () => () => undefined,
    },
  } as unknown as ApplicationContext;
}

export function createSessionResult(key: string, displayName: string): SessionsListResult {
  return {
    ts: 1,
    path: "",
    count: 1,
    defaults: {},
    sessions: [{ key, kind: "direct", displayName, updatedAt: 1 }],
  } as SessionsListResult;
}

export function transcriptResult(
  roster: SessionsListResult,
  snippet: string,
): SessionsSearchResult {
  const sessionKey = roster.sessions[0]!.key;
  return {
    sessions: roster.sessions,
    results: [
      {
        sessionKey,
        sessionId: sessionKey.split(":").at(-1)!,
        messageId: "message",
        role: "assistant",
        timestamp: 1,
        score: 1,
        snippet,
      },
    ],
  };
}

export async function mountPalette(context = createContext(createGateway(true).gateway)) {
  const provider = createApplicationContextProvider(context);
  const palette = document.createElement("openclaw-command-palette") as CommandPalette;
  palette.onNavigate = vi.fn();
  palette.onSelectSession = vi.fn();
  provider.append(palette);
  document.body.append(provider);
  await palette.updateComplete;
  const query = palette.querySelector.bind(palette);
  const queryAll = palette.querySelectorAll.bind(palette);
  return { palette, provider, query, queryAll };
}

export async function mountSearch(
  options: Parameters<typeof createGateway>[1] = {},
  list: ApplicationContext["sessions"]["list"] = vi.fn(async () => null),
) {
  const harness = createGateway(true, options);
  const context = createContext(harness.gateway, list);
  return { ...harness, context, ...(await mountPalette(context)) };
}

export function prepareDraftContext(context: ApplicationContext) {
  const connection = createApplicationGateway(context.gateway.snapshot);
  Object.assign(connection.gateway, {
    connectionRevision: 1,
    connection: context.gateway.connection,
    setSessionKey: context.gateway.setSessionKey,
  });
  const webPush = createWebPushCapability(connection.gateway);
  onTestFinished(() => webPush.dispose());
  Object.assign(context, {
    gateway: connection.gateway,
    webPush,
    navigate: vi.fn(),
    agentIdentity: {
      subscribe: () => () => {},
      ensure: vi.fn(async () => {}),
      get: () => undefined,
    },
  });
  Object.assign(context.agentSelection, { subscribe: () => () => {} });
  Object.assign(context.agents.state, { connected: true, client: context.gateway.snapshot.client });
  Object.assign(context.sessions, { list: vi.fn(async () => null) });
  return () => connection.publish(context.gateway.snapshot);
}

export async function enterQuery(palette: CommandPalette, query: string) {
  await openPalette(palette);
  setInputValue(paletteInput(palette), query, true);
  await palette.updateComplete;
}

export async function openPalette(palette: CommandPalette) {
  palette.openPalette();
  await palette.updateComplete;
}

export async function searchPalette(palette: CommandPalette, query: string) {
  await enterQuery(palette, query);
  await settlePalette(palette);
}

export const paletteInput = (palette: CommandPalette) =>
  palette.querySelector<HTMLTextAreaElement>(".cmd-palette__input")!;

export function setInputValue(input: HTMLTextAreaElement, value: string, composed = false) {
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true, composed }));
}

export function pressKey(input: HTMLTextAreaElement, key: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { bubbles: true, key, ...init });
  input.dispatchEvent(event);
  return event;
}

export async function settlePalette(palette: CommandPalette, ms = 200) {
  await vi.advanceTimersByTimeAsync(ms);
  await palette.updateComplete;
}

export function expectPalettePromptMode(palette: CommandPalette) {
  const searchPanel = palette.querySelector('[inert][aria-hidden="true"]');
  expect(searchPanel).not.toBeNull();
  const input = palette.querySelector<HTMLTextAreaElement>(".cmd-palette__input")!;
  expect(input.hasAttribute("aria-controls")).toBe(false);
  expect(input.hasAttribute("aria-activedescendant")).toBe(false);
  expect(input.closest("[inert]")).toBeNull();
  for (const searchElement of palette.querySelectorAll(
    ".cmd-palette__filters, .cmd-palette__results, .cmd-palette__source-error, .cmd-palette__empty, .cmd-palette__no-results",
  )) {
    expect(searchElement.closest('[inert][aria-hidden="true"]')).toBe(searchPanel);
  }
}

export function findPaletteOption(palette: CommandPalette, label: string, exact = false) {
  return [...palette.querySelectorAll<HTMLElement>('[role="option"]')].find((item) => {
    const text = item.textContent?.replace(/\s+/g, " ").trim();
    return exact ? text === label : text?.includes(label);
  });
}
