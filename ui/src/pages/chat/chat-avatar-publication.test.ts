import { expectDefined } from "@openclaw/normalization-core";
import { nothing, render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentIdentityCapability } from "../../lib/agents/identity.ts";
import { setAvatarGatewayOrigin } from "../../lib/identity-avatar-context.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { invalidateChatAvatarCache, refreshSenderAgentAvatars } from "./chat-avatar.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import { createTestTranscript } from "./chat-view.test-helpers.ts";
import { renderChatThread } from "./components/chat-thread.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
  threadProps,
} from "./components/chat-transcript.test-support.ts";

describe("forwarded avatar publication", () => {
  beforeEach(installTranscriptDomMocks);
  afterEach(() => {
    setAvatarGatewayOrigin(null);
    resetTranscriptTestDom();
  });

  it.each(["append", "reorder", "identity invalidation"])(
    "keeps settled rows idle after %s and publishes revised avatars",
    async (change) => {
      const now = vi.spyOn(Date, "now").mockReturnValue(60_000);
      setAvatarGatewayOrigin("https://gateway.example.test", ["test-token"]);
      vi.spyOn(globalThis, "fetch").mockImplementation(
        async () =>
          new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } }),
      );
      let imageSequence = 0;
      let avatarRevision = 1;
      vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:avatar-${imageSequence++}`);
      const messages = ["research", "planner"].map((agentId, index) => ({
        role: "assistant",
        content: `${agentId} report`,
        timestamp: index + 1,
        senderSession: { agentId, sessionKey: `agent:${agentId}:source` },
        __openclaw: { id: `report-${agentId}` },
      }));
      const host = {
        ...makeChatHost({
          sessionKey: "agent:main:main",
          chatMessages: messages,
          requestHandlers: {
            "agent.identity.get": ({ agentId }: { agentId: string }) => ({
              agentId,
              avatar: `/avatar/${agentId}?v=${avatarRevision}`,
            }),
          },
        }),
        agentsList: { agents: [{ id: "main" }, { id: "research" }, { id: "planner" }] },
        senderAgentAvatars: undefined as ReadonlyMap<string, string | null> | undefined,
        requestUpdate: vi.fn(),
      };
      const identities = createAgentIdentityCapability({
        snapshot: { client: host.client, phase: "connected" },
        subscribe: () => () => undefined,
      });
      const props = {
        ...threadProps(`avatar-${change}`, host.sessionKey, host.chatMessages),
        currentAgentId: "main",
        agents: host.agentsList.agents,
        senderAgentAvatars: host.senderAgentAvatars,
      };
      const transcript = createTestTranscript();
      const container = document.body.appendChild(document.createElement("div"));
      const rerender = () => {
        props.messages = host.chatMessages;
        props.senderAgentAvatars = host.senderAgentAvatars;
        render(renderChatThread(props, transcript), container);
        flush();
        transcript.hostConnected();
        transcript.hostUpdated();
        flush();
      };
      try {
        await refreshSenderAgentAvatars(host);
        rerender();
        const researchRow = expectDefined(
          container.querySelector('[data-entry-id="report-research"]'),
          "forwarded report",
        );
        const image = expectDefined(
          researchRow.closest(".chat-group")?.querySelector("img"),
          "forwarded avatar",
        );
        await waitForSolid(() => expect(image.getAttribute("src")).toBe("blob:avatar-0"));

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
        host.requestUpdate.mockClear();
        await refreshSenderAgentAvatars(host);
        rerender();

        expect(host.requestUpdate).not.toHaveBeenCalled();
        expect(container.querySelector('[data-entry-id="report-research"]')).toBe(researchRow);
        expect(researchRow.closest(".chat-group")?.querySelector("img")).toBe(image);
        expect(image.getAttribute("src")).toBe("blob:avatar-0");
        expect(host.request).toHaveBeenCalledTimes(change === "identity invalidation" ? 4 : 2);

        avatarRevision += 1;
        now.mockReturnValue(180_002);
        identities.invalidate(["research", "planner"]);
        host.chatMessages = [...host.chatMessages];
        rerender();
        await refreshSenderAgentAvatars(host);
        rerender();
        await waitForSolid(() =>
          expect(image.getAttribute("src")).toBe(host.senderAgentAvatars?.get("research")),
        );
        expect(researchRow.closest(".chat-group")?.querySelector("img")).toBe(image);
        expect(image.getAttribute("src")).not.toBe("blob:avatar-0");
        expect(host.requestUpdate).toHaveBeenCalledOnce();
      } finally {
        render(nothing, container);
        transcript.hostDisconnected();
        invalidateChatAvatarCache(host);
      }
    },
  );
});
