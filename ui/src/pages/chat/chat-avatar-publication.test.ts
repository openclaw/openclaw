import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createAgentIdentityCapability } from "../../lib/agents/identity.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { invalidateChatAvatarCache, refreshSenderAgentAvatars } from "./chat-avatar.ts";
import { projectChatFields } from "./chat-field-projection.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import { createTestTranscript } from "./chat-view.test-helpers.ts";
import { mountChatThread } from "./components/chat-thread.test-support.ts";
import {
  flushDeferredRowPrune,
  installTranscriptDomMocks,
  resetTranscriptTestDom,
  threadProps,
} from "./components/chat-transcript.test-support.ts";

beforeEach(installTranscriptDomMocks);
afterEach(resetTranscriptTestDom);

it.each(["append", "reorder", "identity invalidation"])(
  "keeps settled rows idle after %s and publishes revised avatars",
  async (change) => {
    const now = vi.spyOn(Date, "now").mockReturnValue(60_000);
    let avatarRevision = 1;
    const avatar = (agentId: string) =>
      `data:image/png;base64,${btoa(`${agentId}:${avatarRevision}`)}`;
    const originalAvatar = avatar("research");
    const messages = ["research", "planner"].map((agentId, index) => ({
      role: "assistant",
      content: `${agentId} report`,
      timestamp: index + 1,
      senderSession: { agentId, sessionKey: `agent:${agentId}:source` },
      __openclaw: { id: `report-${agentId}` },
    }));
    const host = projectChatFields(
      {
        ...makeChatHost({
          sessionKey: "agent:main:main",
          chatMessages: messages,
          requestHandlers: {
            "agent.identity.get": ({ agentId }: { agentId: string }) => ({
              agentId,
              avatar: avatar(agentId),
            }),
          },
        }),
        agentsList: { agents: [{ id: "main" }, { id: "research" }, { id: "planner" }] },
        senderAgentAvatars: undefined as ReadonlyMap<string, string | null> | undefined,
      },
      ["senderAgentAvatars"],
    );
    const identities = createAgentIdentityCapability({
      snapshot: { client: host.client, phase: "connected" },
      subscribe: () => () => undefined,
    });
    const props = {
      ...threadProps(`avatar-${change}`, host.sessionKey, host.chatMessages),
      currentAgentId: "main",
      agents: host.agentsList.agents,
      get senderAgentAvatars() {
        return host.senderAgentAvatars;
      },
    };
    const transcript = createTestTranscript();
    await refreshSenderAgentAvatars(host);
    const view = mountChatThread(props, transcript);
    const { container } = view;
    const rerender = () => {
      props.messages = host.chatMessages;
      view.update(props);
      transcript.start();
      transcript.update();
      flush();
    };
    try {
      rerender();
      await flushDeferredRowPrune();
      const research = () => container.querySelector('[data-entry-id="report-research"]');
      const researchRow = expectDefined(research(), "forwarded report");
      const face = () => researchRow.closest(".chat-group")?.querySelector("img");
      const image = expectDefined(face(), "forwarded avatar");
      await waitForSolid(() => expect(image.getAttribute("src")).toBe(originalAvatar));

      host.chatMessages =
        change === "append"
          ? [...messages, { role: "user", content: "Continue", timestamp: 3 }]
          : [...messages].toReversed();
      now.mockReturnValue(120_001);
      if (change === "identity invalidation") {
        identities.invalidate(["research", "planner"]);
      }
      // Commit the transcript first, just as the pane does before its avatar refresh.
      rerender();
      await refreshSenderAgentAvatars(host);
      flush();

      expect(research()).toBe(researchRow);
      expect(face()).toBe(image);
      expect(image.getAttribute("src")).toBe(originalAvatar);

      avatarRevision += 1;
      now.mockReturnValue(180_002);
      identities.invalidate(["research", "planner"]);
      host.chatMessages = [...host.chatMessages];
      rerender();
      await refreshSenderAgentAvatars(host);
      flush();
      await waitForSolid(() =>
        expect(image.getAttribute("src")).toBe(host.senderAgentAvatars?.get("research")),
      );
      expect(face()).toBe(image);
      expect(image.getAttribute("src")).not.toBe(originalAvatar);
    } finally {
      view.unmount();
      transcript.dispose();
      invalidateChatAvatarCache(host);
    }
  },
);
