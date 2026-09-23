/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
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
  inputDraft,
  inputDraftAtEnd,
  keydownComposer,
  replaceSkillCommands,
  requireElement,
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
    const renderedTextarea = container.querySelector<HTMLTextAreaElement>("textarea");
    expect(listbox?.getAttribute("aria-label")).toBe("Skill references");
    expect(listbox?.querySelector(".slash-menu-name")?.textContent).toBe("Prose Writer");
    expect(renderedTextarea?.getAttribute("aria-controls")).toBe("chat-single-skill-menu-listbox");
    expect(renderedTextarea?.hasAttribute("aria-expanded")).toBe(false);
    expect(renderedTextarea?.getAttribute("aria-haspopup")).toBe("listbox");
    expect(onSlashIntent).toHaveBeenCalledOnce();
  });

  it("wires command suggestions to the composer with stable active option ids", () => {
    const harness = createSlashRerenderHarness();
    const container = harness.inputAndRender(harness.container, "/");

    const wrapper = container.querySelector<HTMLElement>(".agent-chat__composer-combobox");
    const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
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
    expect(activeId).toMatch(/^chat-single-slash-option-command-/u);
    expect(listbox?.querySelector(`#${activeId}`)?.getAttribute("role")).toBe("option");
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
    const activeId = container
      .querySelector<HTMLTextAreaElement>("textarea")
      ?.getAttribute("aria-activedescendant");
    expect(options[1]?.id).toBe(activeId);
    expect(options[1]?.getAttribute("aria-selected")).toBe("true");

    keydownComposer(container, "Enter");
    container = harness.renderCurrent();
    expect(container.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("/pair-device ");
    expect(container.querySelector(".slash-menu")).toBeNull();
  });

  it("keeps a stable composer name when attachments change its placeholder", () => {
    const harness = createReactiveDraftHarness();
    const textarea = requireElement(
      harness.container,
      "textarea",
      "chat composer",
    ) as HTMLTextAreaElement;
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

  it("updates the active descendant and live announcement during command navigation", () => {
    const harness = createSlashRerenderHarness();
    let container = harness.inputAndRender(harness.container, "/");
    const initialActiveId = container
      .querySelector<HTMLTextAreaElement>("textarea")
      ?.getAttribute("aria-activedescendant");

    keydownComposer(container, "ArrowDown");
    container = harness.renderCurrent();

    const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
    const nextActiveId = textarea?.getAttribute("aria-activedescendant");
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
    const expectedAnnouncement = [
      activeOption?.querySelector(".slash-menu-name")?.textContent?.trim(),
      activeOption?.querySelector(".slash-menu-args")?.textContent?.trim(),
      activeOption?.querySelector(".slash-menu-desc")?.textContent?.trim(),
    ]
      .filter(Boolean)
      .join(" ");
    expect(announcementText).toBe(expectedAnnouncement);
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

  it("wires fixed argument suggestions with command-and-argument option ids", () => {
    const harness = createSlashRerenderHarness();
    const container = harness.inputAndRender(harness.container, "/tools ");

    const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
    const listbox = container.querySelector<HTMLElement>("#chat-single-slash-menu-listbox");
    const activeId = textarea?.getAttribute("aria-activedescendant");

    expect(listbox?.getAttribute("aria-label")).toBe("Command arguments");
    expect(activeId).toBe("chat-single-slash-option-arg-tools-compact");
    expect(listbox?.querySelector(`#${activeId}`)?.getAttribute("aria-selected")).toBe("true");
  });

  it.each([
    { name: "direct", sessionKey: "main", rowKey: "main" },
    { name: "global alias", sessionKey: "agent:work:main", rowKey: "global" },
  ])(
    "opens model-supported thinking arguments after tab-completing /think ($name)",
    ({ sessionKey, rowKey }) => {
      const sessions = createSessionsListResult({
        model: "gpt-5.6-sol",
        modelProvider: "openai",
      });
      const session = expectDefined(sessions.sessions[0], "active session");
      session.key = rowKey;
      session.thinkingLevels = [
        { id: "off", label: "off" },
        { id: "minimal", label: "minimal" },
        { id: "low", label: "low" },
        { id: "medium", label: "medium" },
        { id: "high", label: "high" },
        { id: "xhigh", label: "xhigh" },
        { id: "max", label: "max" },
        { id: "ultra", label: "ultra" },
      ];
      const { container } = createReactiveDraftHarness({
        sessions,
        sessionKey,
        selectedSession: session,
      });

      inputDraft(container, "/think");
      keydownComposer(container, "Tab");

      expect(container.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("/think ");
      expect(
        Array.from(container.querySelectorAll<HTMLElement>(".slash-menu [role='option']")).map(
          (option) => option.querySelector(".slash-menu-name")?.textContent?.trim(),
        ),
      ).toEqual(["default", "off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
    },
  );

  it("suppresses thinking arguments while the active model is switching", () => {
    const sessions = createSessionsListResult({
      model: "gpt-5.6-sol",
      modelProvider: "openai",
    });
    const session = expectDefined(sessions.sessions[0], "active session");
    session.thinkingLevels = [
      { id: "low", label: "low" },
      { id: "high", label: "high" },
    ];
    const { container } = createReactiveDraftHarness({
      modelSwitching: true,
      sessions,
      selectedSession: session,
    });

    inputDraft(container, "/think");
    keydownComposer(container, "Tab");

    expect(container.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("/think ");
    expect(container.querySelector(".slash-menu")).toBeNull();
  });

  it("closes open thinking arguments when the active model starts switching", () => {
    const sessions = createSessionsListResult({
      model: "gpt-5.6-sol",
      modelProvider: "openai",
    });
    const session = expectDefined(sessions.sessions[0], "active session");
    session.thinkingLevels = [
      { id: "low", label: "low" },
      { id: "high", label: "high" },
    ];
    const { container, renderCurrent } = createReactiveDraftHarness({
      sessions,
      selectedSession: session,
    });

    inputDraft(container, "/think");
    keydownComposer(container, "Tab");
    expect(container.querySelector(".slash-menu")).not.toBeNull();
    expect(
      container
        .querySelector<HTMLTextAreaElement>("textarea")
        ?.getAttribute("aria-activedescendant"),
    ).toBe("chat-single-slash-option-arg-think-default");

    renderCurrent({ modelSwitching: true });

    expect(container.querySelector(".slash-menu")).toBeNull();
    expect(
      container
        .querySelector<HTMLTextAreaElement>("textarea")
        ?.hasAttribute("aria-activedescendant"),
    ).toBe(false);
  });

  it("clears active descendant when suggestions close", () => {
    const harness = createSlashRerenderHarness();
    let container = harness.inputAndRender(harness.container, "/");
    const activeDescendant = container
      .querySelector<HTMLTextAreaElement>("textarea")
      ?.getAttribute("aria-activedescendant");
    if (!activeDescendant) {
      throw new Error("Expected slash suggestions to set aria-activedescendant");
    }

    container = harness.inputAndRender(container, "plain message");

    expect(container.querySelector(".slash-menu")).toBeNull();
    expect(
      container.querySelector<HTMLTextAreaElement>("textarea")?.hasAttribute("aria-expanded"),
    ).toBe(false);
    expect(
      container
        .querySelector<HTMLElement>(".agent-chat__composer-combobox")
        ?.hasAttribute("aria-expanded"),
    ).toBe(false);
    expect(
      container
        .querySelector<HTMLTextAreaElement>("textarea")
        ?.hasAttribute("aria-activedescendant"),
    ).toBe(false);
  });
});
