import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentIdentityCapability } from "../../lib/agents/identity.ts";
import { setAvatarGatewayOrigin } from "../../lib/identity-avatar-context.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { invalidateChatAvatarCache, refreshSenderAgentAvatars } from "./chat-avatar.ts";
import { projectChatFields } from "./chat-field-projection.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import { createTestTranscript } from "./chat-view.test-helpers.ts";
import { mountChatThread } from "./components/chat-thread.test-support.ts";
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
      const host = projectChatFields(
        {
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
        await refreshSenderAgentAvatars(host);
        flush();

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
        flush();
        await waitForSolid(() =>
          expect(image.getAttribute("src")).toBe(host.senderAgentAvatars?.get("research")),
        );
        expect(researchRow.closest(".chat-group")?.querySelector("img")).toBe(image);
        expect(image.getAttribute("src")).not.toBe("blob:avatar-0");
      } finally {
        view.unmount();
        transcript.dispose();
        invalidateChatAvatarCache(host);
      }
    },
  );
});
