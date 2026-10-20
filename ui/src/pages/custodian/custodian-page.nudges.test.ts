/* @vitest-environment jsdom */

import type { SystemAgentChatResult } from "@openclaw/gateway-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError } from "../../api/gateway.ts";
import * as uuid from "../../lib/uuid.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { createContext, mountPage } from "./custodian-page.test-harness.ts";

type Reply = SystemAgentChatResult;
function chatReply(reply: string, patch: Partial<Reply> = {}): Reply {
  return { sessionId: "custodian-session", reply, action: "none", ...patch };
}

const stoppedChannel = {
  configured: true,
  enabled: true,
  running: false,
  healthState: "not-running",
  restartPending: false,
  reconnectAttempts: 0,
};
const closedQuestion = {
  id: "access",
  header: "Access",
  question: "How should OpenClaw work?",
  options: [{ label: "Full access" }, { label: "Ask first" }],
  isOther: false,
};
const discordAuthFailure = {
  channels: { discord: { configured: true, tokenStatus: "configured_unavailable" } },
};
const telegramAuthFailure = {
  channelLabels: { telegram: "Telegram" },
  channels: { telegram: { configured: true, tokenStatus: "configured_unavailable" } },
};
const questionReply = (isOther = false) =>
  chatReply("Choose one.", { question: { ...closedQuestion, isOther } });
const nudge = (page: HTMLElement) => page.querySelector(".custodian__nudge");
const alert = (page: HTMLElement) => page.querySelector('[role="alert"]');
const question = (page: HTMLElement) => page.querySelector("openclaw-option-card");
function skipQuestion(page: HTMLElement) {
  page.querySelector<HTMLButtonElement>(".option-card__skip")!.click();
}
async function startNudge(page: Page, request: Parameters<typeof createContext>[0]) {
  nudgeAction(page).click();
  await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));
}
function nudgeAction(page: HTMLElement) {
  return page.querySelector<HTMLButtonElement>(".custodian__nudge-action")!;
}

const createHealthyRequest = () =>
  vi.fn().mockResolvedValueOnce(chatReply("Everything is healthy."));

type Page = Awaited<ReturnType<typeof mountPage>>["page"];
async function send(page: Page, text: string) {
  const input = page.querySelector<HTMLTextAreaElement>(".agent-chat__composer-combobox textarea")!;
  input.value = text;
  input.dispatchEvent(new InputEvent("input", { bubbles: true }));
  await page.updateComplete;
  page.querySelector<HTMLButtonElement>(".chat-send-btn")!.click();
}
async function mountCaretaker(request = createHealthyRequest()) {
  const harness = createContext(request);
  const { page } = await mountPage(harness.context, { onboarding: false });
  await waitForFast(() => expect(request).toHaveBeenCalledOnce());
  return {
    ...harness,
    page,
    request,
    health: (payload: unknown) => harness.emitGatewayEvent({ event: "health", payload }),
    emitHealth: async (payload: unknown) => {
      harness.emitGatewayEvent({ event: "health", payload });
      await page.updateComplete;
    },
  };
}

async function mountPendingNudge<T = Reply>(payload: unknown) {
  const pending = createDeferred<T>();
  const request = createHealthyRequest().mockImplementationOnce(() => pending.promise);
  const harness = await mountCaretaker(request);
  await harness.emitHealth(payload);
  await startNudge(harness.page, request);
  return { ...harness, pending };
}

function rejectAfterSend(
  _method: unknown,
  _params: unknown,
  options?: { onSent?: () => void },
): Promise<never> {
  options?.onSent?.();
  return Promise.reject(new Error("Request failed"));
}

describe("custodian page nudges", () => {
  beforeEach(() => {
    vi.spyOn(uuid, "generateUUID").mockReturnValue("00000000-0000-4000-8000-000000000001");
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("keeps a focused question answer usable across unrelated Gateway events", async () => {
    const initialReply = createDeferred<SystemAgentChatResult>();
    const request = vi
      .fn()
      .mockReturnValueOnce(initialReply.promise)
      .mockResolvedValue(chatReply("Continuing."));
    const { context, emitGatewayEvent } = createContext(request);
    const { page } = await mountPage(context, { onboarding: false });
    initialReply.resolve(
      chatReply("Choose the next step.", {
        question: {
          id: "focused-choice",
          header: "Next step",
          question: "What should happen next?",
          options: [
            { label: "Continue", reply: "continue", recommended: true },
            { label: "Pause", reply: "pause" },
          ],
        },
      }),
    );
    const answer = await waitForSolid(() => {
      const button = page.querySelector<HTMLButtonElement>('[data-option-value="Pause"]');
      expect(button).not.toBeNull();
      return button!;
    });
    answer.focus();
    expect(document.activeElement).toBe(answer);

    emitGatewayEvent({ event: "health", payload: { channels: {} } });
    await waitForSolid(() => expect(document.activeElement).toBe(answer));
    answer.click();
    await waitForSolid(() =>
      expect(request.mock.calls.at(-1)?.[1]).toMatchObject({ message: "pause" }),
    );
  });

  it("shows a channel-error nudge but ignores routine events", async () => {
    const { page, emitGatewayEvent, emitHealth } = await mountCaretaker();

    emitGatewayEvent({ event: "tick", payload: { ts: Date.now() } });
    await page.updateComplete;
    expect(nudge(page)).toBeNull();

    await emitHealth({
      channelLabels: { telegram: "Telegram" },
      channels: {
        telegram: {
          enabled: false,
          accounts: {
            default: { configured: true, enabled: false, connected: false },
            work: { configured: true, enabled: true, running: true, connected: false },
          },
        },
      },
    });
    expect(nudge(page)?.textContent).toContain("Telegram just disconnected");
  });

  it.each([
    {
      name: "clean stop",
      patch: { connected: false, lastStopAt: 1_700_000_000_000, lastError: "old error" },
      degraded: false,
    },
    {
      name: "failed restart",
      patch: {
        lastStopAt: 1_700_000_000_000,
        lastStartAt: 1_700_000_001_000,
        lastError: "failed to initialize transport",
      },
      degraded: true,
    },
    {
      name: "failed probe after stopping",
      patch: {
        lastStopAt: 1_700_000_001_000,
        lastStartAt: 1_700_000_000_000,
        probe: { ok: false },
      },
      degraded: true,
    },
  ])("classifies $name without reviving stale channel errors", async ({ patch, degraded }) => {
    const { page, emitHealth } = await mountCaretaker();
    await emitHealth({
      channelLabels: { telegram: "Telegram" },
      channels: { telegram: { ...stoppedChannel, ...patch } },
    });
    const card = nudge(page);
    if (degraded) {
      expect(card?.textContent).toContain("Telegram is degraded");
    } else {
      expect(card).toBeNull();
    }
  });

  it("dismisses event nudges for the rest of the page visit", async () => {
    const { request, page, emitHealth } = await mountCaretaker();

    await emitHealth({ configReload: { hotReloadStatus: "disabled" }, channels: {} });
    expect(page.textContent).toContain("Configuration reload stopped");
    page.querySelector<HTMLButtonElement>(".custodian__nudge-dismiss")!.click();
    await page.updateComplete;

    await emitHealth(discordAuthFailure);
    expect(nudge(page)).toBeNull();
    expect(request).toHaveBeenCalledOnce();
  });

  it.each([
    { name: "sensitive reply", patch: { sensitive: true } },
    { name: "non-card wizard input", patch: { wizardInputPending: true } },
  ])("blocks an event nudge during $name", async ({ patch }) => {
    const request = vi.fn().mockResolvedValue(chatReply("Enter your token.", patch));
    const { page, emitHealth } = await mountCaretaker(request);
    await emitHealth(discordAuthFailure);
    const action = nudgeAction(page);
    expect(action.disabled).toBe(true);
    action.click();
    await page.updateComplete;
    expect(request).toHaveBeenCalledOnce();
    expect(nudge(page)).not.toBeNull();
    expect(question(page)).toBeNull();
  });

  it("keeps nudges blocked after an uncertain question reply and rejected retry", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(questionReply())
      .mockImplementationOnce(rejectAfterSend)
      .mockRejectedValueOnce(
        new GatewayRequestError({ code: "INVALID_REQUEST", message: "Request failed" }),
      );
    const { page, emitHealth } = await mountCaretaker(request);

    await emitHealth(discordAuthFailure);
    skipQuestion(page);

    await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));
    await waitForFast(() => expect(alert(page)).not.toBeNull());
    expect(page.querySelector('[role="alert"] button')).toBeNull();
    expect(question(page)).toBeNull();
    const action = nudgeAction(page);
    expect(action.disabled).toBe(true);
    action.click();
    await page.updateComplete;

    expect(request).toHaveBeenCalledTimes(2);

    await send(page, "Try again");

    await waitForFast(() => expect(request).toHaveBeenCalledTimes(3));
    await page.updateComplete;
    expect(nudgeAction(page).disabled).toBe(true);
  });

  it("restores a closed question after its reply is explicitly rejected", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(questionReply())
      .mockRejectedValueOnce(
        new GatewayRequestError({ code: "INVALID_REQUEST", message: "Request failed" }),
      );
    const { page, emitHealth } = await mountCaretaker(request);

    await emitHealth(discordAuthFailure);
    skipQuestion(page);

    await waitForFast(() => expect(alert(page)).not.toBeNull());
    await page.updateComplete;
    expect(question(page)).not.toBeNull();
    expect(nudgeAction(page).disabled).toBe(true);
  });

  it("keeps event nudges blocked after a typed question reply has an uncertain failure", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(questionReply(true))
      .mockImplementationOnce(rejectAfterSend);
    const { page, emitHealth } = await mountCaretaker(request);

    await emitHealth(discordAuthFailure);
    await send(page, "**Something** else");

    await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));
    await waitForFast(() => expect(page.querySelector('[role="alert"]')).not.toBeNull());
    expect(page.querySelector(".chat-group.user strong")?.textContent).toBe("Something");
    expect(page.querySelector<HTMLButtonElement>(".option-card__skip")?.disabled).toBe(true);
    const action = nudgeAction(page);
    expect(action.disabled).toBe(true);
    action.click();
    await page.updateComplete;

    expect(request).toHaveBeenCalledTimes(2);
  });

  it("ignores a stale question reply outcome after a same-owner reconnect", async () => {
    const pendingQuestion = createDeferred<SystemAgentChatResult>();
    let chatCalls = 0;
    const request = vi.fn((_method: string, params: { message?: string; sessionId?: string }) => {
      if (params.message !== undefined) {
        return pendingQuestion.promise;
      }
      chatCalls += 1;
      if (chatCalls === 1) {
        return Promise.resolve(questionReply());
      }
      // Rejoin supplies the authoritative state after an unknown outcome.
      return Promise.resolve(chatReply("Welcome back.", { sessionId: params.sessionId }));
    });
    const { page, setGatewaySnapshot, emitHealth } = await mountCaretaker(request);

    await emitHealth(discordAuthFailure);
    skipQuestion(page);
    await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));

    setGatewaySnapshot({ phase: "reconnecting" });
    await page.updateComplete;
    setGatewaySnapshot({ phase: "connected" });
    await waitForFast(() => expect(request).toHaveBeenCalledTimes(3));
    pendingQuestion.resolve(chatReply("Moving on."));

    await Promise.resolve();
    await page.updateComplete;
    // The authoritative rejoin wins over the interrupted reply.
    expect(page.textContent).not.toContain("Moving on.");
    expect(page.textContent).toContain("Welcome back.");
    const action = nudgeAction(page);
    expect(action.disabled).toBe(false);
  });

  it("restores an event nudge after its request fails", async () => {
    const request = createHealthyRequest().mockRejectedValueOnce(
      new GatewayRequestError({ code: "INVALID_REQUEST", message: "Request failed" }),
    );
    const { page, emitHealth } = await mountCaretaker(request);

    await emitHealth(telegramAuthFailure);
    nudgeAction(page).click();

    await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));
    await waitForFast(() => expect(page.querySelector('[role="alert"]')).not.toBeNull());
    await page.updateComplete;
    expect(page.querySelector(".custodian__nudge")?.textContent).toContain(
      "Telegram authentication degraded",
    );
  });

  it("consumes a delivered nudge whose reply becomes stale during reconnect", async () => {
    const health = { channels: { telegram: { configured: true, healthState: "stale-socket" } } };
    const { page, pending, emitHealth, setGatewaySnapshot } = await mountPendingNudge(health);
    setGatewaySnapshot({ phase: "reconnecting" });
    await page.updateComplete;
    setGatewaySnapshot({ phase: "connected" });
    await page.updateComplete;
    pending.resolve(chatReply("Telegram checked."));
    await waitForFast(() => expect(nudge(page)).toBeNull());
    await emitHealth(health);
    expect(nudge(page)).toBeNull();
  });

  it("consumes a transmitted nudge when its delivery outcome is unknown", async () => {
    const request = createHealthyRequest().mockImplementationOnce(rejectAfterSend);
    const { page, emitGatewayEvent } = await mountCaretaker(request);
    const degradedHealth = {
      channels: { telegram: { configured: true, healthState: "stale-socket" } },
    };

    emitGatewayEvent({ event: "health", payload: degradedHealth });
    await page.updateComplete;
    nudgeAction(page).click();

    await waitForFast(() => expect(page.querySelector('[role="alert"]')).not.toBeNull());
    expect(page.querySelector(".custodian__nudge")).toBeNull();
    emitGatewayEvent({ event: "health", payload: degradedHealth });
    await page.updateComplete;
    expect(page.querySelector(".custodian__nudge")).toBeNull();
  });

  it("keeps a newer lower-severity failure when an earlier nudge send succeeds", async () => {
    const { page, health, pending: pendingNudge } = await mountPendingNudge(telegramAuthFailure);

    health({
      channelLabels: { discord: "Discord" },
      channels: { discord: { configured: true, healthState: "stale-socket" } },
    });
    pendingNudge.resolve(chatReply("Telegram checked."));

    await waitForFast(() => expect(page.textContent).toContain("Telegram checked."));
    await page.updateComplete;
    expect(nudge(page)?.textContent).toContain("Discord is degraded");
  });

  it("consumes an in-flight incident that becomes current again before completion", async () => {
    const telegramFailure = {
      channelLabels: { telegram: "Telegram" },
      channels: { telegram: { configured: true, running: true, connected: false } },
    };

    const { page, health, pending: pendingNudge } = await mountPendingNudge(telegramFailure);

    health(discordAuthFailure);
    health(telegramFailure);
    pendingNudge.resolve(chatReply("Telegram checked."));

    await waitForFast(() => expect(nudge(page)).toBeNull());
    health(telegramFailure);
    await page.updateComplete;
    expect(nudge(page)).toBeNull();
  });

  it("does not restore a failed nudge after health recovers while sending", async () => {
    const {
      page,
      health,
      pending: pendingNudge,
    } = await mountPendingNudge<never>({
      channels: { telegram: { configured: true, running: true, connected: false } },
    });

    health({ channels: { telegram: { configured: true, running: true, connected: true } } });
    pendingNudge.reject(new Error("Request failed"));

    await waitForFast(() => expect(alert(page)).not.toBeNull());
    await page.updateComplete;
    expect(nudge(page)).toBeNull();
  });
});
