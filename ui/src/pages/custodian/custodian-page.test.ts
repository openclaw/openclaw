/* @vitest-environment jsdom */

import { GatewayProtocolRequestError } from "@openclaw/gateway-client/browser";
import {
  buildSystemAgentSessionInvalidatedErrorDetails,
  type SystemAgentChatResult,
  type SystemChangesListResult,
} from "@openclaw/gateway-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ChannelsStatusSnapshot } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { channelSnapshotEntryIsActive, createChannelCapability } from "../../lib/channels/index.ts";
import * as uuid from "../../lib/uuid.ts";
import { createApplicationContextProvider } from "../../test-helpers/application-context.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { createContext, mountPage } from "./custodian-page.test-harness.ts";
import { CustodianSessionStore } from "./custodian-session-store.ts";

type Reply = SystemAgentChatResult;
const historyMethods = ["openclaw.chat", "openclaw.chat.history"];
const password = 'input[type="password"]';
const onboardingNudge = ".custodian__nudge--channel-onboarding";
function responses(...values: unknown[]) {
  const request = vi.fn();
  for (const value of values) {
    if (value instanceof Error) {
      request.mockRejectedValueOnce(value);
    } else {
      request.mockResolvedValueOnce(value);
    }
  }
  return request;
}
function expectMethods(request: Parameters<typeof createContext>[0], ...methods: string[]) {
  expect(request.mock.calls.map(([method]) => method)).toEqual(methods);
}
function expectText(page: HTMLElement, present: string[], absent: string[] = []) {
  for (const text of present) {
    expect(page.textContent).toContain(text);
  }
  for (const text of absent) {
    expect(page.textContent).not.toContain(text);
  }
}
const sawText = (page: HTMLElement, text: string) =>
  waitForFast(() => expect(page.textContent).toContain(text));
const called = (request: Parameters<typeof createContext>[0], count: number) =>
  waitForFast(() => expect(request).toHaveBeenCalledTimes(count));
function chatReply(reply: string, patch: Partial<Reply> = {}): Reply {
  return { sessionId: "custodian-session", reply, action: "none", ...patch };
}

function history(...turns: Array<["user" | "assistant", string, number]>) {
  return { turns: turns.map(([role, text, at]) => ({ role, text, at })) };
}

function channelSnapshot(patch: Partial<ChannelsStatusSnapshot> = {}): ChannelsStatusSnapshot {
  return {
    ts: 1_700_000_000_000,
    channelOrder: ["telegram"],
    channelLabels: { telegram: "Telegram" },
    channels: { telegram: { configured: false, running: false, connected: false } },
    channelAccounts: { telegram: [] },
    channelDefaultAccountId: {},
    ...patch,
  };
}
function channelHarness(status: Parameters<typeof createContext>[0]) {
  const harness = createContext(
    vi.fn((method: string) =>
      method === "channels.status" ? status() : Promise.resolve(chatReply("Ready.")),
    ),
  );
  const channels = createChannelCapability(harness.context.gateway);
  Object.assign(harness.context, { channels });
  return { ...harness, channels };
}
function change(
  id: string,
  age: number,
  summary: string,
  patch: Partial<SystemChangesListResult["entries"][number]> = {},
): SystemChangesListResult["entries"][number] {
  return {
    id,
    at: Date.now() - age,
    kind: "config-write",
    source: "config-rpc",
    summary,
    ...patch,
  };
}

type Page = Awaited<ReturnType<typeof mountPage>>["page"];
function button(page: HTMLElement, selector: string) {
  return page.querySelector<HTMLButtonElement>(selector)!;
}
async function element<T extends HTMLElement>(page: HTMLElement, selector: string): Promise<T> {
  return waitForFast(() => {
    const found = page.querySelector<T>(selector);
    expect(found).not.toBeNull();
    return found!;
  });
}
async function mount(request: Parameters<typeof createContext>[0], methods?: string[]) {
  const harness = createContext(request, methods);
  return { ...harness, ...(await mountPage(harness.context)) };
}
async function fill(page: Page, selector: string, value: string) {
  const field = await element<HTMLInputElement | HTMLTextAreaElement>(page, selector);
  field.value = value;
  field.dispatchEvent(new InputEvent("input", { bubbles: true }));
  await page.updateComplete;
  return field;
}
async function send(page: Page, value: string, selector = "textarea") {
  const input = await fill(page, selector, value);
  button(page, ".chat-send-btn").click();
  return input;
}

describe("custodian page", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.spyOn(uuid, "generateUUID").mockReturnValue("00000000-0000-4000-8000-000000000001");
    window.history.replaceState({}, "", "/");
  });

  afterEach(() => {
    localStorage.clear();
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("refreshes durable rows for a same-ownership client replacement", async () => {
    let historyCalls = 0;
    const request = vi.fn(async (method: string, _params?: unknown) => {
      if (method === "openclaw.chat.history") {
        historyCalls += 1;
        return historyCalls === 1
          ? history(["user", "Earlier state", 1])
          : history(["user", "Earlier state", 1], ["assistant", "Completed while away", 2]);
      }
      if (method === "openclaw.chat") {
        return chatReply("Live welcome");
      }
      throw new Error(`unexpected request ${method}`);
    });
    const { page, setGatewaySnapshot } = await mount(request, historyMethods);
    await called(request, 2);

    setGatewaySnapshot({ client: { request } as unknown as GatewayBrowserClient });
    await sawText(page, "Completed while away");

    expectMethods(request, "openclaw.chat.history", "openclaw.chat", "openclaw.chat.history");
    expect(page.querySelector(".chat-group.user")?.textContent).toContain("Earlier state");
    expect(page.textContent).not.toContain("Live welcome");
  });

  it("resolves a pending ordinary turn from durable history after client replacement", async () => {
    const pending = createDeferred<Reply>();
    const request = responses({ turns: [] }, chatReply("Welcome."), pending.promise);
    const replacementRequest = vi.fn((method: string, params: { sessionId?: string }) =>
      Promise.resolve(
        method === "openclaw.chat.history"
          ? history(["user", "check this system", 1], ["assistant", "System check completed", 2])
          : chatReply("Welcome back.", { sessionId: params.sessionId }),
      ),
    );
    const { page, setGatewaySnapshot } = await mount(request, historyMethods);
    await called(request, 2);
    await send(page, "check this system");
    await called(request, 3);
    expect(request.mock.calls[2]?.[1]).toMatchObject({
      sessionId: "custodian-session",
      message: "check this system",
    });
    setGatewaySnapshot({
      client: { request: replacementRequest } as unknown as GatewayBrowserClient,
    });
    await sawText(page, "System check completed");
    expectMethods(replacementRequest, "openclaw.chat.history", "openclaw.chat");
    expect(replacementRequest.mock.calls[1]?.[1]).toMatchObject({ sessionId: "custodian-session" });
    expect(replacementRequest.mock.calls[1]?.[1]).not.toHaveProperty("message");
    expect(page.querySelector('[role="alert"]')).toBeNull();
    pending.resolve(chatReply("Stale old-client reply."));
    await pending.promise;
    await page.updateComplete;
    expect(page.textContent).not.toContain("Stale old-client reply.");
    expect(page.textContent).toContain("System check completed");
  });

  it("keeps loaded transcript rows while retrying the welcome without reloading history", async () => {
    const request = responses(
      history(["assistant", "Loaded transcript row", 1]),
      new Error("temporary welcome failure"),
      chatReply("Recovered welcome.", { sessionId: "engine-session-after-retry" }),
    );
    const { page } = await mount(request, historyMethods);
    await waitForFast(() => expect(page.querySelector('[role="alert"] button')).not.toBeNull());

    button(page, '[role="alert"] button').click();
    await sawText(page, "Recovered welcome.");

    expectMethods(request, "openclaw.chat.history", "openclaw.chat", "openclaw.chat");
    expect(page.textContent).toContain("Loaded transcript row");
  });

  it("keeps a sent sensitive reply masked when its response fails", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(chatReply("Enter the token.", { sensitive: true }))
      .mockImplementationOnce((_method, _params, options?: { onSent?: () => void }) => {
        options?.onSent?.();
        return Promise.reject(new Error("Request failed"));
      });
    const { page } = await mount(request);
    await called(request, 1);
    await page.updateComplete;
    const input = await send(page, " test-token-placeholder ", password);

    await called(request, 2);
    await waitForFast(() => expect(page.querySelector('[role="alert"]')).not.toBeNull());
    await page.updateComplete;
    expect(input).toMatchObject({ isConnected: true, value: "" });
    expect(request.mock.calls[1]?.[1]?.message).toBe(" test-token-placeholder ");
    expect(page.textContent).toContain("Sensitive reply sent");
    expect(page.innerHTML).not.toContain("test-token-placeholder");
  });

  it("clears stale rows and cold-starts against the new gateway after credentials change", async () => {
    const request = responses(
      history(["assistant", "Old gateway transcript", 1]),
      chatReply("Enter the token.", {
        sessionId: "engine-session-before-rotation",
        sensitive: true,
      }),
      createDeferred<never>().promise,
    );
    const replacementRequest = responses(
      history(["assistant", "New gateway transcript", 2]),
      chatReply("Fresh safe welcome.", { sessionId: "engine-session-after-rotation" }),
    );
    const { context, setGatewaySnapshot, setGatewayToken, emitGatewayEvent } = createContext(
      request,
      ["openclaw.chat", "openclaw.chat.history"],
    );
    const { page } = await mountPage(context, { onboarding: false });
    await called(request, 2);

    await send(page, "test-token-placeholder", password);
    await called(request, 3);

    emitGatewayEvent({
      event: "health",
      payload: { channels: { telegram: { configured: true, running: true, connected: false } } },
    });
    await page.updateComplete;
    expect(page.querySelector(".custodian__nudge")).not.toBeNull();
    setGatewayToken("new-operator-token");
    setGatewaySnapshot({
      client: createContext(replacementRequest, historyMethods).context.gateway.snapshot.client,
    });
    await called(replacementRequest, 2);
    await sawText(page, "Fresh safe welcome.");

    expect(request.mock.calls[2]?.[1]).toMatchObject({
      sessionId: "engine-session-before-rotation",
      message: "test-token-placeholder",
    });
    expectMethods(replacementRequest, "openclaw.chat.history", "openclaw.chat");
    expect(replacementRequest.mock.calls[1]?.[1]).toMatchObject({
      sessionId: expect.stringMatching(/^control-ui-onboarding-/),
    });
    expect(replacementRequest.mock.calls[1]?.[1]).not.toHaveProperty("message");
    expect(replacementRequest.mock.calls[1]?.[1]).not.toMatchObject({
      sessionId: "engine-session-before-rotation",
    });
    expectText(
      page,
      ["New gateway transcript"],
      ["Old gateway transcript", "Enter the token.", "Sensitive reply sent"],
    );
    expect(page.querySelector(password)).toBeNull();
    expect(page.innerHTML).not.toContain("test-token-placeholder");
    expect(page.querySelector(".custodian__nudge")).toBeNull();
    emitGatewayEvent({
      event: "health",
      payload: { configReload: { hotReloadStatus: "disabled" }, channels: {} },
    });
    await page.updateComplete;
    expect(page.querySelector(".custodian__nudge")?.textContent).toContain(
      "Configuration reload stopped",
    );
  });

  it("preserves a prepared literal marker alongside a structured question", async () => {
    const request = vi.fn().mockResolvedValue(
      chatReply("NO_REPLY", {
        question: {
          id: "channel",
          header: "Channel",
          question: "Which channel?",
          options: [{ label: "WhatsApp" }, { label: "Telegram" }],
        },
      }),
    );
    const { page } = await mount(request);
    await called(request, 1);
    await page.updateComplete;

    expect(page.querySelector(".chat-read-aloud-btn")).toBeNull();
    expect(page.querySelector(".chat-group.assistant")).not.toBeNull();
    expect(page.querySelector("openclaw-option-card")).not.toBeNull();
    expectText(page, ["Which channel?", "NO_REPLY"]);
  });

  it("keeps replacement-connection history when the previous request finishes late", async () => {
    const pending = createDeferred<SystemChangesListResult>();
    const request = vi.fn((method: string) =>
      method === "openclaw.changes.list" ? pending.promise : Promise.resolve(chatReply("Ready.")),
    );
    const harness = createContext(request, ["openclaw.chat", "openclaw.changes.list"]);
    const { page } = await mountPage(harness.context, { onboarding: false });
    button(page, ".custodian__history-toggle").click();
    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith("openclaw.changes.list", { limit: 50 }),
    );

    const entry = {
      id: "config-audit:replacement",
      at: 1_700_000_000_000,
      kind: "config-write" as const,
      source: "config-rpc" as const,
      summary: "Replacement connection history",
    };
    const nextRequest = vi.fn(async (method: string) =>
      method === "openclaw.chat.history"
        ? { turns: [] }
        : method === "openclaw.changes.list"
          ? { entries: [entry] }
          : chatReply("Ready."),
    );
    harness.setGatewaySnapshot({
      // SAFETY: This fixture supplies the request method used by the mounted page.
      client: { request: nextRequest } as unknown as GatewayBrowserClient,
    });
    await waitForFast(() => expect(page.querySelector(".custodian__history")).toBeNull());
    button(page, ".custodian__history-toggle").click();
    await waitForFast(() =>
      expect(page.querySelector(".custodian__history")?.textContent).toContain(entry.summary),
    );
    pending.resolve({
      entries: [{ ...entry, id: "config-audit:old", summary: "Retired history" }],
    });
    await pending.promise;
    await page.updateComplete;
    expect(page.querySelectorAll(".custodian__change-card")).toHaveLength(1);
    expect(page.querySelector(".custodian__history")?.textContent).toContain(entry.summary);
    expect(page.querySelector(".custodian__history")?.textContent).not.toContain("Retired history");
  });
  it("shows optional channel setup after first-run model setup and consumes dismissal", async () => {
    const request = vi.fn().mockResolvedValue(chatReply("Your AI is ready."));
    const { context, setChannelsSnapshot, setChannelsConnected } = createContext(
      request,
      ["openclaw.chat"],
      {
        channelsSnapshot: channelSnapshot(),
      },
    );
    const { page } = await mountPage(context, { onboarding: true });
    await called(request, 1);

    const nudge = page.querySelector(onboardingNudge);
    expect(nudge?.textContent).toContain("Reach OpenClaw outside this app");
    expect(nudge?.textContent).toContain("The web app already works");

    page.querySelector<HTMLButtonElement>('button[aria-label="Keep using the web app"]')?.click();
    await page.updateComplete;

    setChannelsSnapshot(null);
    setChannelsConnected(false);
    setChannelsConnected(true);
    expect(context.channels.refresh).not.toHaveBeenCalled();
    expect(context.replace).toHaveBeenCalledWith("custodian");
    expect(page.querySelector(onboardingNudge)).toBeNull();
  });

  it("awaits fresh channel status after reconnecting with a stale successful snapshot and error", async () => {
    const freshStatus = createDeferred<ChannelsStatusSnapshot>();
    const status = responses(channelSnapshot(), new Error("status unavailable")).mockReturnValue(
      freshStatus.promise,
    );
    const { context, channels, setGatewaySnapshot } = channelHarness(status);
    await channels.refresh();
    await channels.refresh();
    const previousSnapshot = channels.state.channelsSnapshot;
    expect(channels.state.channelsSnapshot).not.toBeNull();
    expect(channels.state.channelsError).toBe("status unavailable");
    const { page } = await mountPage(context, { onboarding: true });

    setGatewaySnapshot({ phase: "reconnecting" });
    setGatewaySnapshot({ phase: "connected" });

    await called(status, 3);
    expect(channels.state.channelsSnapshot).toBe(previousSnapshot);
    expect(channels.state.channelsLoading).toBe(true);
    expect(page.querySelector(onboardingNudge)).toBeNull();

    freshStatus.resolve(
      channelSnapshot({
        channels: { telegram: { configured: true, running: true, connected: true } },
      }),
    );
    await waitForFast(() => expect(channels.state.channelsLoading).toBe(false));
    expect(channelSnapshotEntryIsActive(channels.state.channelsSnapshot, "telegram")).toBe(true);
    expect(page.querySelector(onboardingNudge)).toBeNull();
    channels.dispose();
  });

  it("keeps retry feedback visible until a deferred channel refresh succeeds", async () => {
    const retryStatus = createDeferred<ChannelsStatusSnapshot>();
    const status = responses(new Error("status unavailable")).mockReturnValue(retryStatus.promise);
    const { context, channels } = channelHarness(status);
    await channels.refresh();
    const { page } = await mountPage(context, { onboarding: true });

    const retry = page.querySelector<HTMLButtonElement>(".custodian__nudge-cta");
    expect(retry?.textContent).toContain("Retry");
    retry?.click();

    await called(status, 2);
    await page.updateComplete;
    expect(channels.state.channelsLoading).toBe(true);
    expect(channels.state.channelsError).toBe("status unavailable");
    expect(page.querySelector('[role="alert"]')).not.toBeNull();
    expect(page.querySelector<HTMLButtonElement>(".custodian__nudge-cta")?.disabled).toBe(true);
    expect(page.querySelector(".custodian__nudge-cta")?.textContent).toContain("Loading");

    retryStatus.resolve(
      channelSnapshot({
        channelAccounts: { telegram: [{ accountId: "work", configured: false, connected: true }] },
      }),
    );
    await waitForFast(() => expect(channels.state.channelsLoading).toBe(false));
    expect(channels.state.channelsError).toBeNull();
    expect(page.querySelector(onboardingNudge)).toBeNull();
    channels.dispose();
  });

  it("shows advertised recent changes and loads a short cursor page inline", async () => {
    const entries = [
      change("system-agent-audit:3", 5_000, "Set config gateway.port", {
        kind: "operation",
        source: "system-agent",
        changedPaths: ["gateway.port"],
      }),
      change("config-audit:2", 10_000, "Configuration edited outside OpenClaw", {
        kind: "external-edit",
        source: "external",
        invalid: true,
        opaqueChange: true,
      }),
      change("config-audit:0", 15_000, "Plugin installation updated configuration", {
        source: "plugin-install",
      }),
    ];
    const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === "openclaw.chat") {
        return chatReply("Hello.");
      }
      if (method === "openclaw.changes.list" && !params.beforeCursor) {
        return {
          entries,
          nextCursor: "next-page",
        };
      }
      if (method === "openclaw.changes.list" && params.beforeCursor === "next-page") {
        return {
          entries: [
            change(
              "config-audit:1",
              20_000,
              "Settings updated configuration: agents.defaults.model",
            ),
          ],
        };
      }
      throw new Error(`unexpected request ${method}`);
    });
    const harness = createContext(request, ["openclaw.chat", "openclaw.changes.list"]);
    const { context } = harness;
    const { page } = await mountPage(context, { onboarding: false });
    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith("openclaw.chat", expect.anything(), expect.anything()),
    );
    await page.updateComplete;

    button(page, ".custodian__history-toggle").click();
    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith("openclaw.changes.list", { limit: 50 }),
    );
    await page.updateComplete;

    await waitForFast(() =>
      expect(page.querySelectorAll(".custodian__change-card")).toHaveLength(3),
    );
    // Continuation follows the cursor, even for a short page.
    expect(page.querySelector(".custodian__history-more")).not.toBeNull();
    expect(page.querySelector(".custodian__change-source")?.textContent).toContain("system-agent");
    expect(page.querySelector(".custodian__change-paths")?.hasAttribute("open")).toBe(false);
    expect(page.querySelector(".custodian__change-card.is-invalid")?.textContent).toContain(
      "did not pass configuration validation",
    );
    expect(page.querySelector(".custodian__change-card.is-invalid")?.textContent).toContain(
      "Formatting or comments changed",
    );
    expect(
      Array.from(page.querySelectorAll(".custodian__change-source")).map((node) =>
        node.textContent?.trim(),
      ),
    ).toContain("plugin install");

    button(page, ".custodian__history-more").click();
    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith("openclaw.changes.list", {
        limit: 50,
        beforeCursor: "next-page",
      }),
    );
    await page.updateComplete;
    await waitForFast(() =>
      expect(page.querySelectorAll(".custodian__change-card")).toHaveLength(4),
    );
    expect(page.querySelector(".custodian__history-more")).toBeNull();

    button(page, ".custodian__history-toggle").click();
    await page.updateComplete;
    button(page, ".custodian__history-toggle").click();
    await waitForFast(() =>
      expect(
        request.mock.calls.filter(
          ([method, params]) => method === "openclaw.changes.list" && !params.beforeCursor,
        ),
      ).toHaveLength(2),
    );
    await page.updateComplete;
    await waitForFast(() =>
      expect(page.querySelectorAll(".custodian__change-card")).toHaveLength(3),
    );

    harness.setGatewaySnapshot({
      client: { request } as unknown as GatewayBrowserClient,
    });
    await waitForFast(() => expect(page.querySelector(".custodian__history")).toBeNull());
    expect(page.querySelector(".custodian__history-toggle")?.getAttribute("aria-expanded")).toBe(
      "false",
    );
  });
  it.each([
    { pathname: "/settings/channels", expectedPage: "channels" },
    { pathname: "/not-an-openclaw-route", expectedPage: undefined },
  ])(
    "adds resolved page context only to user turns at $pathname",
    async ({ pathname, expectedPage }) => {
      window.history.replaceState({}, "", pathname);
      const request = vi.fn().mockResolvedValue(chatReply("Ready."));
      const { page } = await mount(request);
      await called(request, 1);
      expect(request.mock.calls[0]?.[1]).not.toHaveProperty("context");
      await send(page, "What about this page?");
      await called(request, 2);
      expect(request.mock.calls[1]?.[1]?.message).toBe("What about this page?");
      if (expectedPage) {
        expect(request.mock.calls[1]?.[1]?.context).toEqual({ page: expectedPage });
      } else {
        expect(request.mock.calls[1]?.[1]).not.toHaveProperty("context");
      }
    },
  );

  it("hides typed cancel when the Gateway does not advertise it", async () => {
    const request = vi.fn().mockResolvedValue(
      chatReply("Enter the token.", {
        sensitive: true,
        wizardInputPending: true,
        step: { id: "token", type: "text", message: "Token", sensitive: true },
      }),
    );
    const { context } = createContext(request, ["openclaw.chat"], { gatewayCapabilities: [] });
    const { page } = await mountPage(context);
    await element(page, ".custodian__wizard-step");
    expect(page.querySelector(".custodian__wizard-cancel")).toBeNull();
    page.store.cancelWizardStep(page.store.messages.at(-1)!);
    expect(request).toHaveBeenCalledOnce();
  });

  it("keeps an unanswered structured question across a same-client reconnect", async () => {
    const request = vi.fn(async (method: string) =>
      method === "openclaw.chat.history"
        ? history(["assistant", "Earlier row", 1])
        : chatReply("Choose the next step.", {
            question: {
              id: "reconnect-choice",
              header: "Next step",
              question: "What should happen next?",
              options: [{ label: "Continue" }, { label: "Pause" }],
              isOther: false,
            },
          }),
    );
    const { page, setGatewaySnapshot } = await mount(request, historyMethods);
    await called(request, 2);
    await page.updateComplete;
    expect(page.querySelector("openclaw-option-card")).not.toBeNull();
    setGatewaySnapshot({ phase: "reconnecting" });
    await page.updateComplete;
    setGatewaySnapshot({ phase: "connected" });
    await page.updateComplete;
    expectMethods(request, "openclaw.chat.history", "openclaw.chat");
    expect(page.querySelector("openclaw-option-card")).not.toBeNull();
    expect(page.textContent).toContain("Choose the next step.");
  });

  describe("agent creation", () => {
    function agentContext(request: Parameters<typeof createContext>[0]) {
      const calls: string[] = [];
      const refreshList = vi.fn().mockResolvedValue({ mainKey: "main" });
      const { context: base } = createContext(request);
      const context = {
        ...base,
        gateway: { ...base.gateway, setSessionKey: (key: string) => calls.push(`session:${key}`) },
        agents: { ...base.agents, refreshList },
        agentSelection: {
          ...base.agentSelection,
          set: (id: string | null) => calls.push(`agent:${id}`),
        },
      } satisfies ApplicationContext;
      return { calls, context, refreshList };
    }

    async function mountAgentPage(context: ApplicationContext) {
      const provider = createApplicationContextProvider(context);
      const page = document.createElement("openclaw-custodian-page");
      page.store = new CustodianSessionStore();
      page.onboarding = false;
      page.newAgentIntent = true;
      provider.append(page);
      document.body.append(provider);
      await page.updateComplete;
      return page;
    }

    let request: Parameters<typeof createContext>[0];
    let harness: ReturnType<typeof agentContext>;
    const response = {
      sessionId: "control-ui-onboarding-00000000-0000-4000-8000-000000000001",
      action: "none",
      reply: "Ready.",
    };
    beforeEach(() => {
      vi.spyOn(uuid, "generateUUID").mockReturnValue("00000000-0000-4000-8000-000000000001");
      request = vi.fn();
      harness = agentContext(request);
    });

    it("explains the missing capability and scope before sending an agent creation request", async () => {
      const { context } = harness;
      context.gateway.snapshot.hello = {
        ...context.gateway.snapshot.hello!,
        auth: { role: "operator", scopes: ["operator.read"] },
      };

      const page = await mountAgentPage(context);
      await Promise.resolve();

      expect(request).not.toHaveBeenCalled();
      const error = page.querySelector('[role="alert"]')?.textContent;
      for (const text of ["openclaw.chat", "operator.admin", "Pair", "reconnect"]) {
        expect(error).toContain(text);
      }
      expect(error).not.toContain("Update the Gateway");
    });

    it("refreshes the roster and opens the created agent hatch session", async () => {
      request.mockResolvedValue({
        ...response,
        action: "open-agent",
        agentDraft: "hatch",
        agentId: "researcher",
      });
      const { calls, context, refreshList } = harness;
      await mountAgentPage(context);

      await waitForFast(() => expect(context.navigate).toHaveBeenCalledOnce());
      expect(request).toHaveBeenCalledOnce();
      expect(request.mock.calls[0]?.[1]).toMatchObject({ welcomeVariant: "new-agent" });
      expect(refreshList).toHaveBeenCalledOnce();
      expect(calls).toEqual(["agent:researcher", "session:agent:researcher:main"]);
      expect(context.navigate).toHaveBeenCalledWith("chat", {
        pathname: "/chat/researcher",
        search: "?draft=Wake%20up%2C%20my%20friend!",
      });
    });

    it("hands model-account setup to the existing human Profile controls", async () => {
      request.mockResolvedValue({ ...response, handoff: { kind: "model-accounts" } });
      const { calls, context, refreshList } = harness;
      const client = context.gateway.snapshot.client;
      await mountAgentPage(context);

      await waitForFast(() => expect(context.navigate).toHaveBeenCalledWith("profile"));
      expect(context.gateway.snapshot.client).toBe(client);
      expect(refreshList).not.toHaveBeenCalled();
      expect(calls).toEqual([]);
      expectMethods(request, "openclaw.chat");
    });
  });
});

describe("custodian page session lifecycle", () => {
  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  const question = {
    id: "credential",
    header: "Credential",
    question: "Choose authentication.",
    options: [{ label: "Enter credential", reply: "enter" }, { label: "Use environment" }],
  };
  const step = { id: "credential", type: "text", message: "Credential", sensitive: true };
  const secret = "test-token-placeholder";
  const reply = (text: string) => ({ sessionId: "engine-session", reply: text, action: "none" });
  const invalidated = (code: "UNAVAILABLE" | "INVALID_REQUEST" = "UNAVAILABLE") =>
    new GatewayProtocolRequestError({
      code,
      message: "The live session was lost.",
      details: buildSystemAgentSessionInvalidatedErrorDetails(),
    });

  async function mountReady(request: Parameters<typeof createContext>[0]) {
    const { page } = await mount(request);
    await sawText(page, "Ready.");
    return page;
  }

  it.each([false, true])(
    "keeps the live session after a failed ordinary send (sent=%s)",
    async (sent) => {
      const request = vi
        .fn()
        .mockResolvedValueOnce(reply("Ready."))
        .mockImplementationOnce((_method, _params, options?: { onSent?: () => void }) => {
          if (sent) {
            options?.onSent?.();
          }
          return Promise.reject(
            new GatewayProtocolRequestError({
              code: "UNAVAILABLE",
              message: "Temporary request failure.",
            }),
          );
        })
        .mockResolvedValueOnce(reply("Still together."));
      const page = await mountReady(request);
      await send(page, "first try");
      await sawText(page, "Temporary request failure.");
      expect(page.querySelector<HTMLTextAreaElement>("textarea")!.value).toBe(
        sent ? "" : "first try",
      );
      expect(page.store.messages.filter((message) => message.role === "user")).toHaveLength(
        sent ? 1 : 0,
      );
      await send(page, "second try");
      await sawText(page, "Still together.");
      expect(request).toHaveBeenCalledTimes(3);
      expect(request.mock.calls[2]?.[1]).toMatchObject({
        sessionId: "engine-session",
        message: "second try",
      });
    },
  );

  it("retires sensitive input when cancelling an invalidated session", async () => {
    const request = responses(
      { ...reply("Ready."), sensitive: true, question },
      invalidated(),
      reply("Fresh session."),
    );
    const page = await mountReady(request);
    await fill(page, password, secret);
    button(page, ".option-card__skip").click();
    await sawText(page, "Fresh session.");
    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls[2]?.[1]).toMatchObject({
      sessionId: expect.stringMatching(/^control-ui-onboarding-/),
    });
    expect(request.mock.calls[2]?.[1]).not.toHaveProperty("message");
    expectText(page, ["Earlier", "started a fresh session"]);
    const composer = page.querySelector<HTMLTextAreaElement>("textarea")!;
    expect(composer.value).toBe("");
    composer.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await page.updateComplete;
    expect(request).toHaveBeenCalledTimes(3);
    expect(page.textContent).not.toContain(secret);
    expect(request.mock.calls.some(([, params]) => params.message === secret)).toBe(false);
  });

  it.each(["submit", "cancel"])(
    "clears sensitive wizard input on %s admission even if the reply fails",
    async (action) => {
      const pending = createDeferred<never>();
      const request = responses(
        { ...reply("Ready."), wizardInputPending: true, step },
        pending.promise,
      );
      const page = await mountReady(request);
      await fill(page, password, secret);
      button(
        page,
        action === "submit" ? ".custodian__wizard-step .btn.primary" : ".custodian__wizard-cancel",
      ).click();
      await called(request, 2);
      await page.updateComplete;
      expect(page.querySelector<HTMLInputElement>(password)!.value).toBe("");
      pending.reject(new Error("Temporary request failure."));
      await sawText(page, "Temporary request failure.");
      expect(page.querySelector<HTMLInputElement>(password)!.value).toBe("");
      expect(page.textContent).not.toContain(secret);
      expect(request).toHaveBeenCalledTimes(2);
      const sent = request.mock.calls[1]?.[1];
      if (action === "submit") {
        expect(sent.wizardAnswer.value).toBe(secret);
      } else {
        expect(sent).toMatchObject({
          sessionId: "engine-session",
          wizardCancel: { stepId: "credential" },
        });
        expect(sent).not.toHaveProperty("message");
        expect(JSON.stringify(sent)).not.toContain(secret);
      }
    },
  );

  it("restores an ordinary draft after a sensitive invalidated wizard", async () => {
    const request = responses(
      { ...reply("Ready."), question },
      { ...reply("Enter credential."), sensitive: true, wizardInputPending: true, step },
      invalidated(),
    ).mockResolvedValue(reply("Ready again."));
    const page = await mountReady(request);
    const draft = "Keep my ordinary question";
    await fill(page, "textarea", draft);
    button(page, ".option-card__choice").click();
    await waitForFast(() => expect(page.querySelector(password)).not.toBeNull());
    expect(page.querySelector<HTMLInputElement>(password)!.value).toBe("");
    expect(request.mock.calls[1]?.[1]?.message).toBe("enter");
    await fill(page, password, secret);
    button(page, ".custodian__wizard-cancel").click();
    await sawText(page, "Ready again.");
    const restored = page.querySelector<HTMLTextAreaElement>("textarea")!;
    expect(restored.value).toBe(draft);
    expect(page.textContent).not.toContain(secret);
    expect(request.mock.calls.some(([, params]) => params.message === secret)).toBe(false);
    expect(request.mock.calls[3]?.[1]).not.toHaveProperty("wizardCancel");
    restored.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await waitForFast(() => expect(request.mock.calls.at(-1)?.[1]?.message).toBe(draft));
    await page.updateComplete;
    expect(restored.value).toBe("");
  });

  it("starts fresh after the gateway evicts a typed wizard session", async () => {
    const request = responses(
      {
        ...reply("Ready."),
        wizardInputPending: true,
        step: {
          id: "channel",
          type: "select",
          message: "Which channel?",
          options: [
            { label: "Slack", value: "slack" },
            { label: "Twitch", value: "twitch" },
          ],
        },
      },
      invalidated("INVALID_REQUEST"),
      reply("Fresh session."),
    );
    const page = await mountReady(request);
    [...page.querySelectorAll<HTMLButtonElement>(".custodian__wizard-step button:not([disabled])")]
      .find((option) => option.textContent?.trim() === "Twitch")!
      .click();
    await sawText(page, "Fresh session.");
    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls[1]?.[1]).toMatchObject({
      sessionId: "engine-session",
      wizardAnswer: { stepId: "channel", value: "twitch" },
    });
    expect(request.mock.calls[2]?.[1]).not.toHaveProperty("message");
    expect(request.mock.calls[2]?.[1]).not.toHaveProperty("wizardAnswer");
    expect(request.mock.calls[2]?.[1]?.sessionId).not.toBe("engine-session");
    expect(page.querySelector(".custodian__wizard-step")).toBeNull();
  });

  it("stops after one rotation when the fresh session failure is also marked", async () => {
    const request = responses(reply("Ready."), invalidated(), invalidated());
    const page = await mountReady(request);
    await send(page, "status please");
    await waitForFast(() => expect(page.store.sending).toBe(false));
    expect(page.textContent).toContain("The live session was lost.");
    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls[2]?.[1]).not.toHaveProperty("message");
  });
});
