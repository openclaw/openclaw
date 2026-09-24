/* @vitest-environment jsdom */

import { LitElement } from "lit";
import { afterEach, expect, it, vi } from "vitest";
import type {
  ControlUiHost,
  ControlUiReplacement,
  ControlUiSurface,
} from "../../../../src/plugin-sdk/control-ui.js";
import type { ApplicationContext } from "../../app/context.ts";
import { createApplicationContextProvider } from "../../test-helpers/application-context.ts";
import { resetComposerFixture } from "./chat-composer.test-support.ts";
import { resetChatViewState } from "./chat-view-state.ts";
import { createChatProps } from "./chat-view.test-helpers.ts";
import { renderChat } from "./chat-view.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";
import "../../plugins/control-ui-view.runtime.ts";

class PluginQuestionChatHost extends LitElement {
  props = createChatProps();

  override createRenderRoot() {
    return this;
  }

  override render() {
    return renderChat(this.props);
  }
}
customElements.define("plugin-question-chat-test-host", PluginQuestionChatHost);

afterEach(async () => {
  resetChatViewState();
  resetTranscriptTestDom();
  await resetComposerFixture();
});

it.each([
  { mode: "nondelegating", action: "submit" },
  { mode: "delegated", action: "skip" },
  { mode: "failing", action: "submit" },
] as const)(
  "keeps one usable async question with a $mode plugin composer",
  async ({ mode, action }) => {
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
    const replacement: ControlUiReplacement<"composer"> = {
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
    };
    const reportError = vi.fn();
    const registration = {
      key: "questions/custom-draft",
      pluginId: "questions",
      signal: lifetime.signal,
      host: pluginHost,
      value: replacement,
    };
    const context = {
      agentSelection: { state: { selectedId: "main" } },
      plugins: {
        registrations: () => [],
        selectedReplacement: (surface: ControlUiSurface) =>
          surface === "composer" ? registration : undefined,
        subscribe: () => () => undefined,
        reportError,
      },
    } as unknown as ApplicationContext;
    const provider = createApplicationContextProvider(context);
    const host = document.createElement("plugin-question-chat-test-host") as PluginQuestionChatHost;
    const submit = vi.fn(async () => true);
    host.props = createChatProps({
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
      onRequestUpdate: () => host.requestUpdate(),
    });
    provider.append(host);
    document.body.append(provider);
    await vi.waitFor(() => {
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
    await host.updateComplete;
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

it.each(["nondelegating", "delegated", "failing"] as const)(
  "keeps one actionable local queue row with a %s plugin composer",
  async (mode) => {
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
    const replacement: ControlUiReplacement<"composer"> = {
      id: "custom-queue",
      label: "Custom queue",
      surface: "composer",
      mount(container, view) {
        if (mode === "failing") {
          throw new Error("Synthetic composer mount failure");
        }
        if (mode === "delegated") {
          return { dispose: view.mountDefault(container) };
        }
        container.textContent = "Custom draft";
        return undefined;
      },
    };
    const registration = {
      key: "queue/custom-queue",
      pluginId: "queue",
      signal: lifetime.signal,
      host: pluginHost,
      value: replacement,
    };
    const context = {
      agentSelection: { state: { selectedId: "main" } },
      plugins: {
        registrations: () => [],
        selectedReplacement: (surface: ControlUiSurface) =>
          surface === "composer" ? registration : undefined,
        subscribe: () => () => undefined,
        reportError: vi.fn(),
      },
    } as unknown as ApplicationContext;
    const provider = createApplicationContextProvider(context);
    const onQueueRemove = vi.fn();
    const host = document.createElement("plugin-question-chat-test-host") as PluginQuestionChatHost;
    host.props = createChatProps({
      paneId: `plugin-queue-${mode}`,
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
      onRequestUpdate: () => host.requestUpdate(),
    });
    provider.append(host);
    document.body.append(provider);

    await vi.waitFor(() => {
      expect(provider.querySelectorAll(".chat-queue__item")).toHaveLength(1);
    });
    const row = provider.querySelector<HTMLElement>(".chat-queue__item");
    expect(row?.getAttribute("data-chat-queue-item")).toBe("local-row");
    row?.querySelector<HTMLButtonElement>(".chat-queue__remove")?.click();
    expect(onQueueRemove).toHaveBeenCalledExactlyOnceWith("local-row");
  },
);
