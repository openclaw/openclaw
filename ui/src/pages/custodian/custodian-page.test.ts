/* @vitest-environment jsdom */

import { GatewayProtocolRequestError } from "@openclaw/gateway-client/browser";
import {
  buildSystemAgentSessionInvalidatedErrorDetails,
  type SystemAgentChatResult,
  type SystemChangesListResult,
} from "@openclaw/gateway-protocol";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ChannelsStatusSnapshot } from "../../api/types.ts";
import { CUSTODIAN_PANEL_TOGGLE_EVENT } from "../../components/panel-toggle-contract.ts";
import { channelSnapshotEntryIsActive, createChannelCapability } from "../../lib/channels/index.ts";
import * as uuid from "../../lib/uuid.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { createContext, mountPage } from "./custodian-page.test-harness.ts";

type Reply = SystemAgentChatResult;
function chatReply(reply: string, patch: Partial<Reply> = {}): Reply {
  return { sessionId: "custodian-session", reply, action: "none", ...patch };
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

type Page = Awaited<ReturnType<typeof mountPage>>["page"];
const wizard = ".custodian__wizard-step";
const channelNudge = ".custodian__nudge--channel-onboarding";
const nudgeCta = ".custodian__nudge-cta";
const history = ".custodian__history";
const historyToggle = ".custodian__history-toggle";
const historyMore = ".custodian__history-more";
const password = 'input[type="password"]';
const question = {
  id: "credential",
  header: "Credential",
  question: "Choose authentication.",
  options: [{ label: "Enter credential", reply: "enter" }, { label: "Use environment" }],
};
const step: NonNullable<Reply["step"]> = {
  id: "credential",
  type: "text",
  message: "Credential",
  sensitive: true,
};
const secret = "test-token-placeholder";

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
async function mount(
  request: Parameters<typeof createContext>[0],
  methods?: Parameters<typeof createContext>[1],
  options?: Parameters<typeof createContext>[2],
  pageOptions?: Parameters<typeof mountPage>[1],
) {
  const harness = createContext(request, methods, options);
  return { ...harness, ...(await mountPage(harness.context, pageOptions)) };
}
function expectMethods(request: Mock, ...methods: string[]) {
  expect(request.mock.calls.map(([method]) => method)).toEqual(methods);
}
function wizardReply(reply: string, wizardStep: NonNullable<Reply["step"]>, sensitive = false) {
  return chatReply(reply, {
    sessionId: "rich-wizard-session",
    wizardInputPending: true,
    step: wizardStep,
    sensitive,
  });
}
const optionLabels = (...labels: string[]) =>
  labels.map((label) => ({ label, value: label.toLowerCase() }));
function replies(...values: unknown[]) {
  const request = vi.fn();
  for (const value of values) {
    request.mockResolvedValueOnce(value);
  }
  return request;
}
function expectFreshSession(request: Mock, index: number) {
  expect(request.mock.calls[index]?.[1]).toMatchObject({
    sessionId: expect.stringMatching(/^control-ui-onboarding-/),
  });
  expect(request.mock.calls[index]?.[1]).not.toHaveProperty("message");
}
const historyMethods = ["openclaw.chat", "openclaw.chat.history"];
const changesMethods = ["openclaw.chat", "openclaw.changes.list"];
function historyRows(...turns: Array<["user" | "assistant", string, number]>) {
  return { turns: turns.map(([role, text, at]) => ({ role, text, at })) };
}
function change(
  id: string,
  summary: string,
  patch: Partial<SystemChangesListResult["entries"][number]> = {},
) {
  return {
    id,
    summary,
    at: 1_700_000_000_000,
    kind: "config-write" as const,
    source: "config-rpc" as const,
    ...patch,
  };
}
async function send(page: Page, text: string) {
  await fill(page, "textarea", text);
  button(page, ".chat-send-btn").click();
}
function expectWizardAnswer(request: Mock, index: number, stepId: string, value: unknown) {
  expect(request.mock.calls[index]?.[1]).toMatchObject({ wizardAnswer: { stepId, value } });
  expect(request.mock.calls[index]?.[1]).not.toHaveProperty("message");
}
async function fill(page: Page, selector: string, value: string) {
  const field = await element<HTMLInputElement | HTMLTextAreaElement>(page, selector);
  field.value = value;
  field.dispatchEvent(new InputEvent("input", { bubbles: true }));
  await page.updateComplete;
  return field;
}

beforeEach(() => {
  // Start each page with a fresh session identity.
  localStorage.clear();
  vi.spyOn(uuid, "generateUUID").mockReturnValue("00000000-0000-4000-8000-000000000001");
  window.history.replaceState({}, "", "/");
});

afterEach(() => {
  localStorage.clear();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("custodian page", () => {
  it("renders and answers rich select, multiselect, and sensitive text wizard steps", async () => {
    const request = replies(
      wizardReply("Choose a channel.", {
        id: "channel",
        type: "select",
        message: "Which channel?",
        options: optionLabels("Discord", "Slack", "Telegram", "WhatsApp", "Twitch"),
      }),
      wizardReply("Choose features.", {
        id: "features",
        type: "multiselect",
        message: "Which features?",
        options: optionLabels("Chat", "Moderation", "Announcements"),
      }),
      wizardReply(
        "Enter the secret.",
        { ...step, id: "secret", message: "Twitch client secret" },
        true,
      ),
      chatReply("Setup complete.", { sessionId: "rich-wizard-session" }),
    );
    const { page } = await mount(request);

    expect(page.querySelector(".chat-read-aloud-btn")).toBeNull();

    const trigger = await element<HTMLButtonElement>(page, `${wizard} .picker-select__trigger`);
    expect(page.querySelector("openclaw-option-card")).toBeNull();
    expect(page.querySelector(".agent-chat__composer-shell")).toBeNull();
    trigger.click();
    await waitForFast(() =>
      expect(page.querySelectorAll('.custodian__wizard-step [role="option"]')).toHaveLength(5),
    );
    [...page.querySelectorAll<HTMLElement>('.custodian__wizard-step [role="option"]')]
      .find((option) => option.textContent?.includes("Twitch"))!
      .click();

    await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));
    await waitForFast(() =>
      expect(page.querySelectorAll(`${wizard} input[type="checkbox"]`)).toHaveLength(3),
    );
    expectWizardAnswer(request, 1, "channel", "twitch");
    for (const index of [0, 2]) {
      page.querySelectorAll<HTMLInputElement>(`${wizard} input[type="checkbox"]`)[index]!.click();
      await page.updateComplete;
    }
    button(page, `${wizard} .btn.primary`).click();

    await waitForFast(() => expect(request).toHaveBeenCalledTimes(3));
    const secretInput = await element<HTMLInputElement>(page, "#custodian-wizard-input-5");
    expect(request.mock.calls[2]?.[1]).toMatchObject({
      wizardAnswer: { stepId: "features", value: ["chat", "announcements"] },
    });
    expect(secretInput.type).toBe("password");
    const revealSecret = page.querySelector<HTMLButtonElement>(
      `${wizard} button[aria-label="Reveal value"]`,
    );
    expect(revealSecret).not.toBeNull();
    revealSecret!.click();
    await page.updateComplete;
    const revealedInput = page.querySelector<HTMLInputElement>("#custodian-wizard-input-5")!;
    expect(revealedInput.type).toBe("text");
    await fill(page, "#custodian-wizard-input-5", "fake-client-secret");
    button(page, `${wizard} .btn.primary`).click();

    await waitForFast(() => expect(request).toHaveBeenCalledTimes(4));
    await waitForFast(() => expect(page.textContent).toContain("Setup complete."));
    expectWizardAnswer(request, 3, "secret", "fake-client-secret");
    expect(page.textContent).toContain("Twitch");
    expect(page.textContent).toContain("Chat, Announcements");
    expect(page.textContent).toContain("Sensitive reply sent");
    expect(page.textContent).not.toContain("fake-client-secret");
    expect(page.querySelector(".agent-chat__composer-shell")).not.toBeNull();
  });

  it("refreshes durable rows for a same-ownership client replacement", async () => {
    let historyCalls = 0;
    const request = vi.fn(async (method: string, _params?: unknown) => {
      if (method === "openclaw.chat.history") {
        historyCalls += 1;
        return {
          turns:
            historyCalls === 1
              ? [{ role: "user", text: "Earlier state", at: 1 }]
              : [
                  { role: "user", text: "Earlier state", at: 1 },
                  { role: "assistant", text: "Completed while away", at: 2 },
                ],
        };
      }
      if (method === "openclaw.chat") {
        return chatReply("Live welcome");
      }
      throw new Error(`unexpected request ${method}`);
    });
    const { page, setGatewaySnapshot } = await mount(request, historyMethods);
    await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));

    setGatewaySnapshot({ client: { request } as unknown as GatewayBrowserClient });
    await waitForFast(() => expect(page.textContent).toContain("Completed while away"));

    expectMethods(request, "openclaw.chat.history", "openclaw.chat", "openclaw.chat.history");
    expect(page.querySelector(".chat-group.user")?.textContent).toContain("Earlier state");
    expect(page.textContent).not.toContain("Live welcome");
  });

  it("resolves a pending ordinary turn from durable history after client replacement", async () => {
    const pending = createDeferred<Reply>();
    const request = replies({ turns: [] }, chatReply("Welcome."), pending.promise);
    const replacementRequest = vi.fn((method: string, params: { sessionId?: string }) =>
      Promise.resolve(
        method === "openclaw.chat.history"
          ? historyRows(
              ["user", "check this system", 1],
              ["assistant", "System check completed", 2],
            )
          : chatReply("Welcome back.", { sessionId: params.sessionId }),
      ),
    );
    const { page, setGatewaySnapshot } = await mount(request, historyMethods);
    await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));
    await send(page, "check this system");
    await waitForFast(() => expect(request).toHaveBeenCalledTimes(3));
    expect(request.mock.calls[2]?.[1]).toMatchObject({
      sessionId: "custodian-session",
      message: "check this system",
    });
    setGatewaySnapshot({
      client: { request: replacementRequest } as unknown as GatewayBrowserClient,
    });
    await waitForFast(() => expect(page.textContent).toContain("System check completed"));
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
    const request = vi
      .fn()
      .mockResolvedValueOnce(historyRows(["assistant", "Loaded transcript row", 1]))
      .mockRejectedValueOnce(new Error("temporary welcome failure"))
      .mockResolvedValueOnce(
        chatReply("Recovered welcome.", { sessionId: "engine-session-after-retry" }),
      );
    const { page } = await mount(request, historyMethods);
    await waitForFast(() => expect(page.querySelector('[role="alert"] button')).not.toBeNull());

    button(page, '[role="alert"] button').click();
    await waitForFast(() => expect(page.textContent).toContain("Recovered welcome."));

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
    await waitForFast(() => expect(request).toHaveBeenCalledTimes(1));
    await page.updateComplete;
    const input = await fill(page, password, " test-token-placeholder ");
    button(page, ".chat-send-btn").click();

    await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));
    await waitForFast(() => expect(page.querySelector('[role="alert"]')).not.toBeNull());
    await page.updateComplete;
    expect(input.isConnected).toBe(true);
    expect(input.value).toBe("");
    expect(request.mock.calls[1]?.[1]?.message).toBe(" test-token-placeholder ");
    expect(page.textContent).toContain("Sensitive reply sent");
    expect(page.innerHTML).not.toContain("test-token-placeholder");
  });

  it("clears stale rows and cold-starts against the new gateway after credentials change", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(historyRows(["assistant", "Old gateway transcript", 1]))
      .mockResolvedValueOnce({
        sessionId: "engine-session-before-rotation",
        reply: "Enter the token.",
        sensitive: true,
        action: "none",
      })
      .mockReturnValueOnce(createDeferred<never>().promise);
    const replacementRequest = vi
      .fn()
      .mockResolvedValueOnce(historyRows(["assistant", "New gateway transcript", 2]))
      .mockResolvedValueOnce(
        chatReply("Fresh safe welcome.", { sessionId: "engine-session-after-rotation" }),
      );
    const { page, setGatewaySnapshot, setGatewayToken, emitGatewayEvent } = await mount(
      request,
      historyMethods,
      undefined,
      { onboarding: false },
    );
    await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));

    await fill(page, password, "test-token-placeholder");
    button(page, ".chat-send-btn").click();
    await waitForFast(() => expect(request).toHaveBeenCalledTimes(3));

    emitGatewayEvent({
      event: "health",
      payload: { channels: { telegram: { configured: true, running: true, connected: false } } },
    });
    await page.updateComplete;
    expect(page.querySelector(".custodian__nudge")).not.toBeNull();
    setGatewayToken("new-operator-token");
    setGatewaySnapshot({
      client: createContext(replacementRequest, ["openclaw.chat", "openclaw.chat.history"]).context
        .gateway.snapshot.client,
    });
    await waitForFast(() => expect(replacementRequest).toHaveBeenCalledTimes(2));
    await waitForFast(() => expect(page.textContent).toContain("Fresh safe welcome."));

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
    expect(page.textContent).not.toContain("Old gateway transcript");
    expect(page.textContent).not.toContain("Enter the token.");
    expect(page.textContent).not.toContain("Sensitive reply sent");
    expect(page.textContent).toContain("New gateway transcript");
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

  it("exits onboarding locally when the question declares an exit skip action", async () => {
    const request = vi.fn().mockResolvedValue(
      chatReply("What would you like to do first?", {
        question: {
          id: "onboarding-next-step",
          header: "Next step",
          question: "What would you like to do first?",
          options: [{ label: "Talk to my agent" }, { label: "Connect a channel" }],
          isOther: true,
          skipAction: "exit",
        },
      }),
    );
    const { context, page } = await mount(request);
    await waitForFast(() => expect(request).toHaveBeenCalledTimes(1));
    await page.updateComplete;

    button(page, ".option-card__skip").click();

    expect(context.navigate).toHaveBeenCalledWith("chat");
    expect(request).toHaveBeenCalledOnce();
  });

  it("reveals a collapsed fenced code block in the caretaker transcript", async () => {
    const code = Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n");
    const request = vi
      .fn()
      .mockResolvedValue(chatReply(`Here you go:\n\n\`\`\`bash\n${code}\n\`\`\``));
    const { page } = await mount(request);
    await waitForFast(() => expect(request).toHaveBeenCalledTimes(1));
    await page.updateComplete;

    const wrapper = page.querySelector(".code-block-wrapper");
    const expand = page.querySelector<HTMLButtonElement>(".code-block-expand");
    expect(wrapper?.classList.contains("is-collapsible")).toBe(true);
    expect(expand?.textContent).toContain("13 hidden lines");

    expand?.click();

    expect(wrapper?.classList.contains("is-expanded")).toBe(true);
    expect(expand?.getAttribute("aria-expanded")).toBe("true");
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
    await waitForFast(() => expect(request).toHaveBeenCalledTimes(1));
    await page.updateComplete;

    expect(page.querySelector(".chat-group.assistant")).not.toBeNull();
    expect(page.querySelector("openclaw-option-card")).not.toBeNull();
    expect(page.textContent).toContain("Which channel?");
    expect(page.textContent).toContain("NO_REPLY");
  });

  it("keeps replacement-connection history when the previous request finishes late", async () => {
    const pending = createDeferred<SystemChangesListResult>();
    const request = vi.fn((method: string) =>
      method === "openclaw.changes.list" ? pending.promise : Promise.resolve(chatReply("Ready.")),
    );
    const harness = createContext(request, changesMethods);
    const { page } = await mountPage(harness.context, { onboarding: false });
    button(page, historyToggle).click();
    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith("openclaw.changes.list", { limit: 50 }),
    );

    const entry = change("config-audit:replacement", "Replacement connection history");
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
    await waitForFast(() => expect(page.querySelector(history)).toBeNull());
    button(page, historyToggle).click();
    await waitForFast(() =>
      expect(page.querySelector(history)?.textContent).toContain(entry.summary),
    );
    pending.resolve({
      entries: [{ ...entry, id: "config-audit:old", summary: "Retired history" }],
    });
    await pending.promise;
    await page.updateComplete;
    expect(page.querySelectorAll(".custodian__change-card")).toHaveLength(1);
    expect(page.querySelector(history)?.textContent).toContain(entry.summary);
    expect(page.querySelector(history)?.textContent).not.toContain("Retired history");
  });
  it.each([
    { hatch: true, search: `?draft=${encodeURIComponent("Wake up, my friend!")}` },
    { hatch: false, search: "?__openclawComposerFocus=1" },
  ])("hands off to agent chat (hatch draft: $hatch)", async ({ hatch, search }) => {
    const request = vi
      .fn()
      .mockResolvedValue(
        chatReply(
          "Continue with your agent.",
          hatch ? { action: "open-agent", agentDraft: "hatch" } : { action: "open-agent" },
        ),
      );
    const { context } = createContext(request);
    const closePanel = vi.fn();
    window.addEventListener(CUSTODIAN_PANEL_TOGGLE_EVENT, closePanel, { once: true });
    const { page } = await mountPage(context);
    await waitForFast(() => expect(request).toHaveBeenCalledTimes(1));
    await page.updateComplete;
    expect(context.navigate).toHaveBeenCalledWith("chat", { pathname: "/chat/main", search });
    expect(closePanel).toHaveBeenCalledWith(expect.objectContaining({ detail: { open: false } }));
  });

  it.each(["dismiss", "channels"])("consumes the optional channel nudge via %s", async (action) => {
    const request = vi.fn().mockResolvedValue(chatReply("Your AI is ready."));
    const { page, context, setChannelsSnapshot, setChannelsConnected } = await mount(
      request,
      undefined,
      {
        channelsSnapshot: channelSnapshot(),
      },
    );
    await waitForFast(() => expect(request).toHaveBeenCalledTimes(1));
    const nudge = page.querySelector(channelNudge)!;
    expect(nudge.textContent).toContain("Reach OpenClaw outside this app");
    expect(nudge.textContent).toContain("The web app already works");
    button(
      page,
      action === "dismiss" ? 'button[aria-label="Keep using the web app"]' : nudgeCta,
    ).click();
    await page.updateComplete;
    if (action === "dismiss") {
      setChannelsSnapshot(null);
      setChannelsConnected(false);
      setChannelsConnected(true);
      expect(context.channels.refresh).not.toHaveBeenCalled();
      expect(context.replace).toHaveBeenCalledWith("custodian");
    } else {
      expect(context.navigate).toHaveBeenCalledWith("channels");
      expect(context.replace).not.toHaveBeenCalled();
    }
    expect(page.querySelector(channelNudge)).toBeNull();
  });

  it("awaits fresh channel status after reconnecting with a stale successful snapshot and error", async () => {
    const freshStatus = createDeferred<ChannelsStatusSnapshot>();
    let statusRequestCount = 0;
    const request = vi.fn((method: string) => {
      if (method === "channels.status") {
        statusRequestCount += 1;
        if (statusRequestCount === 1) {
          return Promise.resolve(channelSnapshot());
        }
        if (statusRequestCount === 2) {
          return Promise.reject(new Error("status unavailable"));
        }
        return freshStatus.promise;
      }
      return Promise.resolve(chatReply("Ready."));
    });
    const { context, setGatewaySnapshot } = createContext(request);
    const channels = createChannelCapability(context.gateway);
    Object.assign(context, { channels });
    await channels.refresh();
    await channels.refresh();
    const previousSnapshot = channels.state.channelsSnapshot;
    expect(channels.state.channelsSnapshot).not.toBeNull();
    expect(channels.state.channelsError).toBe("status unavailable");
    const { page } = await mountPage(context, { onboarding: true });

    setGatewaySnapshot({ phase: "reconnecting" });
    setGatewaySnapshot({ phase: "connected" });

    await waitForFast(() => expect(statusRequestCount).toBe(3));
    expect(channels.state.channelsSnapshot).toBe(previousSnapshot);
    expect(channels.state.channelsLoading).toBe(true);
    await waitForFast(() => expect(page.querySelector(channelNudge)).toBeNull());

    freshStatus.resolve(
      channelSnapshot({
        channels: { telegram: { configured: true, running: true, connected: true } },
      }),
    );
    await waitForFast(() => expect(channels.state.channelsLoading).toBe(false));
    expect(channelSnapshotEntryIsActive(channels.state.channelsSnapshot, "telegram")).toBe(true);
    expect(page.querySelector(channelNudge)).toBeNull();
    channels.dispose();
  });

  it("keeps retry feedback visible until a deferred channel refresh succeeds", async () => {
    const initialStatus = createDeferred<ChannelsStatusSnapshot>();
    const retryStatus = createDeferred<ChannelsStatusSnapshot>();
    let statusRequestCount = 0;
    const request = vi.fn((method: string) =>
      method === "channels.status"
        ? ++statusRequestCount === 1
          ? initialStatus.promise
          : retryStatus.promise
        : Promise.resolve(chatReply("Ready.")),
    );
    const { context } = createContext(request);
    const channels = createChannelCapability(context.gateway);
    Object.assign(context, { channels });
    void channels.refresh();
    const { page } = await mountPage(context, { onboarding: true });
    expect(page.querySelector(channelNudge)).toBeNull();
    initialStatus.reject(new Error("status unavailable"));
    await waitForFast(() => expect(page.querySelector(nudgeCta)?.textContent).toContain("Retry"));

    button(page, nudgeCta).click();

    await waitForFast(() => expect(statusRequestCount).toBe(2));
    expect(channels.state.channelsLoading).toBe(true);
    expect(page.querySelector('[role="alert"]')).not.toBeNull();
    await waitForFast(() => expect(button(page, nudgeCta).disabled).toBe(true));
    expect(button(page, nudgeCta).textContent).toContain("Loading");

    retryStatus.resolve(
      channelSnapshot({
        channelAccounts: { telegram: [{ accountId: "work", configured: false, connected: true }] },
      }),
    );
    await waitForFast(() => expect(channels.state.channelsLoading).toBe(false));
    expect(channels.state.channelsError).toBeNull();
    expect(page.querySelector(channelNudge)).toBeNull();
    channels.dispose();
  });

  it("shows advertised recent changes and loads a short cursor page inline", async () => {
    const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === "openclaw.chat") {
        return chatReply("Hello.");
      }
      if (method === "openclaw.changes.list" && !params.beforeCursor) {
        return {
          entries: [
            change("system-agent-audit:3", "Set config gateway.port", {
              at: Date.now() - 5_000,
              kind: "operation",
              source: "system-agent",
              changedPaths: ["gateway.port"],
            }),
            change("config-audit:2", "Configuration edited outside OpenClaw", {
              at: Date.now() - 10_000,
              kind: "external-edit",
              source: "external",
              invalid: true,
              opaqueChange: true,
            }),
            change("config-audit:0", "Plugin installation updated configuration", {
              at: Date.now() - 15_000,
              source: "plugin-install",
            }),
          ],
          nextCursor: "next-page",
        };
      }
      if (method === "openclaw.changes.list" && params.beforeCursor === "next-page") {
        return {
          entries: [
            change("config-audit:1", "Settings updated configuration: agents.defaults.model", {
              at: Date.now() - 20_000,
            }),
          ],
        };
      }
      throw new Error(`unexpected request ${method}`);
    });
    const harness = createContext(request, changesMethods);
    const { context } = harness;
    const { page } = await mountPage(context, { onboarding: false });
    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith("openclaw.chat", expect.anything(), expect.anything()),
    );
    await page.updateComplete;

    button(page, historyToggle).click();
    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith("openclaw.changes.list", { limit: 50 }),
    );
    await page.updateComplete;

    await waitForFast(() =>
      expect(page.querySelectorAll(".custodian__change-card")).toHaveLength(3),
    );
    // Continuation follows the cursor, even for a short page.
    expect(page.querySelector(historyMore)).not.toBeNull();
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

    button(page, historyMore).click();
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
    expect(page.querySelector(historyMore)).toBeNull();

    button(page, historyToggle).click();
    await page.updateComplete;
    button(page, historyToggle).click();
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
    await waitForFast(() => expect(page.querySelector(history)).toBeNull());
    expect(page.querySelector(historyToggle)?.getAttribute("aria-expanded")).toBe("false");
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
      await waitForFast(() => expect(request).toHaveBeenCalledTimes(1));
      expect(request.mock.calls[0]?.[1]).not.toHaveProperty("context");
      await send(page, "What about this page?");
      await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));
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
    await element(page, wizard);
    expect(page.querySelector(".custodian__wizard-cancel")).toBeNull();
    await page.store.cancelWizardStep(page.store.messages.at(-1)!);
    expect(request).toHaveBeenCalledOnce();
  });

  it("keeps an unanswered structured question across a same-client reconnect", async () => {
    const request = vi.fn(async (method: string) =>
      method === "openclaw.chat.history"
        ? historyRows(["assistant", "Earlier row", 1])
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
    await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));
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
});

describe("custodian page session lifecycle", () => {
  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  const reply = (text: string) => chatReply(text, { sessionId: "engine-session" });
  const invalidated = (code: "UNAVAILABLE" | "INVALID_REQUEST" = "UNAVAILABLE") =>
    new GatewayProtocolRequestError({
      code,
      message: "The live session was lost.",
      details: buildSystemAgentSessionInvalidatedErrorDetails(),
    });

  async function mountReady(request: Parameters<typeof createContext>[0]) {
    const { page } = await mount(request);
    await waitForFast(() => expect(page.textContent).toContain("Ready."));
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
      await waitForFast(() => expect(page.textContent).toContain("Temporary request failure."));
      expect(page.querySelector<HTMLTextAreaElement>("textarea")!.value).toBe(
        sent ? "" : "first try",
      );
      expect(page.store.messages.filter((message) => message.role === "user")).toHaveLength(
        sent ? 1 : 0,
      );
      await send(page, "second try");
      await waitForFast(() => expect(page.textContent).toContain("Still together."));
      expect(request).toHaveBeenCalledTimes(3);
      expect(request.mock.calls[2]?.[1]).toMatchObject({
        sessionId: "engine-session",
        message: "second try",
      });
    },
  );

  it("retires sensitive input when cancelling an invalidated session", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ ...reply("Ready."), sensitive: true, question })
      .mockRejectedValueOnce(invalidated())
      .mockResolvedValueOnce(reply("Fresh session."));
    const page = await mountReady(request);
    await fill(page, password, secret);
    button(page, ".option-card__skip").click();
    await waitForFast(() => expect(page.textContent).toContain("Fresh session."));
    expect(request).toHaveBeenCalledTimes(3);
    expectFreshSession(request, 2);
    expect(page.textContent).toContain("Earlier");
    expect(page.textContent).toContain("started a fresh session");
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
      const request = vi
        .fn()
        .mockResolvedValueOnce({ ...reply("Ready."), wizardInputPending: true, step })
        .mockReturnValueOnce(pending.promise);
      const page = await mountReady(request);
      await fill(page, password, secret);
      button(
        page,
        action === "submit" ? ".custodian__wizard-step .btn.primary" : ".custodian__wizard-cancel",
      ).click();
      await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));
      await page.updateComplete;
      expect(page.querySelector<HTMLInputElement>(password)!.value).toBe("");
      pending.reject(new Error("Temporary request failure."));
      await waitForFast(() => expect(page.textContent).toContain("Temporary request failure."));
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
    const request = vi
      .fn()
      .mockResolvedValueOnce({ ...reply("Ready."), question })
      .mockResolvedValueOnce({
        ...reply("Enter credential."),
        sensitive: true,
        wizardInputPending: true,
        step,
      })
      .mockRejectedValueOnce(invalidated())
      .mockResolvedValue(reply("Ready again."));
    const page = await mountReady(request);
    const draft = "Keep my ordinary question";
    await fill(page, "textarea", draft);
    button(page, ".option-card__choice").click();
    await waitForFast(() => expect(page.querySelector(password)).not.toBeNull());
    expect(page.querySelector<HTMLInputElement>(password)!.value).toBe("");
    expect(request.mock.calls[1]?.[1]?.message).toBe("enter");
    await fill(page, password, secret);
    button(page, ".custodian__wizard-cancel").click();
    await waitForFast(() => expect(page.textContent).toContain("Ready again."));
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
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        ...reply("Ready."),
        wizardInputPending: true,
        step: {
          id: "channel",
          type: "select",
          message: "Which channel?",
          options: optionLabels("Slack", "Twitch"),
        },
      })
      .mockRejectedValueOnce(invalidated("INVALID_REQUEST"))
      .mockResolvedValueOnce(reply("Fresh session."));
    const page = await mountReady(request);
    [...page.querySelectorAll<HTMLButtonElement>(".custodian__wizard-step button:not([disabled])")]
      .find((option) => option.textContent?.trim() === "Twitch")!
      .click();
    await waitForFast(() => expect(page.textContent).toContain("Fresh session."));
    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls[1]?.[1]).toMatchObject({
      sessionId: "engine-session",
      wizardAnswer: { stepId: "channel", value: "twitch" },
    });
    expect(request.mock.calls[2]?.[1]).not.toHaveProperty("message");
    expect(request.mock.calls[2]?.[1]).not.toHaveProperty("wizardAnswer");
    expect(request.mock.calls[2]?.[1]?.sessionId).not.toBe("engine-session");
    expect(page.querySelector(wizard)).toBeNull();
  });

  it("stops after one rotation when the fresh session failure is also marked", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(reply("Ready."))
      .mockRejectedValueOnce(invalidated())
      .mockRejectedValueOnce(invalidated());
    const page = await mountReady(request);
    await send(page, "status please");
    await waitForFast(() => expect(page.store.sending).toBe(false));
    expect(page.textContent).toContain("The live session was lost.");
    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls[2]?.[1]).not.toHaveProperty("message");
  });
});
