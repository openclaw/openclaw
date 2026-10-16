/* @vitest-environment jsdom */

import { createComponent } from "solid-js";
import { expect, it, vi } from "vitest";
import type {
  ControlUiHost,
  ControlUiSurfaceProps,
  ControlUiViewContext,
} from "../../../../../src/plugin-sdk/control-ui.js";
import type { ApplicationContext } from "../../../app/context.ts";
import type { ToolCard } from "../../../lib/chat/chat-types.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../../../test-helpers/solid-application-context.tsx";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { ChatToolCard } from "./chat-tool-cards.solid.tsx";

it("passes the raw Tool Search invocation to tool-result plugin replacements", async () => {
  const lifetime = new AbortController();
  // SAFETY: this view fixture never invokes the host service objects.
  const host = {
    signal: lifetime.signal,
    sessions: {},
    agents: {},
    navigation: {},
    ui: {},
    components: {},
  } as unknown as ControlUiHost;
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
    name: "tool_call",
    args: input,
    outputText: "Found the release notes.",
    completed: true,
  };
  for (const expanded of [false, true]) {
    received.length = 0;
    const view = mountSolid(
      () =>
        createComponent(ChatToolCard, {
          card,
          options: { messageKey: "raw-tool", expanded, onToggleExpanded: vi.fn() },
        }),
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
    expect(reportError).not.toHaveBeenCalled();
    view.unmount();
  }
});
