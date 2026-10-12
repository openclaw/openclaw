import { beforeAll, describe, expect, it } from "vitest";
import "../../styles.css";
import { warmJson5 } from "../../lib/json5-runtime.ts";
import { renderAppearance } from "./config-view.test-support.ts";

describe("chat appearance preferences", () => {
  beforeAll(async () => {
    await warmJson5();
  });

  it("validates and changes the browser-local chat width", () => {
    const { container, props } = renderAppearance({});
    const input = container.querySelector<HTMLInputElement>("[data-settings-chat-message-width]");
    expect(input).not.toBeNull();

    input!.value = " min(1280px,  82%) ";
    input!.dispatchEvent(new Event("change", { bubbles: true }));
    expect(props.onAppearanceChange).toHaveBeenCalledWith({
      chatMessageMaxWidth: "min(1280px, 82%)",
    });

    input!.value = "960px; color: red";
    input!.dispatchEvent(new Event("change", { bubbles: true }));
    expect(input!.validationMessage).not.toBe("");
    expect(props.onAppearanceChange).toHaveBeenCalledTimes(1);
  });

  it("marks browser follow-up overrides and resets them to the server", () => {
    const { container, props } = renderAppearance({
      chatFollowUpMode: "queue",
      chatFollowUpModeOverridden: true,
      serverQueueMode: "steer",
    });

    expect(container.textContent).toContain("Overriding server default (steer)");
    const reset = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "Reset to server default",
    );
    expect(reset).toBeDefined();
    reset?.click();
    expect(props.resetChatFollowUpMode).toHaveBeenCalledOnce();
    expect(props.onAppearanceChange).not.toHaveBeenCalled();
  });
});
