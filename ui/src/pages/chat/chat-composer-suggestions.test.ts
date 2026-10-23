/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { i18n, t } from "../../i18n/index.ts";
import {
  buildFallbackSlashCommands,
  replaceSlashCommands,
  SLASH_COMMANDS,
} from "../../lib/chat/commands.ts";
import { createSessionsListResult } from "../../test-helpers/chat-model.ts";
import { cleanupSolid } from "../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { resetChatViewState } from "./chat-view-state.test-support.ts";
import {
  createReactiveDraftHarness,
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

function expectAbsent(element: Element | null, ...names: string[]) {
  for (const name of names) {
    expect(element?.hasAttribute(name), name).toBe(false);
  }
}
const text = (element: Element | null, selector: string) =>
  element?.querySelector(selector)?.textContent?.trim();
const optionNames = (container: HTMLElement) =>
  Array.from(container.querySelectorAll(".slash-menu [role='option']"), (option) =>
    option.querySelector(".slash-menu-name")?.textContent?.trim(),
  );
const activeId = (container: HTMLElement) =>
  getComposerTextarea(container).getAttribute("aria-activedescendant");
const menu = (container: HTMLElement, suffix = "slash-menu-listbox") =>
  container.querySelector(`#chat-single-${suffix}`);
function expectComposerName(textarea: HTMLTextAreaElement) {
  expect(textarea.getAttribute("aria-label")).toBe("Chat composer");
  expectAbsent(textarea, "role");
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
    await waitForSolid(() => {
      const listbox = menu(container, "skill-menu-listbox");
      const renderedTextarea = getComposerTextarea(container);
      expect(listbox?.getAttribute("aria-label")).toBe("Skill references");
      expect(listbox?.querySelector(".slash-menu-name")?.textContent).toBe("Prose Writer");
      expect(renderedTextarea.getAttribute("aria-controls")).toBe("chat-single-skill-menu-listbox");
      expectAbsent(renderedTextarea, "aria-expanded");
      expect(renderedTextarea.getAttribute("aria-haspopup")).toBe("listbox");
      expect(onSlashIntent).toHaveBeenCalledOnce();
    });
  });

  it.each(["/", "/tools "])("keeps %s options accessible while navigating and closing", (draft) => {
    const { container } = createReactiveDraftHarness();
    inputDraft(container, draft);

    const wrapper = container.querySelector<HTMLElement>(".agent-chat__composer-combobox");
    const textarea = getComposerTextarea(container);
    const listbox = menu(container);
    const initialActiveId = activeId(container);

    expectAbsent(wrapper, "role", "aria-expanded", "aria-haspopup", "aria-controls");
    expectAbsent(textarea, "role", "aria-expanded");
    expect(textarea.getAttribute("aria-haspopup")).toBe("listbox");
    expect(textarea.getAttribute("aria-controls")).toBe("chat-single-slash-menu-listbox");
    expect(textarea.getAttribute("aria-autocomplete")).toBe("list");
    expect(listbox?.getAttribute("role")).toBe("listbox");
    if (draft === "/") {
      expect(initialActiveId).toMatch(/^chat-single-slash-option-command-/u);
    } else {
      expect(listbox?.getAttribute("aria-label")).toBe("Command arguments");
      expect(initialActiveId).toBe("chat-single-slash-option-arg-tools-compact");
      expect(listbox?.querySelector(`#${initialActiveId}`)?.getAttribute("aria-selected")).toBe(
        "true",
      );
    }
    expect(listbox?.querySelector(`#${initialActiveId}`)?.getAttribute("role")).toBe("option");

    keydownComposer(container, "ArrowDown");

    const nextActiveId = expectDefined(activeId(container), "active descendant");
    const activeOption = container.querySelector(`#${nextActiveId}`);
    const status = menu(container, "slash-active-announcement");

    expect(nextActiveId).not.toBe("");
    expect(nextActiveId).not.toBe(initialActiveId);
    expect(activeOption?.getAttribute("aria-selected")).toBe("true");
    expect(status?.getAttribute("aria-live")).toBe("polite");
    const announcementText = expectDefined(status?.textContent?.trim(), "announcement");
    expect(announcementText).not.toBe("");
    const expectedAnnouncement =
      draft === "/tools "
        ? `/tools ${text(activeOption, ".slash-menu-name")}`
        : [".slash-menu-name", ".slash-menu-args", ".slash-menu-desc"]
            .map((selector) => text(activeOption, selector))
            .filter(Boolean)
            .join(" ");
    expect(announcementText).toBe(expectedAnnouncement);

    inputDraft(container, "plain message");

    expect(container.querySelector(".slash-menu")).toBeNull();
    expectAbsent(getComposerTextarea(container), "aria-expanded", "aria-activedescendant");
    expectAbsent(container.querySelector(".agent-chat__composer-combobox"), "aria-expanded");
  });

  it("keeps a stable composer name when attachments change its placeholder", async () => {
    const harness = createReactiveDraftHarness();
    const textarea = getComposerTextarea(harness.container);
    const initialPlaceholder = textarea.placeholder;
    expectComposerName(textarea);

    harness.renderCurrent({
      attachments: [{ id: "image", mimeType: "image/png", previewUrl: "blob:sample-image" }],
    });
    await waitForSolid(() =>
      expect(harness.container.querySelector(".chat-attachment-thumb")).not.toBeNull(),
    );
    expect(textarea.placeholder).not.toBe(initialPlaceholder);
    expectComposerName(textarea);

    harness.renderCurrent({ attachments: [] });
    expect(textarea.placeholder).toBe(initialPlaceholder);
    expect(textarea.getAttribute("aria-label")).toBe("Chat composer");
  });

  it("uses the localized command description in the live announcement", async () => {
    const clearCommand = expectDefined(
      SLASH_COMMANDS.find((command) => command.name === "clear"),
      "clear slash command",
    );
    const originalDescriptionKey = clearCommand.descriptionKey;
    clearCommand.descriptionKey = "common.health";
    await i18n.setLocale("zh-CN");
    try {
      const { container } = createReactiveDraftHarness();
      inputDraft(container, "/clear");

      const status = menu(container, "slash-active-announcement");
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
        ...(dismissed ? {} : thinkingSession(["low", "ultra"])),
        onSlashIntent: () => refresh.promise,
      });
      inputDraft(container, `/${command}`);
      keydownComposer(container, "Tab");
      expect(getComposerTextarea(container).value).toBe(`/${command} `);
      if (dismissed) {
        expect(container.querySelector(".slash-menu")).not.toBeNull();
        getComposerTextarea(container).focus();
        const escape = keydownComposer(container, "Escape");
        expect(escape.defaultPrevented).toBe(true);
        expect(container.querySelector(".slash-menu")).toBeNull();
      }
      refresh.resolve();
      await refresh.promise;
      await waitForSolid(() => {
        if (dismissed) {
          expect(container.querySelector(".slash-menu")).toBeNull();
        } else {
          expect(optionNames(container)).toEqual(["default", "low", "ultra"]);
        }
      });
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
        expect(activeId(container)).toBe("chat-single-slash-option-arg-think-default");
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
    onTestFinished(cleanupSolid);
    const textarea = getComposerTextarea(container);
    verifyFinished = () => {
      try {
        expect(container.querySelector("textarea")).toBeNull();
        textarea.dispatchEvent(new Event("select", { bubbles: true }));
        expect(container.querySelector("textarea")).toBeNull();
      } finally {
        cleanupSolid();
        resetChatViewState();
      }
    };
    textarea.value = "$queued";
  });
});

it.each(["A mobile draft", "/res"])("leaves mobile Return for editing %s", async (draft) => {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Android");
  onTestFinished(() => {
    vi.restoreAllMocks();
  });
  replaceSlashCommands([
    { key: "reset", name: "reset", description: "Reset the session.", executeLocal: true },
  ]);
  const onSend = vi.fn();
  const { container } = createReactiveDraftHarness({ onSend });
  inputDraftAtEnd(container, draft);
  if (draft.startsWith("/")) {
    await waitForSolid(() => expect(container.querySelector(".slash-menu-item")).not.toBeNull());
  }
  const textarea = getComposerTextarea(container)!;
  for (const modifiers of [{}, { ctrlKey: true }, { metaKey: true }]) {
    const event = keydownComposer(container, "Enter", modifiers);
    expect(event.defaultPrevented).toBe(false);
    expect(textarea.value).toBe(draft);
    expect(onSend).not.toHaveBeenCalled();
  }
});
