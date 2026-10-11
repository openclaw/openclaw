/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { nothing, render } from "lit";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { i18n, t } from "../../i18n/index.ts";
import {
  buildFallbackSlashCommands,
  replaceSlashCommands,
  SLASH_COMMANDS,
} from "../../lib/chat/commands.ts";
import { createSessionsListResult } from "../../test-helpers/chat-model.ts";
import { resetChatViewState } from "./chat-view-state.ts";
import {
  createReactiveDraftHarness,
  createSlashRerenderHarness,
  getComposerTextarea,
  inputDraft,
  inputDraftAtEnd,
  keydownComposer,
  replaceSkillCommands,
} from "./chat-view.test-helpers.ts";
import { installChatComposerPickerDismissal } from "./components/chat-picker-overlay.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";

beforeEach(() => {
  onTestFinished(installChatComposerPickerDismissal(document));
  installTranscriptDomMocks();
});

afterEach(() => {
  vi.useRealTimers();
  resetChatViewState();
  replaceSlashCommands(buildFallbackSlashCommands());
  resetTranscriptTestDom();
});

function thinkingSession(levels = ["low", "high"]) {
  const sessions = createSessionsListResult({
    model: "gpt-5.6-sol",
    modelProvider: "openai",
    thinkingLevels: levels.map((id) => ({ id, label: id })),
  });
  return { sessions, selectedSession: expectDefined(sessions.sessions[0], "active session") };
}

describe("chat composer suggestion accessibility", () => {
  it("opens a skill picker for $ references anywhere in a normal prompt", async () => {
    replaceSkillCommands({
      key: "prose_writer",
      skillDisplayName: "Prose Writer",
      description: "Draft polished prose.",
    });
    const onSlashIntent = vi.fn(async () => undefined);
    const { container } = createReactiveDraftHarness({ onSlashIntent });

    inputDraftAtEnd(container, "Polish this with $pro:");
    await Promise.resolve();
    await Promise.resolve();

    const listbox = container.querySelector<HTMLElement>("#chat-single-skill-menu-listbox");
    const renderedTextarea = getComposerTextarea(container);
    expect(listbox?.getAttribute("aria-label")).toBe("Skill references");
    expect(listbox?.querySelector(".slash-menu-name")?.textContent).toBe("Prose Writer");
    expect(renderedTextarea?.getAttribute("aria-controls")).toBe("chat-single-skill-menu-listbox");
    expect(renderedTextarea?.hasAttribute("aria-expanded")).toBe(false);
    expect(renderedTextarea?.getAttribute("aria-haspopup")).toBe("listbox");
    expect(onSlashIntent).toHaveBeenCalledOnce();
  });

  it.each(["/", "/tools "])("keeps %s options accessible while navigating and closing", (draft) => {
    const harness = createSlashRerenderHarness();
    let container = harness.inputAndRender(harness.container, draft);

    const wrapper = container.querySelector<HTMLElement>(".agent-chat__composer-combobox");
    const textarea = getComposerTextarea(container);
    const listbox = container.querySelector<HTMLElement>("#chat-single-slash-menu-listbox");
    const activeId = textarea?.getAttribute("aria-activedescendant");

    expect(wrapper?.hasAttribute("role")).toBe(false);
    expect(wrapper?.hasAttribute("aria-expanded")).toBe(false);
    expect(wrapper?.hasAttribute("aria-haspopup")).toBe(false);
    expect(wrapper?.hasAttribute("aria-controls")).toBe(false);
    expect(textarea?.hasAttribute("role")).toBe(false);
    expect(textarea?.hasAttribute("aria-expanded")).toBe(false);
    expect(textarea?.getAttribute("aria-haspopup")).toBe("listbox");
    expect(textarea?.getAttribute("aria-controls")).toBe("chat-single-slash-menu-listbox");
    expect(textarea?.getAttribute("aria-autocomplete")).toBe("list");
    expect(listbox?.getAttribute("role")).toBe("listbox");
    if (draft === "/") {
      expect(activeId).toMatch(/^chat-single-slash-option-command-/u);
    } else {
      expect(listbox?.getAttribute("aria-label")).toBe("Command arguments");
      expect(activeId).toBe("chat-single-slash-option-arg-tools-compact");
      expect(listbox?.querySelector(`#${activeId}`)?.getAttribute("aria-selected")).toBe("true");
    }
    expect(listbox?.querySelector(`#${activeId}`)?.getAttribute("role")).toBe("option");
    const initialActiveId = getComposerTextarea(container).getAttribute("aria-activedescendant");

    keydownComposer(container, "ArrowDown");
    container = harness.renderCurrent();

    const nextActiveId = getComposerTextarea(container).getAttribute("aria-activedescendant");
    const activeOption = nextActiveId
      ? container.querySelector<HTMLElement>(`#${nextActiveId}`)
      : null;
    const status = container.querySelector<HTMLElement>("#chat-single-slash-active-announcement");

    if (!nextActiveId) {
      throw new Error("Expected command navigation to set aria-activedescendant");
    }
    expect(nextActiveId).not.toBe(initialActiveId);
    expect(activeOption?.getAttribute("aria-selected")).toBe("true");
    expect(status?.getAttribute("aria-live")).toBe("polite");
    const announcementText = status?.textContent?.trim();
    if (!announcementText) {
      throw new Error("Expected command navigation to update the live announcement");
    }
    const expectedAnnouncement =
      draft === "/tools "
        ? `/tools ${activeOption?.querySelector(".slash-menu-name")?.textContent?.trim()}`
        : [
            activeOption?.querySelector(".slash-menu-name")?.textContent?.trim(),
            activeOption?.querySelector(".slash-menu-args")?.textContent?.trim(),
            activeOption?.querySelector(".slash-menu-desc")?.textContent?.trim(),
          ]
            .filter(Boolean)
            .join(" ");
    expect(announcementText).toBe(expectedAnnouncement);

    container = harness.inputAndRender(container, "plain message");

    expect(container.querySelector(".slash-menu")).toBeNull();
    expect(getComposerTextarea(container).hasAttribute("aria-expanded")).toBe(false);
    expect(
      container
        .querySelector<HTMLElement>(".agent-chat__composer-combobox")
        ?.hasAttribute("aria-expanded"),
    ).toBe(false);
    expect(getComposerTextarea(container).hasAttribute("aria-activedescendant")).toBe(false);
  });

  it("keeps filtered command DOM and keyboard order aligned with relevance", () => {
    replaceSlashCommands([
      {
        key: "pair",
        name: "pair",
        description: "Pair a device.",
        tier: "power",
        category: "tools",
      },
      {
        key: "pair-device",
        name: "pair-device",
        description: "Pair a specific device.",
        tier: "standard",
        category: "session",
      },
      {
        key: "openclaw",
        name: "openclaw",
        description: "Run the setup and repair helper.",
        tier: "essential",
        category: "tools",
      },
    ]);
    const harness = createSlashRerenderHarness();
    let container = harness.inputAndRender(harness.container, "/pair");

    expect(
      Array.from(container.querySelectorAll<HTMLElement>(".slash-menu [role='option']")).map(
        (option) => option.querySelector(".slash-menu-name")?.textContent?.trim(),
      ),
    ).toEqual(["/pair", "/pair-device", "/openclaw"]);
    expect(
      Array.from(container.querySelectorAll(".slash-menu-group__label")).map((label) =>
        label.textContent?.trim(),
      ),
    ).toEqual(["Tools", "Session", "Tools"]);

    keydownComposer(container, "ArrowDown");
    container = harness.renderCurrent();
    const options = container.querySelectorAll<HTMLElement>(".slash-menu [role='option']");
    const activeId = getComposerTextarea(container).getAttribute("aria-activedescendant");
    expect(options[1]?.id).toBe(activeId);
    expect(options[1]?.getAttribute("aria-selected")).toBe("true");

    keydownComposer(container, "Enter");
    container = harness.renderCurrent();
    expect(getComposerTextarea(container).value).toBe("/pair-device ");
    expect(container.querySelector(".slash-menu")).toBeNull();
  });

  it("keeps a stable composer name when attachments change its placeholder", () => {
    const harness = createReactiveDraftHarness();
    const textarea = getComposerTextarea(harness.container);
    const initialPlaceholder = textarea.placeholder;
    expect(textarea.getAttribute("aria-label")).toBe("Chat composer");
    expect(textarea.hasAttribute("role")).toBe(false);

    harness.renderCurrent({
      attachments: [
        {
          id: "image",
          fileName: "sample.png",
          mimeType: "image/png",
          previewUrl: "blob:sample-image",
          sizeBytes: 3,
        },
      ],
    });
    expect(harness.container.querySelector(".chat-attachment-thumb")).not.toBeNull();
    expect(textarea.placeholder).not.toBe(initialPlaceholder);
    expect(textarea.getAttribute("aria-label")).toBe("Chat composer");
    expect(textarea.hasAttribute("role")).toBe(false);

    harness.renderCurrent({ attachments: [] });
    expect(textarea.placeholder).toBe(initialPlaceholder);
    expect(textarea.getAttribute("aria-label")).toBe("Chat composer");
  });

  it("uses the localized command description in the live announcement", async () => {
    const clearCommand = SLASH_COMMANDS.find((command) => command.name === "clear");
    if (!clearCommand) {
      throw new Error("Expected the clear slash command");
    }
    const originalDescriptionKey = clearCommand.descriptionKey;
    clearCommand.descriptionKey = "common.health";
    await i18n.setLocale("zh-CN");
    try {
      const harness = createSlashRerenderHarness();
      const container = harness.inputAndRender(harness.container, "/clear");

      const status = container.querySelector<HTMLElement>("#chat-single-slash-active-announcement");
      expect(status?.textContent?.trim()).toBe(`/clear ${t("common.health")}`);
    } finally {
      clearCommand.descriptionKey = originalDescriptionKey;
      await i18n.setLocale("en");
    }
  });

  it.each([
    { command: "think", dismissed: false },
    { command: "tools", dismissed: true },
  ])(
    "settles /$command argument refresh with dismissal=$dismissed",
    async ({ command, dismissed }) => {
      const refresh = createDeferred();
      const { container } = createReactiveDraftHarness({
        ...(dismissed
          ? {}
          : thinkingSession(["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"])),
        onSlashIntent: () => refresh.promise,
      });
      inputDraft(container, `/${command}`);
      keydownComposer(container, "Tab");
      expect(getComposerTextarea(container).value).toBe(`/${command} `);
      if (dismissed) {
        expect(container.querySelector(".slash-menu")).not.toBeNull();
        keydownComposer(container, "Escape");
      }
      refresh.resolve();
      await refresh.promise;
      await Promise.resolve();
      if (dismissed) {
        expect(container.querySelector(".slash-menu")).toBeNull();
      } else {
        expect(
          Array.from(container.querySelectorAll<HTMLElement>(".slash-menu [role='option']")).map(
            (option) => option.querySelector(".slash-menu-name")?.textContent?.trim(),
          ),
        ).toEqual(["default", "off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
      }
    },
  );

  it.each([false, true])(
    "suppresses thinking arguments when switching starts after opening=%s",
    (opened) => {
      const { container, renderCurrent } = createReactiveDraftHarness({
        ...thinkingSession(),
        modelSwitching: !opened,
      });
      inputDraft(container, "/think");
      keydownComposer(container, "Tab");
      expect(getComposerTextarea(container).value).toBe("/think ");
      if (opened) {
        expect(container.querySelector(".slash-menu")).not.toBeNull();
        expect(getComposerTextarea(container).getAttribute("aria-activedescendant")).toBe(
          "chat-single-slash-option-arg-think-default",
        );
        renderCurrent({ modelSwitching: true });
      }
      expect(container.querySelector(".slash-menu")).toBeNull();
      expect(getComposerTextarea(container).hasAttribute("aria-activedescendant")).toBe(false);
    },
  );

  it("does not revive a finished composer after a queued selection event", () => {
    let verifyFinished: () => void = () => undefined;
    // Finish hooks unwind in reverse registration order.
    onTestFinished(() => verifyFinished());
    const { container } = createReactiveDraftHarness();
    const textarea = getComposerTextarea(container);
    verifyFinished = () => {
      try {
        expect(container.querySelector("textarea")).toBeNull();
        textarea.dispatchEvent(new Event("select", { bubbles: true }));
        expect(container.querySelector("textarea")).toBeNull();
      } finally {
        render(nothing, container);
        resetChatViewState();
      }
    };
    textarea.value = "$queued";
  });
});
