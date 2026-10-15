/* @vitest-environment jsdom */

import type { BoardGetParams } from "@openclaw/gateway-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ControlUiHost,
  ControlUiSurface,
  ControlUiViewContext,
} from "../../../../src/plugin-sdk/control-ui.js";
import type { ApplicationContext } from "../../app/context.ts";
import { createApplicationContextProvider } from "../../test-helpers/application-context.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import {
  createSolidApplicationContextProvider,
  createApplicationGateway,
} from "../../test-helpers/solid-application-context.tsx";
import { createComposerProps, resetComposerFixture } from "./chat-composer.test-support.ts";
import { createTestTranscript } from "./chat-view.test-helpers.ts";
import { ChatView, type ChatProps } from "./chat-view.tsx";
import { GroupedMessage } from "./components/chat-message-bubble-view.tsx";
import { prepareChatMessageRender } from "./components/chat-message-markdown.ts";
import "../../plugins/control-ui-view.solid.tsx";
import "../../plugins/control-ui-contributions.solid.tsx";
import { threadProps } from "./components/chat-transcript.test-support.ts";

afterEach(() => resetComposerFixture());

describe("native chat view session identity", () => {
  it("passes the pane's raw global owner to transcript and tool replacements", async () => {
    const lifetime = new AbortController();
    const host = {
      signal: lifetime.signal,
      sessions: {},
      agents: {},
      navigation: {},
      ui: {},
      components: {},
    } as unknown as ControlUiHost;
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
    const context = {
      gateway: createApplicationGateway().gateway,
      agentSelection: { state: { selectedId: "main" }, subscribe: () => () => undefined },
      plugins: {
        registrations: () => [],
        selectedReplacement: (surface: ControlUiSurface) =>
          surface === "transcript" || surface === "tool-result"
            ? replacements.get(surface)
            : undefined,
        subscribe: () => () => undefined,
        reportError,
      },
    } as unknown as ApplicationContext;
    const provider = createSolidApplicationContextProvider(context);
    const props: ChatProps = {
      ...threadProps("native-owner", "global", []),
      ...createComposerProps({
        paneId: "native-owner",
        sessionKey: "global",
        currentAgentId: "writer",
      }),
      transcript: createTestTranscript(),
      error: null,
      approvalCanGrant: false,
      onRefresh: vi.fn(),
      agentsList: null,
    };
    // ChatView still contains registered bridges that request their application through the DOM.
    const container = document.body.appendChild(createApplicationContextProvider(context));
    const view = mountSolid(
      () => (
        <>
          <ChatView props={props} />
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
      ),
      { container, wrapper: provider.wrapper },
    );

    await vi.waitFor(() => {
      expect(reportError).not.toHaveBeenCalled();
      expect(view.container.querySelectorAll("[data-native-owner]")).toHaveLength(2);
    });
    expect(
      Object.fromEntries(
        [...view.container.querySelectorAll<HTMLElement>("[data-native-owner]")].map((element) => [
          element.dataset.nativeOwner,
          element.textContent,
        ]),
      ),
    ).toEqual({ transcript: "writer/global", "tool-result": "writer/global" });
    expect(reportError).not.toHaveBeenCalled();
  });
});
