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
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
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
  vi.restoreAllMocks();
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
describe("chat composer suggestion accessibility", () => {
  it("hints free-form arguments only until the user starts typing", () => {
    const { container } = createReactiveDraftHarness();
    inputDraftAtEnd(container, "/steer");
    keydownComposer(container, "Tab");
    const textarea = getComposerTextarea(container);
    const hint = container.querySelector<HTMLElement>(".agent-chat__composer-placeholder")!;
    expect(textarea.value).toBe("/steer ");
    expect(textarea.placeholder).toBe("<message>");
    expect(hint.textContent).toBe("/steer <message>");
    expect(hint.style.display).toBe("block");

    for (const draft of ["/steer hello", "/steer  ", "/steer \n", "/steer", "/clear ", "/tools "]) {
      inputDraftAtEnd(container, draft);
      expect(hint.style.display, draft).toBe("");
      expect(textarea.placeholder, draft).not.toBe("<message>");
    }
  });

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
      expectAbsent(renderedTextarea, "role", "aria-expanded");
      expect(listbox?.getAttribute("aria-label")).toBe("Skill references");
      expect(listbox?.querySelector(".slash-menu-name")?.textContent).toBe("Prose Writer");
      expect(renderedTextarea.getAttribute("aria-controls")).toBe("chat-single-skill-menu-listbox");
      expect(renderedTextarea.getAttribute("aria-haspopup")).toBe("listbox");
      expect(onSlashIntent).toHaveBeenCalledOnce();
    });
    for (const draft of ["Use `$pro`", "```text\nUse $pro\n```"]) {
      inputDraftAtEnd(container, draft, draft.indexOf("$pro") + 4);
      expect(menu(container, "skill-menu-listbox"), draft).toBeNull();
    }
  });

  it.each(["/", "/tools "])(
    "keeps %s options accessible while navigating and closing",
    async (draft) => {
      const { container } = createReactiveDraftHarness();
      inputDraft(container, draft);

      const wrapper = container.querySelector<HTMLElement>(".agent-chat__composer-combobox");
      const textarea = getComposerTextarea(container);
      const listbox = await waitForSolid(() => {
        const rendered = expectDefined(menu(container), "slash command listbox");
        expect(rendered.querySelector('[aria-busy="true"]')).toBeNull();
        return rendered;
      });
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
      expect(announcementText).toBe(
        draft === "/" ? `${expectedAnnouncement}.` : expectedAnnouncement,
      );

      inputDraft(container, "plain message");

      expect(container.querySelector(".slash-menu")).toBeNull();
      expectAbsent(getComposerTextarea(container), "aria-expanded", "aria-activedescendant");
      expectAbsent(container.querySelector(".agent-chat__composer-combobox"), "aria-expanded");
    },
  );

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

  it("refreshes the current thinking argument menu after its catalog settles", async () => {
    const refresh = createDeferred();
    const { container } = createReactiveDraftHarness({
      ...thinkingSession(["low", "ultra"]),
      onSlashIntent: () => refresh.promise,
    });
    inputDraft(container, "/think");
    keydownComposer(container, "Tab");
    expect(getComposerTextarea(container).value).toBe("/think ");
    refresh.resolve();
    await refresh.promise;
    await waitForSolid(() => expect(optionNames(container)).toEqual(["default", "low", "ultra"]));
  });

  it("keeps the keyboard-selected command when a pending catalog refresh settles", async () => {
    replaceSlashCommands([
      { key: "pair", name: "pair", description: "Generate setup codes." },
      { key: "pair-device", name: "pair-device", description: "Pair a specific device." },
    ]);
    const refresh = createDeferred();
    const { container } = createReactiveDraftHarness({ onSlashIntent: () => refresh.promise });
    inputDraftAtEnd(container, "/pair");
    await waitForSolid(() => expect(optionNames(container)).toEqual(["/pair", "/pair-device"]));
    keydownComposer(container, "ArrowDown");
    const selectedId = activeId(container);
    expect(selectedId).toBe("chat-single-slash-option-command-pair-device");

    refresh.resolve();
    await refresh.promise;
    await Promise.resolve();
    flush();
    expect(activeId(container)).toBe(selectedId);
    expect(container.querySelector(`#${selectedId}`)?.getAttribute("aria-selected")).toBe("true");
    keydownComposer(container, "Enter");
    expect(getComposerTextarea(container).value).toBe("/pair-device ");
  });

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

it("leaves mobile Return for editing even with slash suggestions open", async () => {
  const draft = "/res";
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Android");
  replaceSlashCommands([
    { key: "reset", name: "reset", description: "Reset the session.", executeLocal: true },
  ]);
  const onSend = vi.fn();
  const { container } = createReactiveDraftHarness({ onSend });
  inputDraftAtEnd(container, draft);
  await waitForSolid(() => expect(container.querySelector(".slash-menu-item")).not.toBeNull());
  const textarea = getComposerTextarea(container)!;
  for (const modifiers of [{}, { ctrlKey: true }, { metaKey: true }]) {
    const event = keydownComposer(container, "Enter", modifiers);
    expect(event.defaultPrevented).toBe(false);
    expect(textarea.value).toBe(draft);
    expect(onSend).not.toHaveBeenCalled();
  }
});

// A slash token at the draft start is the draft's command, not an inline shortcut.
it.each([{ dispatchable: true }, { dispatchable: false }])(
  "offers native commands for a leading slash token before prose (dispatchable: $dispatchable)",
  async ({ dispatchable }) => {
    const onSend = vi.fn();
    const onSlashCommand = vi.fn();
    const { container, readDraft } = createReactiveDraftHarness({
      onSend,
      onSlashCommand,
      // The inline dispatch gate must not hide the draft's own command.
      ...(dispatchable ? {} : { submitDisabledReason: "Loading conversation" }),
    });
    const textarea = getComposerTextarea(container);
    const prose = " Apply the prompt to every surface";
    textarea.value = `/loo${prose}`;
    textarea.setSelectionRange(4, 4);
    textarea.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
    flush();

    await import("./components/chat-composer-slash-menu.tsx");
    await waitForSolid(() =>
      expect(container.querySelector(".slash-menu-name")?.textContent?.trim()).toContain("/loop"),
    );
    keydownComposer(container, "Enter");

    expect(onSlashCommand).not.toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();
    expect(readDraft()).toBe(`/loop${prose}`);
    expect(textarea.value).toBe(readDraft());
    expect(container.querySelector(".slash-menu")).toBeNull();

    if (dispatchable) {
      keydownComposer(container, "Enter");
      expect(onSlashCommand).not.toHaveBeenCalled();
      expect(onSend).toHaveBeenCalledOnce();
    }
  },
);

it("starts Goal mode with the prose behind a leading /goal token as its objective", async () => {
  const onGoalSubmit = vi.fn(async () => false);
  const onSend = vi.fn();
  const onSlashCommand = vi.fn();
  const { container, readDraft } = createReactiveDraftHarness({
    onGoalSubmit,
    onSend,
    onSlashCommand,
  });
  const textarea = getComposerTextarea(container);
  const objective = "Ship the composer fix\nwith proof";
  textarea.value = `/goa ${objective}`;
  textarea.setSelectionRange(4, 4);
  textarea.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
  flush();

  await import("./components/chat-composer-slash-menu.tsx");
  await waitForSolid(() =>
    expect(container.querySelector(".slash-menu-name")?.textContent?.trim()).toContain("/goal"),
  );
  keydownComposer(container, "Enter");

  await waitForSolid(() =>
    expect(container.querySelector(".agent-chat__goal-mode")).not.toBeNull(),
  );
  expect(getComposerTextarea(container).value).toBe(objective);
  expect(readDraft()).toBe(objective);
  expect(onSlashCommand).not.toHaveBeenCalled();
  expect(onSend).not.toHaveBeenCalled();
  expect(onGoalSubmit).not.toHaveBeenCalled();
});
