import { beforeAll, describe, expect, it } from "vitest";
import "../../styles.css";
import { registerTerminalEnglish } from "../../i18n/locales/en-terminal.ts";
import { warmJson5 } from "../../lib/json5-runtime.ts";
import { registerEnglishCatalog } from "../../lib/reactive/i18n.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import { renderAppearance, renderConfigInto } from "./config-view.test-support.tsx";

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

  it("keeps uncommitted text drafts through settings and translation refreshes", () => {
    const { container, props } = renderAppearance({});
    const width = container.querySelector<HTMLInputElement>("[data-settings-chat-message-width]");
    const terminal = container.querySelector<HTMLInputElement>("[data-settings-terminal-font]");
    expect(width).not.toBeNull();
    expect(terminal).not.toBeNull();

    width!.focus();
    width!.value = "max-content";
    width!.dispatchEvent(new Event("input", { bubbles: true }));
    terminal!.value = "Iosevka";
    renderConfigInto({ ...props, connected: true, chatShowTaskProgress: false }, container);
    expect(container.querySelector("[data-settings-chat-message-width]")).toBe(width);
    expect(width!.value).toBe("max-content");
    expect(terminal!.value).toBe("Iosevka");
    expect(props.onAppearanceChange).not.toHaveBeenCalled();

    // Complete a lazy catalog even if another test already registered this one.
    registerEnglishCatalog(() => registerTerminalEnglish());
    flush();
    expect(terminal!.value).toBe("Iosevka");
    expect(width!.value).toBe("max-content");

    width!.dispatchEvent(new Event("change", { bubbles: true }));
    expect(props.onAppearanceChange).toHaveBeenCalledWith({ chatMessageMaxWidth: "max-content" });
    renderConfigInto(
      { ...props, chatMessageMaxWidth: "48rem", terminalFontFamily: "Menlo" },
      container,
    );
    expect(width!.value).toBe("48rem");
    expect(terminal!.value).toBe("Menlo");
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
