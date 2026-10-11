/* @vitest-environment jsdom */

import { GatewayProtocolRequestError } from "@openclaw/gateway-client/browser";
import {
  buildSystemAgentSessionInvalidatedErrorDetails,
  type SystemAgentChatResult,
  type UserProfile,
} from "@openclaw/gateway-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
async function mount(request: ReturnType<typeof vi.fn>) {
  const harness = createContext(request);
  return { ...harness, ...(await mountPage(harness.context)) };
}
async function fill(page: Page, selector: string, value: string) {
  const field = await element<HTMLInputElement | HTMLTextAreaElement>(page, selector);
  field.value = value;
  field.dispatchEvent(new InputEvent("input", { bubbles: true }));
  await page.updateComplete;
  return field;
}

function profile(displayName: string | null): UserProfile {
  return {
    id: "profile-1",
    displayName,
    avatarMime: null,
    mergedInto: null,
    createdAt: 1,
    updatedAt: 1,
    emails: [],
    githubIdentity: null,
    hasAvatar: false,
  };
}

function pageRequest(onDisplayName?: () => Promise<unknown>) {
  return vi.fn(async (method: string, _params?: unknown): Promise<unknown> => {
    if (method === "openclaw.chat.history") {
      return { turns: [] };
    }
    if (method === "openclaw.chat") {
      return chatReply("Ready.");
    }
    if (method === "users.setDisplayName" && onDisplayName) {
      return onDisplayName();
    }
    throw new Error(`unexpected request ${method}`);
  });
}

describe("custodian page", () => {
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

  it("saves a nonblank onboarding name and uses the returned profile after a server no-op", async () => {
    let writes = 0;
    const alreadyNamed = profile("Saved on another device");
    const request = pageRequest(async () => {
      writes += 1;
      if (writes === 1) {
        throw new Error("write refused");
      }
      return { profile: alreadyNamed };
    });
    const { context } = createContext(request);
    context.gateway.loadSelfProfile = vi.fn().mockResolvedValue(profile(null));
    const { page } = await mountPage(context);
    await element<HTMLInputElement>(page, "#custodian-onboarding-display-name");
    const save = button(page, ".custodian__name-actions button[type='submit']");

    save.click();
    expect(save.disabled).toBe(true);
    await fill(page, "#custodian-onboarding-display-name", "   ");
    expect(button(page, ".custodian__name-actions button[type='submit']").disabled).toBe(true);

    await fill(page, "#custodian-onboarding-display-name", "  Vítor  ");
    button(page, ".custodian__name-actions button[type='submit']").click();
    await waitForFast(() => expect(page.querySelector('[role="alert"]')).not.toBeNull());
    expect(page.querySelector("#custodian-onboarding-display-name")).toHaveProperty(
      "value",
      "  Vítor  ",
    );

    button(page, ".custodian__name-actions button[type='submit']").click();
    await waitForFast(() => expect(page.querySelector(".custodian__name-prompt")).toBeNull());
    expect(
      page.querySelector(".custodian--page")?.classList.contains("custodian--onboarding"),
    ).toBe(false);

    const nameWrites = request.mock.calls.filter(([method]) => method === "users.setDisplayName");
    expect(nameWrites).toHaveLength(2);
    expect(nameWrites[0]?.[1]).toEqual({
      profileId: "profile-1",
      displayName: "Vítor",
      onlyIfUnset: true,
    });
    expect(context.gateway.updateSelfUser).toHaveBeenCalledExactlyOnceWith({
      name: "Saved on another device",
    });
  });

  it("preserves a newer same-profile name when the onboarding save settles", async () => {
    const pendingWrite = createDeferred<{ profile: UserProfile }>();
    const request = pageRequest(() => pendingWrite.promise);
    const harness = createContext(request);
    harness.setGatewaySnapshot({
      selfUser: {
        id: "profile-1",
        identity: { type: "profile", id: "profile-1" },
      },
    });
    harness.context.gateway.loadSelfProfile = vi.fn().mockResolvedValue(profile(null));
    const { page } = await mountPage(harness.context);
    await fill(page, "#custodian-onboarding-display-name", "First name");
    button(page, ".custodian__name-actions button[type='submit']").click();
    await waitForFast(() =>
      expect(request.mock.calls.some(([method]) => method === "users.setDisplayName")).toBe(true),
    );

    harness.setGatewaySnapshot({
      selfUser: {
        id: "profile-1",
        identity: { type: "profile", id: "profile-1" },
        name: "Later name",
      },
    });
    await page.updateComplete;

    pendingWrite.resolve({ profile: profile("First name") });
    await waitForFast(() => expect(page.querySelector(".custodian__name-prompt")).toBeNull());

    expect(harness.context.gateway.snapshot.selfUser).toMatchObject({
      id: "profile-1",
      name: "Later name",
    });
    expect(harness.context.gateway.updateSelfUser).not.toHaveBeenCalled();
  });

  it("keeps Skip local to this page visit and never writes the name", async () => {
    const request = pageRequest();
    const { context } = createContext(request);
    context.gateway.loadSelfProfile = vi.fn().mockResolvedValue(profile(null));
    const firstVisit = await mountPage(context);
    await element<HTMLInputElement>(firstVisit.page, "#custodian-onboarding-display-name");

    button(firstVisit.page, ".custodian__name-actions button[type='button']").click();
    await waitForFast(() =>
      expect(firstVisit.page.querySelector(".custodian__name-prompt")).toBeNull(),
    );
    expect(
      firstVisit.page
        .querySelector(".custodian--page")
        ?.classList.contains("custodian--onboarding"),
    ).toBe(false);
    expect(request.mock.calls.some(([method]) => method === "users.setDisplayName")).toBe(false);
    expect(context.gateway.updateSelfUser).not.toHaveBeenCalled();

    firstVisit.provider.remove();
    const nextVisit = await mountPage(context);
    await element<HTMLInputElement>(nextVisit.page, "#custodian-onboarding-display-name");
  });

  it.each(["named", "disconnected", "read-only", "load-error"] as const)(
    "offers the optional name prompt only for a writable unnamed profile (%s)",
    async (scenario) => {
      const request = pageRequest();
      const harness = createContext(request);
      const loadSelfProfile = vi.fn();
      if (scenario === "named") {
        loadSelfProfile.mockResolvedValue(profile("Ada"));
      } else if (scenario === "load-error") {
        loadSelfProfile
          .mockRejectedValueOnce(new Error("profile unavailable"))
          .mockResolvedValueOnce(profile(null));
      } else {
        loadSelfProfile.mockResolvedValue(profile(null));
      }
      harness.context.gateway.loadSelfProfile = loadSelfProfile;
      if (scenario === "disconnected") {
        harness.setGatewaySnapshot({ phase: "offline", client: null });
      } else if (scenario === "read-only") {
        const hello = harness.context.gateway.snapshot.hello;
        if (!hello) {
          throw new Error("test setup requires a connected Gateway hello");
        }
        harness.setGatewaySnapshot({
          hello: { ...hello, auth: { role: "operator", scopes: ["operator.read"] } },
        });
      }
      const { page } = await mountPage(harness.context);

      if (scenario === "load-error") {
        await waitForFast(() => expect(page.querySelector('[role="alert"]')).not.toBeNull());
        button(page, ".custodian__name-prompt button").click();
        await element<HTMLInputElement>(page, "#custodian-onboarding-display-name");
        expect(loadSelfProfile).toHaveBeenCalledTimes(2);
        return;
      }
      if (scenario === "named") {
        await waitForFast(() => expect(loadSelfProfile).toHaveBeenCalledOnce());
      }
      await page.updateComplete;
      expect(page.querySelector(".custodian__name-prompt")).toBeNull();
      expect(
        page.querySelector(".custodian--page")?.classList.contains("custodian--onboarding"),
      ).toBe(false);
      expect(loadSelfProfile).toHaveBeenCalledTimes(scenario === "named" ? 1 : 0);
    },
  );

  it("ignores a name-save result when its Gateway connection has been replaced", async () => {
    const pendingWrite = createDeferred<{ profile: UserProfile }>();
    const request = pageRequest(async () => pendingWrite.promise);
    const harness = createContext(request);
    const loadSelfProfile = vi
      .fn()
      .mockResolvedValueOnce(profile(null))
      .mockResolvedValueOnce(null);
    harness.context.gateway.loadSelfProfile = loadSelfProfile;
    const { page } = await mountPage(harness.context);
    await element<HTMLInputElement>(page, "#custodian-onboarding-display-name");
    await fill(page, "#custodian-onboarding-display-name", "Ada");
    button(page, ".custodian__name-actions button[type='submit']").click();
    await waitForFast(() =>
      expect(request.mock.calls.some(([method]) => method === "users.setDisplayName")).toBe(true),
    );

    const replacementClient = { request: vi.fn(async () => ({ turns: [] })) };
    harness.setGatewaySnapshot({
      client: replacementClient as unknown as GatewayBrowserClient,
    });
    await waitForFast(() => expect(loadSelfProfile).toHaveBeenCalledTimes(2));
    pendingWrite.resolve({ profile: profile("Ada") });
    await pendingWrite.promise;
    await page.updateComplete;

    expect(harness.context.gateway.updateSelfUser).not.toHaveBeenCalled();
    expect(page.querySelector(".custodian__name-prompt")).toBeNull();
  });

  it("renders and answers rich select, multiselect, and sensitive text wizard steps", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        sessionId: "rich-wizard-session",
        reply: "Choose a channel.",
        action: "none",
        wizardInputPending: true,
        step: {
          id: "channel",
          type: "select",
          message: "Which channel?",
          options: ["Discord", "Slack", "Telegram", "WhatsApp", "Twitch"].map((label) => ({
            label,
            value: label.toLowerCase(),
          })),
        },
      })
      .mockResolvedValueOnce({
        sessionId: "rich-wizard-session",
        reply: "Choose features.",
        action: "none",
        wizardInputPending: true,
        step: {
          id: "features",
          type: "multiselect",
          message: "Which features?",
          options: [
            { label: "Chat", value: "chat" },
            { label: "Moderation", value: "moderation" },
            { label: "Announcements", value: "announcements" },
          ],
        },
      })
      .mockResolvedValueOnce({
        sessionId: "rich-wizard-session",
        reply: "Enter the secret.",
        action: "none",
        sensitive: true,
        wizardInputPending: true,
        step: {
          id: "secret",
          type: "text",
          message: "Twitch client secret",
          sensitive: true,
        },
      })
      .mockResolvedValueOnce(chatReply("Setup complete.", { sessionId: "rich-wizard-session" }));
    const { page } = await mount(request);

    const trigger = await element<HTMLButtonElement>(
      page,
      ".custodian__wizard-step .picker-select__trigger",
    );
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
      expect(page.querySelectorAll('.custodian__wizard-step input[type="checkbox"]')).toHaveLength(
        3,
      ),
    );
    expect(request.mock.calls[1]?.[1]).toMatchObject({
      wizardAnswer: { stepId: "channel", value: "twitch" },
    });
    expect(request.mock.calls[1]?.[1]).not.toHaveProperty("message");
    page
      .querySelectorAll<HTMLInputElement>('.custodian__wizard-step input[type="checkbox"]')[0]!
      .click();
    await page.updateComplete;
    page
      .querySelectorAll<HTMLInputElement>('.custodian__wizard-step input[type="checkbox"]')[2]!
      .click();
    await page.updateComplete;
    button(page, ".custodian__wizard-step .btn.primary").click();

    await waitForFast(() => expect(request).toHaveBeenCalledTimes(3));
    const secretInput = await element<HTMLInputElement>(page, "#custodian-wizard-input-5");
    expect(request.mock.calls[2]?.[1]).toMatchObject({
      wizardAnswer: { stepId: "features", value: ["chat", "announcements"] },
    });
    expect(secretInput.type).toBe("password");
    const revealSecret = page.querySelector<HTMLButtonElement>(
      '.custodian__wizard-step button[aria-label="Reveal value"]',
    );
    expect(revealSecret).not.toBeNull();
    revealSecret!.click();
    await page.updateComplete;
    const revealedInput = page.querySelector<HTMLInputElement>("#custodian-wizard-input-5")!;
    expect(revealedInput.type).toBe("text");
    revealedInput.value = "fake-client-secret";
    revealedInput.dispatchEvent(new Event("input", { bubbles: true }));
    await page.updateComplete;
    button(page, ".custodian__wizard-step .btn.primary").click();

    await waitForFast(() => expect(request).toHaveBeenCalledTimes(4));
    await waitForFast(() => expect(page.textContent).toContain("Setup complete."));
    expect(request.mock.calls[3]?.[1]).toMatchObject({
      wizardAnswer: { stepId: "secret", value: "fake-client-secret" },
    });
    expect(request.mock.calls[3]?.[1]).not.toHaveProperty("message");
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
    const { context, setGatewaySnapshot } = createContext(request, [
      "openclaw.chat",
      "openclaw.chat.history",
    ]);
    const { page } = await mountPage(context);
    await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));

    setGatewaySnapshot({ client: { request } as unknown as GatewayBrowserClient });
    await waitForFast(() => expect(page.textContent).toContain("Completed while away"));

    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "openclaw.chat.history",
      "openclaw.chat",
      "openclaw.chat.history",
    ]);
    expect(page.querySelector(".chat-group.user")?.textContent).toContain("Earlier state");
    expect(page.textContent).not.toContain("Live welcome");
  });

  it("resolves a pending ordinary turn from durable history after client replacement", async () => {
    const pending = createDeferred<Reply>();
    const request = vi
      .fn()
      .mockResolvedValueOnce({ turns: [] })
      .mockResolvedValueOnce(chatReply("Welcome."))
      .mockReturnValueOnce(pending.promise);
    const replacementRequest = vi.fn((method: string, params: { sessionId?: string }) =>
      Promise.resolve(
        method === "openclaw.chat.history"
          ? {
              turns: [
                { role: "user", text: "check this system", at: 1 },
                { role: "assistant", text: "System check completed", at: 2 },
              ],
            }
          : chatReply("Welcome back.", { sessionId: params.sessionId }),
      ),
    );
    const { context, setGatewaySnapshot } = createContext(request, [
      "openclaw.chat",
      "openclaw.chat.history",
    ]);
    const { page } = await mountPage(context);
    await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));
    await fill(page, "textarea", "check this system");
    button(page, ".chat-send-btn").click();
    await waitForFast(() => expect(request).toHaveBeenCalledTimes(3));
    expect(request.mock.calls[2]?.[1]).toMatchObject({
      sessionId: "custodian-session",
      message: "check this system",
    });
    setGatewaySnapshot({
      client: { request: replacementRequest } as unknown as GatewayBrowserClient,
    });
    await waitForFast(() => expect(page.textContent).toContain("System check completed"));
    expect(replacementRequest.mock.calls.map(([method]) => method)).toEqual([
      "openclaw.chat.history",
      "openclaw.chat",
      "openclaw.chat.history",
    ]);
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
      .mockResolvedValueOnce({
        turns: [{ role: "assistant", text: "Loaded transcript row", at: 1 }],
      })
      .mockRejectedValueOnce(new Error("temporary welcome failure"))
      .mockResolvedValueOnce(
        chatReply("Recovered welcome.", { sessionId: "engine-session-after-retry" }),
      );
    const { context } = createContext(request, ["openclaw.chat", "openclaw.chat.history"]);
    const { page } = await mountPage(context);
    await waitForFast(() => expect(page.querySelector('[role="alert"] button')).not.toBeNull());

    button(page, '[role="alert"] button').click();
    await waitForFast(() => expect(page.textContent).toContain("Recovered welcome."));

    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "openclaw.chat.history",
      "openclaw.chat",
      "openclaw.chat",
    ]);
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
    await waitForFast(() => expect(request).toHaveBeenCalledOnce());
    await page.updateComplete;
    const input = await fill(page, 'input[type="password"]', " test-token-placeholder ");
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
      .mockResolvedValueOnce({
        turns: [{ role: "assistant", text: "Old gateway transcript", at: 1 }],
      })
      .mockResolvedValueOnce({
        sessionId: "engine-session-before-rotation",
        reply: "Enter the token.",
        sensitive: true,
        action: "none",
      })
      .mockReturnValueOnce(createDeferred<never>().promise);
    const replacementRequest = vi
      .fn()
      .mockResolvedValueOnce({
        turns: [{ role: "assistant", text: "New gateway transcript", at: 2 }],
      })
      .mockResolvedValueOnce(
        chatReply("Fresh safe welcome.", { sessionId: "engine-session-after-rotation" }),
      );
    const { context, setGatewaySnapshot, setGatewayToken, emitGatewayEvent } = createContext(
      request,
      ["openclaw.chat", "openclaw.chat.history"],
    );
    const { page } = await mountPage(context, { onboarding: false });
    await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));

    await fill(page, 'input[type="password"]', "test-token-placeholder");
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
      client: { request: replacementRequest } as unknown as GatewayBrowserClient,
    });
    await waitForFast(() => expect(replacementRequest).toHaveBeenCalledTimes(2));
    await waitForFast(() => expect(page.textContent).toContain("Fresh safe welcome."));

    expect(request.mock.calls[2]?.[1]).toMatchObject({
      sessionId: "engine-session-before-rotation",
      message: "test-token-placeholder",
    });
    expect(replacementRequest.mock.calls.map(([method]) => method)).toEqual([
      "openclaw.chat.history",
      "openclaw.chat",
    ]);
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
    expect(page.querySelector('input[type="password"]')).toBeNull();
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
    await waitForFast(() => expect(request).toHaveBeenCalledOnce());
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
    await waitForFast(() => expect(request).toHaveBeenCalledOnce());
    await page.updateComplete;

    const wrapper = page.querySelector(".code-block-wrapper");
    const expand = page.querySelector<HTMLButtonElement>(".code-block-expand");
    expect(wrapper?.classList.contains("is-collapsible")).toBe(true);
    expect(expand?.textContent).toContain("13 hidden lines");

    expand?.click();

    expect(wrapper?.classList.contains("is-expanded")).toBe(true);
    expect(expand?.getAttribute("aria-expanded")).toBe("true");
  });

  it("keeps a structured question attached to a silent assistant reply", async () => {
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
    await waitForFast(() => expect(request).toHaveBeenCalledOnce());
    await page.updateComplete;

    expect(page.querySelector(".chat-group.assistant")).toBeNull();
    expect(page.querySelector("openclaw-option-card")).not.toBeNull();
    expect(page.textContent).toContain("Which channel?");
    expect(page.textContent).not.toContain("NO_REPLY");
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
    await waitForFast(() => expect(request).toHaveBeenCalledOnce());
    await page.updateComplete;
    expect(context.navigate).toHaveBeenCalledWith("chat", { pathname: "/chat/main", search });
    expect(closePanel).toHaveBeenCalledWith(expect.objectContaining({ detail: { open: false } }));
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
    await waitForFast(() => expect(request).toHaveBeenCalledOnce());

    const nudge = page.querySelector(".custodian__nudge--channel-onboarding");
    expect(nudge?.textContent).toContain("Reach OpenClaw outside this app");
    expect(nudge?.textContent).toContain("The web app already works");

    page.querySelector<HTMLButtonElement>('button[aria-label="Keep using the web app"]')?.click();
    await page.updateComplete;

    setChannelsSnapshot(null);
    setChannelsConnected(false);
    setChannelsConnected(true);
    expect(context.channels.refresh).not.toHaveBeenCalled();
    expect(context.replace).toHaveBeenCalledWith("custodian");
    expect(page.querySelector(".custodian__nudge--channel-onboarding")).toBeNull();
  });

  it("opens Channels from the optional first-run nudge", async () => {
    const request = vi.fn().mockResolvedValue(chatReply("Your AI is ready."));
    const { context } = createContext(request, ["openclaw.chat"], {
      channelsSnapshot: channelSnapshot(),
    });
    const { page } = await mountPage(context, { onboarding: true });
    await waitForFast(() => expect(request).toHaveBeenCalledOnce());

    page.querySelector<HTMLButtonElement>(".custodian__nudge-cta")?.click();
    await page.updateComplete;

    expect(context.navigate).toHaveBeenCalledWith("channels");
    expect(context.replace).not.toHaveBeenCalled();
    expect(page.querySelector(".custodian__nudge--channel-onboarding")).toBeNull();
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
    expect(channels.state.channelsSnapshot).not.toBeNull();
    expect(channels.state.channelsError).toBe("status unavailable");
    const { page } = await mountPage(context, { onboarding: true });

    setGatewaySnapshot({ phase: "reconnecting" });
    setGatewaySnapshot({ phase: "connected" });

    await waitForFast(() => expect(statusRequestCount).toBe(3));
    expect(channels.state.channelsSnapshot).toBeNull();
    expect(channels.state.channelsLoading).toBe(true);
    expect(page.querySelector(".custodian__nudge--channel-onboarding")).toBeNull();

    freshStatus.resolve(
      channelSnapshot({
        channels: { telegram: { configured: true, running: true, connected: true } },
      }),
    );
    await waitForFast(() => expect(channels.state.channelsLoading).toBe(false));
    expect(channelSnapshotEntryIsActive(channels.state.channelsSnapshot, "telegram")).toBe(true);
    expect(page.querySelector(".custodian__nudge--channel-onboarding")).toBeNull();
    channels.dispose();
  });

  it("keeps retry feedback visible until a deferred channel refresh succeeds", async () => {
    const retryStatus = createDeferred<ChannelsStatusSnapshot>();
    let statusRequestCount = 0;
    const request = vi.fn((method: string) => {
      if (method === "channels.status") {
        statusRequestCount += 1;
        return statusRequestCount === 1
          ? Promise.reject(new Error("status unavailable"))
          : retryStatus.promise;
      }
      return Promise.resolve(chatReply("Ready."));
    });
    const { context } = createContext(request);
    const channels = createChannelCapability(context.gateway);
    Object.assign(context, { channels });
    await channels.refresh();
    const { page } = await mountPage(context, { onboarding: true });

    const retry = page.querySelector<HTMLButtonElement>(".custodian__nudge-cta");
    expect(retry?.textContent).toContain("Retry");
    retry?.click();

    await waitForFast(() => expect(statusRequestCount).toBe(2));
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
    expect(page.querySelector(".custodian__nudge--channel-onboarding")).toBeNull();
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
            {
              id: "system-agent-audit:3",
              at: Date.now() - 5_000,
              kind: "operation",
              source: "system-agent",
              summary: "Set config gateway.port",
              changedPaths: ["gateway.port"],
            },
            {
              id: "config-audit:2",
              at: Date.now() - 10_000,
              kind: "external-edit",
              source: "external",
              summary: "Configuration edited outside OpenClaw",
              invalid: true,
              opaqueChange: true,
            },
            {
              id: "config-audit:0",
              at: Date.now() - 15_000,
              kind: "config-write",
              source: "plugin-install",
              summary: "Plugin installation updated configuration",
            },
          ],
          nextCursor: "next-page",
        };
      }
      if (method === "openclaw.changes.list" && params.beforeCursor === "next-page") {
        return {
          entries: [
            {
              id: "config-audit:1",
              at: Date.now() - 20_000,
              kind: "config-write",
              source: "config-rpc",
              summary: "Settings updated configuration: agents.defaults.model",
            },
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

    expect(page.querySelectorAll(".custodian__change-card")).toHaveLength(3);
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
    expect(page.querySelectorAll(".custodian__change-card")).toHaveLength(4);
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
    expect(page.querySelectorAll(".custodian__change-card")).toHaveLength(3);

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
      await waitForFast(() => expect(request).toHaveBeenCalledOnce());
      expect(request.mock.calls[0]?.[1]).not.toHaveProperty("context");
      await fill(page, "textarea", "What about this page?");
      button(page, ".chat-send-btn").click();
      await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));
      expect(request.mock.calls[1]?.[1]?.message).toBe("What about this page?");
      if (expectedPage) {
        expect(request.mock.calls[1]?.[1]?.context).toEqual({ page: expectedPage });
      } else {
        expect(request.mock.calls[1]?.[1]).not.toHaveProperty("context");
      }
    },
  );

  it("does not rotate against a replacement gateway without chat support", async () => {
    const request = vi.fn().mockResolvedValue(chatReply("Existing welcome."));
    const replacementRequest = vi.fn();
    const { context, setGatewaySnapshot } = createContext(request);
    const { page } = await mountPage(context);
    await waitForFast(() => expect(request).toHaveBeenCalledOnce());
    setGatewaySnapshot({
      client: { request: replacementRequest } as unknown as GatewayBrowserClient,
      hello: {
        type: "hello-ok",
        protocol: 1,
        auth: { role: "operator", scopes: ["operator.admin"] },
        features: { methods: [] },
      },
    });
    await waitForFast(() =>
      expect(page.querySelector('[role="alert"]')?.textContent).toContain("Update the Gateway"),
    );
    expect(request).toHaveBeenCalledOnce();
    expect(replacementRequest).not.toHaveBeenCalled();
  });

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
        ? { turns: [{ role: "assistant", text: "Earlier row", at: 1 }] }
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
    const { context, setGatewaySnapshot } = createContext(request, [
      "openclaw.chat",
      "openclaw.chat.history",
    ]);
    const { page } = await mountPage(context);
    await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));
    await page.updateComplete;
    expect(page.querySelector("openclaw-option-card")).not.toBeNull();
    setGatewaySnapshot({ phase: "reconnecting" });
    await page.updateComplete;
    setGatewaySnapshot({ phase: "connected" });
    await page.updateComplete;
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "openclaw.chat.history",
      "openclaw.chat",
    ]);
    expect(page.querySelector("openclaw-option-card")).not.toBeNull();
    expect(page.textContent).toContain("Choose the next step.");
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

  async function mountReady(request: ReturnType<typeof vi.fn>) {
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
      await fill(page, "textarea", "first try");
      button(page, ".chat-send-btn").click();
      await waitForFast(() => expect(page.textContent).toContain("Temporary request failure."));
      expect(page.querySelector<HTMLTextAreaElement>("textarea")!.value).toBe(
        sent ? "" : "first try",
      );
      expect(page.store.messages.filter((message) => message.role === "user")).toHaveLength(
        sent ? 1 : 0,
      );
      await fill(page, "textarea", "second try");
      button(page, ".chat-send-btn").click();
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
    await fill(page, 'input[type="password"]', secret);
    button(page, ".option-card__skip").click();
    await waitForFast(() => expect(page.textContent).toContain("Fresh session."));
    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls[2]?.[1]).toMatchObject({
      sessionId: expect.stringMatching(/^control-ui-onboarding-/),
    });
    expect(request.mock.calls[2]?.[1]).not.toHaveProperty("message");
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
      await fill(page, 'input[type="password"]', secret);
      button(
        page,
        action === "submit" ? ".custodian__wizard-step .btn.primary" : ".custodian__wizard-cancel",
      ).click();
      await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));
      await page.updateComplete;
      expect(page.querySelector<HTMLInputElement>('input[type="password"]')!.value).toBe("");
      pending.reject(new Error("Temporary request failure."));
      await waitForFast(() => expect(page.textContent).toContain("Temporary request failure."));
      expect(page.querySelector<HTMLInputElement>('input[type="password"]')!.value).toBe("");
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
    await waitForFast(() => expect(page.querySelector('input[type="password"]')).not.toBeNull());
    expect(page.querySelector<HTMLInputElement>('input[type="password"]')!.value).toBe("");
    expect(request.mock.calls[1]?.[1]?.message).toBe("enter");
    await fill(page, 'input[type="password"]', secret);
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
          options: [
            { label: "Slack", value: "slack" },
            { label: "Twitch", value: "twitch" },
          ],
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
    expect(page.querySelector(".custodian__wizard-step")).toBeNull();
  });

  it("stops after one rotation when the fresh session failure is also marked", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(reply("Ready."))
      .mockRejectedValueOnce(invalidated())
      .mockRejectedValueOnce(invalidated());
    const page = await mountReady(request);
    await fill(page, "textarea", "status please");
    button(page, ".chat-send-btn").click();
    await waitForFast(() => expect(page.store.sending).toBe(false));
    expect(page.textContent).toContain("The live session was lost.");
    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls[2]?.[1]).not.toHaveProperty("message");
  });
});
