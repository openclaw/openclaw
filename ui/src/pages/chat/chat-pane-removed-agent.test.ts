/* @vitest-environment jsdom */

import { html, nothing } from "lit";
import { describe, expect, it } from "vitest";
import type { ApplicationContext } from "../../app/context.ts";
import { ChatPane } from "./chat-pane-render.ts";
import {
  createInitializationContext,
  createSessionCapabilityFixture,
} from "./chat-pane.test-support.ts";
import { createPageState } from "./chat-state-page.ts";
import type { ChatProps } from "./chat-view.ts";

describe("chat pane removed agent", () => {
  it("keeps the saved conversation read-only", () => {
    class RemovedAgentChatPane extends ChatPane {
      chatProps: ChatProps | undefined;

      initialize(context: ApplicationContext) {
        this.context = context;
        this.state = createPageState(
          context,
          { afterCommit: () => () => {}, invalidate: () => {} },
          this,
        );
        return this.state;
      }

      protected override renderChatPaneLayout(params: { chatProps: ChatProps }) {
        this.chatProps = params.chatProps;
        return html``;
      }
    }
    customElements.define("openclaw-chat-removed-agent", RemovedAgentChatPane);
    const pane = document.createElement("openclaw-chat-removed-agent") as RemovedAgentChatPane;
    const context = {
      ...createInitializationContext(),
      agents: {
        state: { agentsList: { defaultId: "main", agents: [{ id: "main" }] } },
        subscribe: () => () => undefined,
      },
      sessions: createSessionCapabilityFixture({
        state: { modelOverrides: {} },
        think: () => undefined,
      }),
    } as unknown as ApplicationContext;
    const state = pane.initialize(context);
    state.sessionKey = "agent:ghost:main";
    state.agentsList = { defaultId: "main", agents: [{ id: "main" }] } as never;
    pane.render();

    expect(pane.chatProps).toMatchObject({
      canSend: false,
      disabledReason: 'Agent "ghost" was removed. This conversation is read-only.',
      composerControls: nothing,
      capabilityMenu: undefined,
      onClearHistory: undefined,
      onForkMessage: undefined,
      onGoalAction: undefined,
      onGoalSubmit: undefined,
      onRewindMessage: undefined,
    });
  });
});
