/* @vitest-environment jsdom */

import type { BoardGetParams } from "@openclaw/gateway-protocol";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import type {
  ControlUiSurface,
  ControlUiViewContext,
} from "../../../../src/plugin-sdk/control-ui.js";
import type { ApplicationContext } from "../../app/context.ts";
import { createInertViewHost } from "../../plugins/control-ui-view.test-support.ts";
import { createApplicationContextProvider } from "../../test-helpers/application-context.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import {
  createSolidApplicationContextProvider,
  createApplicationGateway,
} from "../../test-helpers/solid-application-context.tsx";
import { resetComposerFixture } from "./chat-composer.test-support.ts";
import { createChatProps } from "./chat-view.test-helpers.ts";
import { ChatView } from "./chat-view.tsx";
import { createComposerQuestions } from "./components/chat-composer-questions.ts";
import { GroupedMessage } from "./components/chat-message-bubble-view.tsx";
import { prepareChatMessageRender } from "./components/chat-message-markdown-view.tsx";
import "../../plugins/control-ui-view.solid.tsx";
import "../../plugins/control-ui-contributions.solid.tsx";

afterEach(() => resetComposerFixture());

it("passes the pane's raw global owner to transcript and tool replacements", async () => {
  const lifetime = new AbortController();
  const host = createInertViewHost(lifetime.signal);
  const replacements = (["transcript", "tool-result"] as const).map((surface) => ({
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
  }));
  const reportError = vi.fn();
  const context = {
    gateway: createApplicationGateway().gateway,
    agentSelection: { state: { selectedId: "main" }, subscribe: () => () => undefined },
    plugins: {
      registrations: () => [],
      selectedReplacement: (surface: ControlUiSurface) =>
        replacements.find((replacement) => replacement.value.surface === surface),
      subscribe: () => () => undefined,
      reportError,
    },
  } as unknown as ApplicationContext;
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
    { container, wrapper: createSolidApplicationContextProvider(context).wrapper },
  );
  onTestFinished(() => {
    view.unmount();
    lifetime.abort();
    container.remove();
  });

  const owners = () => [...view.container.querySelectorAll<HTMLElement>("[data-native-owner]")];
  await vi.waitFor(() => {
    expect(owners()).toHaveLength(2);
  });
  expect(
    Object.fromEntries(owners().map((el) => [el.dataset.nativeOwner, el.textContent])),
  ).toEqual({ transcript: "writer/global", "tool-result": "writer/global" });
  expect(reportError).not.toHaveBeenCalled();
});
