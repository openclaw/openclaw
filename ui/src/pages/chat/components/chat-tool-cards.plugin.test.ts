/* @vitest-environment jsdom */

import { createComponent, createSignal } from "solid-js";
import { expect, it, vi } from "vitest";
import type {
  ControlUiSurfaceProps,
  ControlUiViewContext,
} from "../../../../../src/plugin-sdk/control-ui.js";
import type { ApplicationContext } from "../../../app/context.ts";
import type { ToolCard } from "../../../lib/chat/chat-types.ts";
import { createInertViewHost } from "../../../plugins/control-ui-view.test-support.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../../../test-helpers/solid-application-context.tsx";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { chatRunPresentation } from "../chat-run-presentation.ts";
import { buildToolStreamIdentity } from "../tool-stream-identity.ts";
import { ChatToolCard } from "./chat-tool-cards.solid.tsx";

it("passes raw Tool Search identity and live then terminal output to plugin replacements", async () => {
  const lifetime = new AbortController();
  // SAFETY: this view fixture never invokes the host service objects.
  const host = createInertViewHost(lifetime.signal);
  const received: ControlUiViewContext<ControlUiSurfaceProps["tool-result"]>[] = [];
  const reportError = vi.fn();
  const registration = {
    key: "fixture/raw-tool",
    pluginId: "fixture",
    signal: lifetime.signal,
    host,
    value: {
      id: "raw-tool",
      label: "Raw tool",
      surface: "tool-result",
      mount(
        container: HTMLElement,
        view: ControlUiViewContext<ControlUiSurfaceProps["tool-result"]>,
      ) {
        received.push(view);
        container.textContent = "Raw tool replacement";
        return {
          update(next: ControlUiViewContext<ControlUiSurfaceProps["tool-result"]>) {
            received.push(next);
          },
        };
      },
    },
  };
  // SAFETY: ChatToolCard consumes only the plugin capability in this fixture.
  const context = {
    plugins: {
      selectedReplacement: () => registration,
      subscribe: () => () => undefined,
      reportError,
    },
  } as unknown as ApplicationContext;
  const provider = createSolidApplicationContextProvider(context);
  const input = { id: "web_search", args: { query: "OpenClaw release notes" } };
  const card: ToolCard = {
    id: "search-release",
    callId: "search-release",
    runId: "plugin-run",
    name: "tool_call",
    args: input,
    outputText: "Found the release notes.",
    live: true,
    completed: false,
  };
  for (const expanded of [false, true]) {
    received.length = 0;
    const message = (text: string) => ({
      runId: card.runId,
      toolCallId: card.callId,
      __openclawToolStreamLive: true,
      content: [
        { type: "toolcall", name: card.name, arguments: card.args },
        { type: "toolresult", text },
      ],
      __openclawToolStreamLiveOutput: { text: "Rolling tail", omittedChars: 100 },
    });
    const source = chatRunPresentation({ chatToolMessages: [message(card.outputText!)] });
    let finish!: (card: ToolCard) => void;
    const view = mountSolid(
      () => {
        const [current, setCurrent] = createSignal(card);
        finish = setCurrent;
        return createComponent(ChatToolCard, {
          get card() {
            return current();
          },
          options: {
            messageKey: "raw-tool",
            expanded,
            onToggleExpanded: vi.fn(),
            toolMessageSource: source,
          },
        });
      },
      { wrapper: provider.wrapper },
    );
    await waitForSolid(() => expect(view.container.textContent).toBe("Raw tool replacement"));
    expect(received.map((value) => value.props)).toEqual([
      expect.objectContaining({
        toolName: "tool_call",
        toolCallId: "search-release",
        input,
        expanded,
        output: expect.objectContaining({ text: "Found the release notes." }),
      }),
    ]);
    source.publishToolMessages([message("Updated captured output.")], false, [
      buildToolStreamIdentity("plugin-run", "search-release"),
    ]);
    await waitForSolid(() =>
      expect(received.at(-1)?.props.output).toMatchObject({ text: "Updated captured output." }),
    );
    expect(received.at(-1)?.props).toMatchObject({
      toolName: "tool_call",
      toolCallId: "search-release",
      input,
      output: { text: "Updated captured output.", completed: false },
    });
    finish({ ...card, completed: true, outputText: "Final output." });
    await waitForSolid(() =>
      expect(received.at(-1)?.props.output).toMatchObject({
        text: "Final output.",
        completed: true,
      }),
    );
    source.publishToolMessages([message("Stale output.")], false, [
      buildToolStreamIdentity("plugin-run", "search-release"),
    ]);
    flush();
    expect(received.at(-1)?.props.output).toMatchObject({ text: "Final output.", completed: true });
    expect(reportError).not.toHaveBeenCalled();
    view.unmount();
  }
});
