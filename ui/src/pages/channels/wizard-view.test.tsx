/* @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import {
  renderWizard,
  setupWizardTests,
  wizardInput,
  wizardStep,
} from "./wizard-view.test-support.ts";

setupWizardTests();

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
