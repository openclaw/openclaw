/* @vitest-environment jsdom */

import type { BoardGetParams } from "@openclaw/gateway-protocol";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import type {
  ControlUiSurface,
  ControlUiViewContext,
} from "../../../../src/plugin-sdk/control-ui.js";
import { prepareChatMessageRender } from "../../lib/chat/message-display.ts";
import { createControlUiPluginHost } from "../../plugins/control-ui-host.ts";
import {
  ControlUiPluginRuntime,
  type ControlUiPluginOwner,
} from "../../plugins/control-ui-runtime.ts";
import { disposeSidebarContextLifecycles } from "../../test-helpers/app-sidebar-context-lifecycle.ts";
import { createContext, createGateway, createSessions } from "../../test-helpers/app-sidebar.ts";
import { createApplicationContextProvider } from "../../test-helpers/application-context.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../../test-helpers/solid-application-context.tsx";
import { resetComposerFixture } from "./chat-composer.test-support.ts";
import { createChatProps } from "./chat-view.test-helpers.ts";
import { ChatView } from "./chat-view.tsx";
import { createComposerQuestions } from "./components/chat-composer-questions.ts";
import { GroupedMessage } from "./components/chat-message-bubble-view.tsx";
import "../../plugins/control-ui-view.solid.tsx";
import "../../plugins/control-ui-contributions.solid.tsx";

afterEach(() => resetComposerFixture());

it("passes the pane's raw global owner to transcript and tool replacements", async () => {
  const lifetime = new AbortController();
  const client = createTestGatewayClient(async () => ({}));
  const context = createContext(createGateway(client), createSessions("main", []));
  const runtime = new ControlUiPluginRuntime(() => context);
  runtime.start();
  const owner: Omit<ControlUiPluginOwner, "host"> = {
    descriptor: {
      pluginId: "identity",
      name: "Identity",
      revision: "1",
      entryUrl: "/identity.js",
      styles: [],
    },
    client,
    abort: lifetime,
    disposers: new Set(),
    selections: new Map(),
    contributions: {
      pages: new Map(),
      navigation: new Map(),
      panels: new Map(),
      actions: new Map(),
      accessories: new Map(),
      widgets: new Map(),
      replacements: new Map(),
      textReferences: new Map(),
      inlineViews: new Map(),
    },
  };
  const host = createControlUiPluginHost(() => context, runtime, owner);
  const replacements = new Map(
    (["transcript", "tool-result"] as const).map((surface) => [
      surface,
      {
        key: `identity/${surface}`,
        pluginId: "identity",
        signal: lifetime.signal,
        host,
        value: {
          id: surface,
          label: surface,
          surface,
          mount(container: HTMLElement, view: ControlUiViewContext<BoardGetParams>) {
            container.dataset.nativeOwner = surface;
            container.textContent = `${view.props.agentId}/${view.props.sessionKey}`;
          },
        },
      },
    ]),
  );
  const reportError = vi.fn();
  Object.assign(context, {
    agentSelection: { ...context.agentSelection, state: { selectedId: "main", scopeId: "main" } },
    plugins: {
      ...context.plugins,
      registrations: () => [],
      selectedReplacement: (surface: ControlUiSurface) =>
        surface === "transcript" || surface === "tool-result"
          ? replacements.get(surface)
          : undefined,
      subscribe: () => () => undefined,
      reportError,
    },
  });
  const provider = createSolidApplicationContextProvider(context);
  const props = createChatProps({
    paneId: "native-owner",
    sessionKey: "global",
    currentAgentId: "writer",
    showToolCalls: false,
    assistantName: "OpenClaw",
  });
  // ChatView still contains registered bridges that request their application through the DOM.
  const container = document.body.appendChild(createApplicationContextProvider(context));
  const view = mountSolid(
    () => {
      const questions = createComposerQuestions(props.paneId, () => props);
      return (
        <>
          <ChatView props={props} questions={questions} />
          <GroupedMessage
            preparation={prepareChatMessageRender({
              role: "toolResult",
              toolCallId: "identity-result",
              toolName: "inspect",
              content: [{ type: "text", text: "Inspection complete" }],
            })}
            messageKey="identity-message"
            options={{
              isStreaming: false,
              showReasoning: false,
              sessionKey: props.sessionKey,
              agentId: props.currentAgentId,
            }}
          />
        </>
      );
    },
    { container, wrapper: provider.wrapper },
  );
  onTestFinished(() => {
    view.unmount();
    lifetime.abort();
    for (const dispose of owner.disposers) {
      dispose();
    }
    runtime.dispose();
    disposeSidebarContextLifecycles();
    container.remove();
  });

  const owners = () => [...view.container.querySelectorAll<HTMLElement>("[data-native-owner]")];
  await vi.waitFor(() => {
    expect(reportError).not.toHaveBeenCalled();
    expect(owners()).toHaveLength(2);
  });
  expect(
    Object.fromEntries(owners().map((el) => [el.dataset.nativeOwner, el.textContent])),
  ).toEqual({ transcript: "writer/global", "tool-result": "writer/global" });
  expect(reportError).not.toHaveBeenCalled();
});
