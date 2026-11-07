/* @vitest-environment jsdom */

import { createComponent, createSignal } from "solid-js";
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
import { cleanupSolid, mountSolid } from "../../test-helpers/mount-solid.ts";
import { restorePropertyDescriptor } from "../../test-helpers/property-descriptor.ts";
import { createSolidApplicationContextProvider } from "../../test-helpers/solid-application-context.tsx";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { resetComposerFixture } from "./chat-composer.test-support.ts";
import { resetChatViewState } from "./chat-view-state.test-support.ts";
import { createChatProps } from "./chat-view.test-helpers.ts";
import { ChatView, type ChatProps } from "./chat-view.tsx";
import { createComposerQuestions } from "./components/chat-composer-questions.ts";
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

function createPluginChat(
  replacement?: ControlUiReplacement<"composer">,
  initiallySelected = true,
) {
  installTranscriptDomMocks();
  const lifetime = new AbortController();
  const pluginHost = createInertViewHost(lifetime.signal);
  const reportError = vi.fn();
  const registration = replacement && {
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
      reportError,
    },
  } as unknown as ApplicationContext;
  const provider = document.body.appendChild(createApplicationContextProvider(context));
  let current: ChatProps;
  let update: ((next: ChatProps) => void) | undefined;
  function render(overrides: Partial<ChatProps>) {
    const props = createChatProps({ sessionKey: "agent:main:main", ...overrides });
    current = props;
    if (update) {
      update(props);
    } else {
      const view = mountSolid(
        () => {
          const [value, setValue] = createSignal(props);
          const questions = createComposerQuestions(props.paneId, value);
          update = (next) => setValue(() => next);
          return createComponent(ChatView, {
            get props() {
              return value();
            },
            questions,
          });
        },
        {
          container: provider,
          wrapper: createSolidApplicationContextProvider(context).wrapper,
        },
      );
      onTestFinished(() => {
        view.unmount();
        current.transcript.dispose();
        lifetime.abort();
        provider.remove();
      });
    }
    flush();
    props.transcript.start();
    props.transcript.update();
    flush();
  }
  return {
    provider,
    render,
    reportError,
    count: (selector: string) => provider.querySelectorAll(selector).length,
    selectReplacement: () => {
      selected = true;
      for (const listener of listeners) {
        listener();
      }
    },
  };
}

it.each([
  { mode: "nondelegating", action: "submit" },
  { mode: "delegated", action: "skip" },
  { mode: "failing", action: "submit" },
] as const)(
  "keeps one usable async question when switching to a $mode plugin composer",
  async ({ mode, action }) => {
    const { provider, render, reportError, selectReplacement, count } = createPluginChat(
      {
        id: "custom-draft",
        label: "Custom draft",
        surface: "composer",
        mount(container, view) {
          if (mode === "failing") {
            throw new Error("Synthetic composer mount failure");
          }
          if (mode === "delegated") {
            return { dispose: view.mountDefault(container) };
          }
          const input = document.createElement("textarea");
          input.setAttribute("aria-label", "Custom draft");
          input.value = "Keep the plugin draft.";
          container.append(input);
          return undefined;
        },
      },
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
      expect(count('textarea[aria-label="Custom draft"]')).toBe(mode === "nondelegating" ? 1 : 0);
      expect(count(".agent-chat__composer-combobox textarea")).toBe(
        mode === "nondelegating" ? 0 : 1,
      );
    });
    expect(reportError).toHaveBeenCalledTimes(mode === "failing" ? 1 : 0);
    const answer = provider.querySelector<HTMLInputElement>(".chat-question-panel__other")!;
    answer.value = "New contributors";
    answer.dispatchEvent(new Event("input", { bubbles: true }));
    flush();
    provider
      .querySelector<HTMLButtonElement>(
        `.chat-question-panel__${action === "submit" ? "advance" : "skip"}`,
      )!
      .click();
    await vi.waitFor(() => {
      if (action === "submit") {
        expect(submit).toHaveBeenCalledExactlyOnceWith(
          "> Which audience?\n\nNew contributors",
          "audience",
          undefined,
        );
      } else {
        expect(submit).not.toHaveBeenCalled();
      }
      expect(provider.querySelector("openclaw-chat-question-panel")).toBeNull();
      expect(provider.querySelector(".chat-question-summary")?.textContent).toContain(
        action === "submit" ? "New contributors" : "Dismissed",
      );
    });
    if (mode === "nondelegating") {
      expect(
        provider.querySelector<HTMLTextAreaElement>('textarea[aria-label="Custom draft"]')?.value,
      ).toBe("Keep the plugin draft.");
    }
  },
);

it("keeps one actionable local queue row with a nondelegating plugin composer", async () => {
  const { provider, render } = createPluginChat({
    id: "custom-queue",
    label: "Custom queue",
    surface: "composer",
    mount(container) {
      container.textContent = "Custom draft";
      return undefined;
    },
  });
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
  await waitForSolid(() => expect(provider.querySelectorAll(".chat-queue__item")).toHaveLength(1));
  const row = provider.querySelector<HTMLElement>(".chat-queue__item");
  expect(row?.getAttribute("data-chat-queue-item")).toBe("local-row");
  row?.querySelector<HTMLButtonElement>(".chat-queue__remove")?.click();
  expect(onQueueRemove).toHaveBeenCalledExactlyOnceWith("local-row");
});

it.each(["native", "delegated"] as const)(
  "keeps mobile conversation presentation live through the %s composer",
  async (mode) => {
    const { provider, render } = createPluginChat(
      mode === "delegated"
        ? {
            id: "mobile-presentation",
            label: "Mobile presentation",
            surface: "composer",
            mount: (container, view) => ({ dispose: view.mountDefault(container) }),
          }
        : undefined,
    );
    const onRefresh = vi.fn();
    const initial = createChatProps({
      paneId: `mobile-presentation-${mode}`,
      mobileComposer: true,
      loading: true,
      draft: "Retain this draft",
      runError: { summary: "Request interrupted.\nPlease check the conversation." },
      onRefresh,
    });
    render(initial);
    await waitForSolid(() => {
      expect(provider.querySelector(".chat-conversation-loading")).not.toBeNull();
      expect(provider.querySelector(".chat-error--mobile")?.textContent).toContain(
        "Couldn’t finish this reply",
      );
    });
    const textarea = provider.querySelector<HTMLTextAreaElement>("textarea")!;
    textarea.setSelectionRange(2, 5);
    provider.querySelector<HTMLButtonElement>(".chat-error__refresh")!.click();
    expect(onRefresh).toHaveBeenCalledOnce();

    render({ ...initial, mobileComposer: false });
    await waitForSolid(() => {
      expect(provider.querySelector(".chat-conversation-loading")).toBeNull();
      expect(provider.querySelector(".chat-error--mobile")).toBeNull();
      expect(provider.querySelector(".chat-error")?.textContent).toContain(
        "Couldn't finish this reply. Check the conversation before trying again.",
      );
    });
    expect(provider.querySelector("textarea")).toBe(textarea);
    expect(textarea.value).toBe("Retain this draft");
    expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([2, 5]);
  },
);
