/* @vitest-environment jsdom */
import { flush } from "solid-js";
import { describe, expect, it } from "vitest";
import {
  renderWizard,
  setupWizardTests,
  wizardInput,
  wizardStep,
} from "./wizard-view.test-support.ts";

setupWizardTests();

const buttonLabels = (container: HTMLElement) =>
  [...container.querySelectorAll("button")].map(
    (node) => node.getAttribute("aria-label") ?? node.textContent?.trim(),
  );

const button = (container: HTMLElement, label: string) =>
  [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (node) => node.textContent?.trim() === label,
  ) ?? expect.unreachable(`Missing ${label}`);

describe("ChannelWizard", () => {
  it.each([
    { sensitive: false, expectedType: "text" },
    { sensitive: true, expectedType: "password" },
  ])(
    "labels a $expectedType input and associates validation errors until recovery",
    ({ sensitive, expectedType }) => {
      const wizard = wizardStep(
        {
          id: "account-id",
          type: "text",
          message: "New Matrix account id",
          sensitive,
        },
        { channel: "matrix", busy: false },
      );
      const { container, update } = renderWizard(wizard);
      const input = wizardInput(container);
      const label = container.querySelector('label[for="channel-wizard-text-input"]');
      expect(label?.textContent).toBe("New Matrix account id");
      expect(input?.type).toBe(expectedType);
      expect(input?.labels).toContain(label);
      expect(container.querySelector(".oc-sensitive-toggle") !== null).toBe(sensitive);
      update({ wizard: { ...wizard, validationError: "That account id is not valid." } });
      const errorId = input?.getAttribute("aria-describedby");
      expect(input?.getAttribute("aria-invalid")).toBe("true");
      expect(document.getElementById(errorId ?? "")?.textContent).toContain(
        "That account id is not valid.",
      );
      update({ wizard });
      expect([
        input?.hasAttribute("aria-invalid"),
        input?.hasAttribute("aria-describedby"),
      ]).toEqual([false, false]);
    },
  );

  it("reveals only the replacement value entered in a sensitive step", () => {
    const view = renderWizard(
      wizardStep(
        {
          id: "client-secret",
          type: "text",
          message: "Twitch Client Secret",
          sensitive: true,
        },
        { channel: "twitch", busy: false },
      ),
    );
    const input = wizardInput(view.container);
    const toggle = view.container.querySelector<HTMLButtonElement>(".oc-sensitive-toggle");
    expect(input).toMatchObject({ type: "password", value: "" });
    expect(toggle?.getAttribute("aria-label")).toBe("Reveal value");
    expect(toggle?.dataset).toMatchObject({ sensitiveIcon: "eye" });
    if (input) {
      input.value = "new-secret";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
    toggle?.click();
    expect(view.onTextInput).toHaveBeenCalledWith("new-secret");
    expect(view.onToggleSecretVisibility).toHaveBeenCalledOnce();

    view.update({ secretVisible: true, textValue: "new-secret" });
    expect(wizardInput(view.container)).toMatchObject({ type: "text", value: "new-secret" });
    const hidden = view.container.querySelector<HTMLButtonElement>(".oc-sensitive-toggle");
    expect([hidden?.getAttribute("aria-label"), hidden?.getAttribute("aria-pressed")]).toEqual([
      "Hide value",
      "true",
    ]);
    expect(hidden).toMatchObject({
      dataset: { sensitiveIcon: "eye-off" },
    });
  });

  it("renders informational setup output as unpadded plain text", () => {
    const message = "iMessage — Local iMessage/SMS through the imsg bridge.";
    const { container } = renderWizard(
      wizardStep(
        {
          id: "selected-channels",
          type: "note",
          title: "Selected channels",
          message,
        },
        { channel: "imessage", busy: false },
      ),
      { channelLabel: () => "iMessage" },
    );
    expect(container.querySelector(".channels-wizard__output")?.textContent).toBe(message);
    expect(container.querySelector(".channels-wizard__note")).toBeNull();
    expect(container.querySelector(".channels-wizard__links button")).toBeNull();
  });

  it("offers a few described choices as cards answered with Continue", () => {
    const view = renderWizard(
      wizardStep(
        {
          id: "phone",
          type: "select",
          message: "Which phone will you link?",
          options: [
            { value: "personal", label: "My own WhatsApp", hint: "Only you can reach it." },
            { value: "separate", label: "A separate number", hint: "You approve people." },
          ],
          initialValue: "personal",
        },
        { channel: "whatsapp", busy: false },
      ),
    );
    const radios = [...view.container.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
    expect(view.container.querySelector('[role="radiogroup"]')?.getAttribute("aria-label")).toBe(
      "Which phone will you link?",
    );
    expect(radios.map((radio) => radio.getAttribute("aria-checked"))).toEqual(["true", "false"]);
    radios[1]?.click();
    flush();
    expect(radios.map((radio) => radio.getAttribute("aria-checked"))).toEqual(["false", "true"]);
    expect(view.onAnswer).not.toHaveBeenCalled();
    button(view.container, "Continue").click();
    expect(view.onAnswer).toHaveBeenCalledWith("separate");
  });

  it("links WhatsApp from the shown code without a separate wait action", () => {
    const done = { phase: "done", channel: "whatsapp", channels: ["whatsapp"], accounts: [] };
    const view = renderWizard(done as const, { whatsappBusy: true });
    expect(view.container.querySelector('[role="status"]')?.textContent).toBe("Getting a code");

    view.update({ whatsappQrDataUrl: "data:image/png,qr" });
    expect(view.container.querySelector<HTMLImageElement>("img")?.alt).toBe("WhatsApp QR");
    expect(view.container.querySelector('[role="status"]')?.textContent).toBe(
      "Waiting for a scanThe code refreshes on its own.",
    );
    expect(buttonLabels(view.container)).toEqual(["Close", "Cancel"]);

    view.update({ whatsappQrDataUrl: null, whatsappBusy: false, whatsappMessage: "QR expired." });
    expect(view.container.querySelector('[role="alert"]')?.textContent).toBe(
      "This code is no longer active.QR expired.",
    );
    button(view.container, "Get a new code").click();
    expect(view.onWhatsAppStart).toHaveBeenCalledWith(true);
  });

  it("waits on a personal phone for the first message, then opens its chat", () => {
    const done = { phase: "done", channel: "whatsapp", channels: ["whatsapp"], accounts: [] };
    const view = renderWizard(done as const, {
      whatsappConnected: true,
      whatsappStatus: { linked: true, self: { e164: "+15555550123" }, lastMessageAt: null },
      whatsappConfig: { channels: { whatsapp: { selfChatMode: true } } },
    });
    expect(view.container.textContent).toContain("WhatsApp is connected");
    expect(view.container.textContent).toContain("Message yourself");
    expect(view.container.querySelector('[role="status"]')?.textContent).toBe(
      "Waiting for your first message",
    );
    expect(buttonLabels(view.container)).toEqual(["Close", "Done"]);

    view.update({
      whatsappStatus: { linked: true, self: { e164: "+15555550123" }, lastMessageAt: 2_000 },
    });
    expect(view.container.textContent).toContain("Your agent got your message");
    expect(view.container.textContent).toContain("Replies show up in WhatsApp and in Chat.");
    button(view.container, "Open chat").click();
    expect(view.onOpenWhatsAppChat).toHaveBeenCalledOnce();
  });

  it("lets the owner allow the first person who texts a separate number", async () => {
    const done = { phase: "done", channel: "whatsapp", channels: ["whatsapp"], accounts: [] };
    const request = {
      requestId: "request-1",
      channel: "whatsapp",
      channelLabel: "WhatsApp",
      accountId: "default",
      senderId: "+15555550199",
      senderLabel: "Phone",
      createdAt: "2026-11-23T10:00:00.000Z",
      lastSeenAt: "2026-11-23T10:00:00.000Z",
      expiresAt: "2026-11-23T11:00:00.000Z",
      notifySupported: true,
    };
    const view = renderWizard(done as const, {
      whatsappConnected: true,
      whatsappStatus: { linked: true, self: { e164: "+15555550123" }, lastMessageAt: null },
      whatsappConfig: { channels: { whatsapp: { selfChatMode: false } } },
      pairing: {
        accounts: [],
        requests: [request],
        commandOwnerConfigured: true,
        limits: { pendingPerAccount: 3, ttlMs: 3_600_000 },
      },
    });
    expect(view.container.textContent).toContain("send a WhatsApp message to");
    expect(view.container.querySelector(".whatsapp-setup__request")?.textContent).toContain(
      "wants to talk to your agent.",
    );
    button(view.container, "Allow").click();
    expect(view.onWhatsAppAllow).toHaveBeenCalledWith(request);
    await Promise.resolve();
    flush();
    expect(view.container.textContent).toContain("can talk to your agent now.");
  });

  it("links channel docs from the setup subtitle without static helper links", () => {
    const { container } = renderWizard(
      {
        phase: "error",
        channel: "slack",
        message: "Setup failed",
      },
      { channelLabel: () => "Slack" },
    );
    const subtitle = container.querySelector(".channels-wizard__subtitle");
    expect(subtitle?.textContent?.replace(/\s+/gu, " ").trim()).toBe(
      "Guided channel setup View docs",
    );
    expect(subtitle?.querySelector<HTMLAnchorElement>(".channels-wizard__link")?.href).toBe(
      "https://docs.openclaw.ai/channels/slack",
    );
    expect(container.querySelector(".channels-wizard__links")).toBeNull();
  });
});
