/* @vitest-environment jsdom */
import { nothing, render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MessageGroup } from "../../../lib/chat/chat-types.ts";
import { setAvatarGatewayOrigin } from "../../../lib/identity-avatar-context.ts";
import { renderMessageGroup } from "./chat-message-group.ts";
import {
  createUserMessage,
  createMessageEntry,
  prepareMessageGroup,
} from "./chat-message.test-support.ts";
const containers: HTMLElement[] = [];
function renderTestMessageGroup(
  group: MessageGroup,
  opts: Partial<Parameters<typeof renderMessageGroup>[1]> = {},
) {
  return renderMessageGroup(group, {
    showReasoning: true,
    showToolCalls: true,
    assistantName: "OpenClaw",
    assistantAvatar: null,
    ...opts,
  });
}
afterEach(async () => {
  await vi.dynamicImportSettled();
  for (const container of containers.splice(0)) {
    render(nothing, container);
  }
  setAvatarGatewayOrigin(null);
  vi.restoreAllMocks();
});
describe("chat message authorship", () => {
  it("does not assign unattributed messages to the configured viewer", () => {
    const container = document.createElement("div");
    containers.push(container);
    const group = prepareMessageGroup(
      createMessageEntry("unknown-author", createUserMessage("hello", { timestamp: 1000 })),
    );
    render(renderTestMessageGroup(group, { userName: "Buns" }), container);
    expect(container.querySelector(".chat-group.user .chat-sender-name")?.textContent).toBe("User");
    expect(container.querySelector(".chat-avatar.user")?.tagName).toBe("DIV");
  });
  it.each(["viewer", null])(
    "keeps agent, human, and unknown authors distinct for viewer %s",
    (userId) => {
      const fixtures = [
        {
          id: "viewer",
          type: "profile",
          name: "Recorded viewer",
          expected: userId ? "Current viewer" : "Recorded viewer",
          peer: false,
        },
        {
          id: "peer",
          type: "profile",
          name: "Peer human",
          expected: "Peer human",
          peer: Boolean(userId),
        },
        { id: "viewer", type: "agent", name: "viewer", expected: "Task agent", peer: true },
        {
          id: "viewer",
          type: undefined,
          name: "Historical label",
          expected: "Historical label",
          peer: Boolean(userId),
        },
        { id: undefined, type: undefined, name: undefined, expected: "User", peer: false },
      ];
      for (const fixture of fixtures) {
        const message = createUserMessage("Inspect the workspace", {
          __openclaw: {
            senderId: fixture.id,
            senderName: fixture.name,
            ...(fixture.type ? { senderIdentity: { type: fixture.type, id: fixture.id } } : {}),
          },
        });
        const container = document.createElement("div");
        containers.push(container);
        render(
          renderTestMessageGroup(prepareMessageGroup(createMessageEntry("authorship", message)), {
            userId,
            userName: "Current viewer",
            userAvatar: "https://example.test/viewer.png",
            agents: [{ id: "viewer", identity: { name: "Task agent" } }],
            personActivity: { basePath: "", navigate: vi.fn() },
          }),
          container,
        );
        expect(container.querySelector(".chat-sender-name")?.textContent).toBe(fixture.expected);
        expect(Boolean(container.querySelector(".chat-group--peer"))).toBe(fixture.peer);
        expect(Boolean(container.querySelector("a.chat-sender-name"))).toBe(
          fixture.type === "profile" && fixture.peer,
        );
        if (fixture.type === "agent") {
          expect(container.querySelector(".chat-avatar.assistant")).not.toBeNull();
          expect(container.querySelector(".chat-avatar--sender-initials")).toBeNull();
        }
        expect(container.querySelector('img[src="https://example.test/viewer.png"]')).toBeNull();
      }
    },
  );

  it.each(["current", "other"])("uses the %s agent's configured task avatar", (source) => {
    const message = createUserMessage("Delegated task", {
      __openclaw: {
        senderId: source,
        senderName: source,
        senderIdentity: { type: "agent", id: source },
      },
    });
    const container = document.createElement("div");
    containers.push(container);
    render(
      renderTestMessageGroup(prepareMessageGroup(createMessageEntry("agent-avatar", message)), {
        agentId: "current",
        assistantAvatar: "blob:current-avatar",
        agents: [{ id: "other", identity: { name: "Other agent" } }],
        senderAgentAvatars: new Map([["other", "blob:other-avatar"]]),
      }),
      container,
    );
    expect(container.querySelector("img.chat-avatar.assistant")?.getAttribute("src")).toBe(
      "blob:" + source + "-avatar",
    );
    expect(container.querySelector(".chat-avatar--sender-initials")).toBeNull();
  });
});
