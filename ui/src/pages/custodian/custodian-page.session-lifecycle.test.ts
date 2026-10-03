/* @vitest-environment jsdom */

import { GatewayProtocolRequestError } from "@openclaw/gateway-client/browser";
import { buildSystemAgentSessionInvalidatedErrorDetails } from "@openclaw/gateway-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { createContext, mountPage } from "./custodian-page.test-harness.ts";

type Page = Awaited<ReturnType<typeof mountPage>>["page"];
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

async function input(page: Page, value: string, selector = "textarea") {
  const field = page.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!;
  field.value = value;
  field.dispatchEvent(new Event("input"));
  await page.updateComplete;
  return field;
}
async function mount(request: ReturnType<typeof vi.fn>) {
  const { page } = await mountPage(createContext(request).context);
  await waitForFast(() => expect(page.textContent).toContain("Ready."));
  return page;
}
function click(page: Page, selector: string) {
  page.querySelector<HTMLButtonElement>(selector)!.click();
}

describe("custodian page session lifecycle", () => {
  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("retires sensitive input when cancelling an invalidated session", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ ...reply("Ready."), sensitive: true, question })
      .mockRejectedValueOnce(invalidated())
      .mockResolvedValueOnce(reply("Fresh session."));
    const page = await mount(request);
    await input(page, secret, 'input[type="password"]');
    click(page, ".option-card__skip");
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
      const page = await mount(request);
      await input(page, secret, 'input[type="password"]');
      click(
        page,
        action === "submit" ? ".custodian__wizard-step .btn.primary" : ".custodian__wizard-cancel",
      );
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

  it.each(["composer", "invalidated wizard"])(
    "restores an ordinary draft after a sensitive %s",
    async (prompt) => {
      const wizard = prompt === "invalidated wizard";
      const request = vi
        .fn()
        .mockResolvedValueOnce({ ...reply("Ready."), question })
        .mockResolvedValueOnce({
          ...reply("Enter credential."),
          sensitive: true,
          ...(wizard ? { wizardInputPending: true, step } : { question }),
        })
        .mockImplementationOnce(() => {
          if (wizard) {
            throw invalidated();
          }
          return reply("Ready again.");
        })
        .mockResolvedValue(reply("Ready again."));
      const page = await mount(request);
      const draft = "Keep my ordinary question";
      await input(page, draft);
      click(page, ".option-card__choice");
      await waitForFast(() => expect(page.querySelector('input[type="password"]')).not.toBeNull());
      expect(page.querySelector<HTMLInputElement>('input[type="password"]')!.value).toBe("");
      expect(request.mock.calls[1]?.[1]?.message).toBe("enter");
      await input(page, secret, 'input[type="password"]');
      click(page, wizard ? ".custodian__wizard-cancel" : ".option-card__skip:not([disabled])");
      await waitForFast(() => expect(page.textContent).toContain("Ready again."));
      const restored = page.querySelector<HTMLTextAreaElement>("textarea")!;
      expect(restored.value).toBe(draft);
      expect(page.textContent).not.toContain(secret);
      expect(request.mock.calls.some(([, params]) => params.message === secret)).toBe(false);
      if (wizard) {
        expect(request.mock.calls[3]?.[1]).not.toHaveProperty("wizardCancel");
      }
      restored.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await waitForFast(() => expect(request.mock.calls.at(-1)?.[1]?.message).toBe(draft));
      await page.updateComplete;
      expect(restored.value).toBe("");
    },
  );

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
    const page = await mount(request);
    [...page.querySelectorAll<HTMLButtonElement>(".custodian__wizard-step button:not([disabled])")]
      .find((button) => button.textContent?.trim() === "Twitch")!
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
      const page = await mount(request);
      await input(page, "first try");
      click(page, ".chat-send-btn");
      await waitForFast(() => expect(page.textContent).toContain("Temporary request failure."));
      expect(page.querySelector<HTMLTextAreaElement>("textarea")!.value).toBe(
        sent ? "" : "first try",
      );
      expect(page.store.messages.filter((message) => message.role === "user")).toHaveLength(
        sent ? 1 : 0,
      );
      await input(page, "second try");
      click(page, ".chat-send-btn");
      await waitForFast(() => expect(page.textContent).toContain("Still together."));
      expect(request).toHaveBeenCalledTimes(3);
      expect(request.mock.calls[2]?.[1]).toMatchObject({
        sessionId: "engine-session",
        message: "second try",
      });
    },
  );

  it("stops after one rotation when the fresh session failure is also marked", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(reply("Ready."))
      .mockRejectedValueOnce(invalidated())
      .mockRejectedValueOnce(invalidated());
    const page = await mount(request);
    await input(page, "status please");
    click(page, ".chat-send-btn");
    await waitForFast(() => expect(page.store.sending).toBe(false));
    expect(page.textContent).toContain("The live session was lost.");
    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls[2]?.[1]).not.toHaveProperty("message");
  });
});
