/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import type {
  ControlUiReplacement,
  ControlUiSurface,
} from "../../../../src/plugin-sdk/control-ui.js";
import type { ApplicationContext } from "../../app/context.ts";
import { createInertViewHost } from "../../plugins/control-ui-view.test-support.ts";
import {
  createApplicationContextProvider,
  createApplicationGateway,
} from "../../test-helpers/application-context.ts";
import { cleanupSolid } from "../../test-helpers/mount-solid.ts";
import { restorePropertyDescriptor } from "../../test-helpers/property-descriptor.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { resetComposerFixture } from "./chat-composer.test-support.ts";
import { resetChatViewState } from "./chat-view-state.test-support.ts";
import { createChatProps, disposeChatView, renderChatPropsInto } from "./chat-view.test-helpers.ts";
import type { ChatProps } from "./chat-view.tsx";
import { questionPanelIn } from "./components/chat-question-card.test-support.ts";
import "../../plugins/control-ui-view.solid.tsx";
import "../../plugins/control-ui-contributions.solid.tsx";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";

const fontsDescriptor = Object.getOwnPropertyDescriptor(document, "fonts");
beforeEach(() => {
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: Object.assign(new EventTarget(), { ready: Promise.resolve() }),
  });
});

afterEach(async () => {
  cleanupSolid();
  resetChatViewState();
  resetTranscriptTestDom();
  await resetComposerFixture();
  restorePropertyDescriptor(document, "fonts", fontsDescriptor);
});

function createPluginChat(replacement: ControlUiReplacement<"composer">, initiallySelected = true) {
  installTranscriptDomMocks();
  const lifetime = new AbortController();
  const pluginHost = createInertViewHost(lifetime.signal);
  const registration = {
    key: `questions/${replacement.id}`,
    pluginId: "questions",
    signal: lifetime.signal,
    host: pluginHost,
    value: replacement,
  };
  let selected = initiallySelected;
  const listeners = new Set<() => void>();
  const context = {
    gateway: createApplicationGateway().gateway,
    agentSelection: { state: { selectedId: "main" }, subscribe: () => () => undefined },
    plugins: {
      registrations: () => [],
      selectedReplacement: (surface: ControlUiSurface) =>
        surface === "composer" && selected ? registration : undefined,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      reportError: vi.fn(),
    },
  } as unknown as ApplicationContext;
  const provider = document.body.appendChild(createApplicationContextProvider(context));
  const query = <T extends Element = HTMLElement>(selector: string) =>
    provider.querySelector<T>(selector);
  onTestFinished(() => {
    disposeChatView(provider);
    lifetime.abort();
    provider.remove();
  });
  function render(overrides: Partial<ChatProps>) {
    renderChatPropsInto(
      provider,
      createChatProps({ sessionKey: "agent:main:main", ...overrides }),
      context,
    );
  }
  return {
    provider,
    render,
    query,
    text: (selector: string) => query(selector)?.textContent,
    count: (selector: string) => provider.querySelectorAll(selector).length,
    selectReplacement: () => {
      selected = true;
      for (const listener of listeners) {
        listener();
      }
    },
  };
}

function composerReplacement(
  mount: ControlUiReplacement<"composer">["mount"],
): ControlUiReplacement<"composer"> {
  return { id: "custom-draft", label: "Custom draft", surface: "composer", mount };
}

it("keeps an async question actionable beside a nondelegating composer", async () => {
  const { provider, render, selectReplacement, count, query, text } = createPluginChat(
    composerReplacement((container) => {
      const input = document.createElement("textarea");
      input.setAttribute("aria-label", "Custom draft");
      input.value = "Keep the plugin draft.";
      container.append(input);
      return undefined;
    }),
    false,
  );
  const submit = vi.fn(async () => true);
  render({
    paneId: "plugin-question",
    messages: [
      {
        role: "assistant",
        content: "Which audience?",
        openclawAsyncDelivery: {
          itemId: "audience",
          questions: [{ title: "Which audience?", options: ["Engineers", "Everyone"] }],
        },
      },
    ],
    onAsyncQuestionSubmit: submit,
  });
  selectReplacement();
  await questionPanelIn(provider);
  await waitForSolid(() => {
    expect(count("openclaw-chat-question-panel")).toBe(1);
    expect(count('textarea[aria-label="Custom draft"]')).toBe(1);
    expect(count(".agent-chat__composer-combobox textarea")).toBe(0);
  });
  const answer = query<HTMLInputElement>(".chat-question-panel__other")!;
  answer.value = "New contributors";
  answer.dispatchEvent(new Event("input", { bubbles: true }));
  flush();
  query<HTMLButtonElement>(".chat-question-panel__advance")!.click();
  await vi.waitFor(() => {
    expect(submit).toHaveBeenCalledExactlyOnceWith(
      "> Which audience?\n\nNew contributors",
      "audience",
      undefined,
    );
    expect(query("openclaw-chat-question-panel")).toBeNull();
    expect(text(".chat-question-summary")).toContain("New contributors");
  });
  expect(query<HTMLTextAreaElement>('textarea[aria-label="Custom draft"]')?.value).toBe(
    "Keep the plugin draft.",
  );
});

it("keeps one actionable local queue row with a nondelegating plugin composer", async () => {
  const { render, query, count } = createPluginChat(
    composerReplacement((container) => {
      container.textContent = "Custom draft";
      return undefined;
    }),
  );
  const onQueueRemove = vi.fn();
  render({
    paneId: "plugin-queue-nondelegating",
    queue: [
      {
        id: "local-row",
        sendRunId: "accepted-run",
        sessionKey: "agent:main:main",
        text: "Keep this editable",
        createdAt: 100,
        sendState: "waiting-idle",
      },
    ],
    onQueueRemove,
  });
  flush();
  await waitForSolid(() => expect(count(".chat-queue__item")).toBe(1));
  const row = query(".chat-queue__item");
  expect(row?.getAttribute("data-chat-queue-item")).toBe("local-row");
  row?.querySelector<HTMLButtonElement>(".chat-queue__remove")?.click();
  expect(onQueueRemove).toHaveBeenCalledExactlyOnceWith("local-row");
});

it("keeps mobile conversation presentation live through a delegated composer", async () => {
  const { render, query, text } = createPluginChat(
    composerReplacement((container, view) => ({ dispose: view.mountDefault(container) })),
  );
  const onRefresh = vi.fn();
  const initial = createChatProps({
    paneId: "mobile-presentation",
    mobileComposer: true,
    loading: true,
    draft: "Retain this draft",
    runError: { summary: "Request interrupted.\nPlease check the conversation." },
    onRefresh,
  });
  render(initial);
  await waitForSolid(() => {
    expect(query(".chat-conversation-loading")).not.toBeNull();
    expect(text(".chat-error--mobile")).toContain("Couldn’t finish this reply");
  });
  const textarea = query<HTMLTextAreaElement>("textarea")!;
  textarea.setSelectionRange(2, 5);
  query<HTMLButtonElement>(".chat-error__refresh")!.click();
  expect(onRefresh).toHaveBeenCalledOnce();

  render({ ...initial, mobileComposer: false });
  await waitForSolid(() => {
    expect(query(".chat-conversation-loading")).toBeNull();
    expect(query(".chat-error--mobile")).toBeNull();
    expect(text(".chat-error")).toContain(
      "Couldn't finish this reply. Check the conversation before trying again.",
    );
  });
  expect(query("textarea")).toBe(textarea);
  expect(textarea.value).toBe("Retain this draft");
  expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([2, 5]);
});
