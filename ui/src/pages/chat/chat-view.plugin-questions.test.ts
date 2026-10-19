/* @vitest-environment jsdom */

import { createComponent, createSignal } from "solid-js";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import type {
  ControlUiHost,
  ControlUiReplacement,
  ControlUiSurface,
} from "../../../../src/plugin-sdk/control-ui.js";
import type { ApplicationContext } from "../../app/context.ts";
import {
  createApplicationContextProvider,
  createApplicationGateway,
} from "../../test-helpers/application-context.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../../test-helpers/solid-application-context.tsx";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { resetComposerFixture } from "./chat-composer.test-support.ts";
import { resetChatViewState } from "./chat-view-state.ts";
import { createChatProps } from "./chat-view.test-helpers.ts";
import { ChatView, type ChatProps } from "./chat-view.tsx";
import { questionPanelIn } from "./components/chat-question-card.test-support.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";
import "../../plugins/control-ui-view.solid.tsx";
import "../../plugins/control-ui-contributions.solid.tsx";

afterEach(async () => {
  resetChatViewState();
  resetTranscriptTestDom();
  await resetComposerFixture();
});

function createPluginChat(replacement: ControlUiReplacement<"composer">, initiallySelected = true) {
  installTranscriptDomMocks();
  const lifetime = new AbortController();
  const pluginHost = {
    signal: lifetime.signal,
    sessions: {},
    agents: {},
    navigation: {},
    ui: {},
    components: {},
  } as unknown as ControlUiHost;
  const reportError = vi.fn();
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
      reportError,
    },
  } as unknown as ApplicationContext;
  const provider = document.body.appendChild(createApplicationContextProvider(context));
  let current: ChatProps;
  let update: ((next: ChatProps) => void) | undefined;
  function render(props: ChatProps) {
    current = props;
    if (update) {
      update(props);
    } else {
      const [value, setValue] = createSignal(props, { equals: false });
      update = (next) => setValue(() => ({ ...next }));
      const view = mountSolid(
        () =>
          createComponent(ChatView, {
            get props() {
              return value();
            },
          }),
        { container: provider, wrapper: createSolidApplicationContextProvider(context).wrapper },
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
    const { provider, render, reportError, selectReplacement } = createPluginChat(
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
    render(
      createChatProps({
        paneId: "plugin-question",
        sessionKey: "agent:main:main",
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
      }),
    );
    selectReplacement();
    await waitForSolid(async () => {
      await questionPanelIn(provider);
      expect(provider.querySelectorAll("openclaw-chat-question-panel")).toHaveLength(1);
      expect(provider.querySelectorAll('textarea[aria-label="Custom draft"]')).toHaveLength(
        mode === "nondelegating" ? 1 : 0,
      );
      expect(provider.querySelectorAll(".agent-chat__composer-combobox textarea")).toHaveLength(
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
        action === "submit" ? ".chat-question-panel__advance" : ".chat-question-panel__skip",
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
  render(
    createChatProps({
      paneId: "plugin-queue-nondelegating",
      sessionKey: "agent:main:main",
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
    }),
  );
  flush();
  await waitForSolid(() => expect(provider.querySelectorAll(".chat-queue__item")).toHaveLength(1));
  const row = provider.querySelector<HTMLElement>(".chat-queue__item");
  expect(row?.getAttribute("data-chat-queue-item")).toBe("local-row");
  row?.querySelector<HTMLButtonElement>(".chat-queue__remove")?.click();
  expect(onQueueRemove).toHaveBeenCalledExactlyOnceWith("local-row");
});
