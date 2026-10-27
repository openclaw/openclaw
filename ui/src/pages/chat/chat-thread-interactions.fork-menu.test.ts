import { afterEach, describe, expect, it } from "vitest";
import type { ApplicationGatewaySnapshot } from "../app/gateway.ts";
import { readChatSessionActionAccess } from "./chat-session-action-access.ts";
import {
  dismissThreadPortals,
  handleTranscriptContextMenu,
} from "./components/chat-thread-interactions.ts";

const FORK_LABEL = "Fork from here";
const SESSION_METHODS = ["sessions.fork", "sessions.abort", "sessions.rewind", "sessions.compact"];

function guestSnapshot(
  scopes: string[],
): Pick<ApplicationGatewaySnapshot, "client" | "hello" | "phase"> {
  return {
    client: {} as ApplicationGatewaySnapshot["client"],
    phase: "connected",
    hello: {
      auth: { role: "operator", scopes },
      features: { methods: SESSION_METHODS },
    } as ApplicationGatewaySnapshot["hello"],
  };
}

function buildUserMessageThread() {
  document.body.innerHTML = "";
  const group = document.createElement("div");
  group.className = "chat-group user";
  const bubble = document.createElement("div");
  bubble.className = "chat-bubble";
  bubble.dataset.entryId = "entry-1";
  bubble.dataset.messageId = "message-1";
  (bubble as unknown as { messageActions: Record<string, unknown> }).messageActions = {
    copyMarkdown: "hello",
    replyTarget: "message-1",
  };
  group.appendChild(bubble);
  document.body.appendChild(group);
  return { bubble };
}

function openContextMenu(
  target: HTMLElement,
  props: { onForkMessage?: (entryId: string) => void },
) {
  const event = new MouseEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
    clientX: 16,
    clientY: 16,
  });
  Object.defineProperty(event, "composedPath", { value: () => [target] });
  handleTranscriptContextMenu(event, props);
}

function menuLabels(): string[] {
  return [...document.querySelectorAll("[role='menuitem']")]
    .map((item) => item.textContent?.trim() ?? "")
    .filter(Boolean);
}

/**
 * Mirrors the production wiring in chat-pane-session-controls.ts:
 *   onForkMessage: access.fork.allowed ? (entryId) => … : undefined
 * and the menu gate in chat-thread-interactions.ts:
 *   canFork = isUserMessage && typeof props.onForkMessage === "function"
 */
function paneForkCallback(
  snapshot: Pick<ApplicationGatewaySnapshot, "client" | "hello" | "phase">,
  sharingRole: "owner" | "member",
) {
  const access = readChatSessionActionAccess(snapshot, false, {
    session: { sharingRole },
  });
  return access.fork.allowed ? (entryId: string) => void entryId : undefined;
}

afterEach(() => {
  dismissThreadPortals();
  document.body.innerHTML = "";
});

describe("chat thread message menu fork action", () => {
  it("offers Fork from here to a guest who owns the session", () => {
    const guest = guestSnapshot(["operator.sessions.read", "operator.sessions.write"]);
    const { bubble } = buildUserMessageThread();
    openContextMenu(bubble, { onForkMessage: paneForkCallback(guest, "owner") });

    expect(menuLabels()).toContain(FORK_LABEL);
  });

  it("keeps the action away from a read-only guest and a foreign session", () => {
    const readOnly = guestSnapshot(["operator.sessions.read"]);
    const writer = guestSnapshot(["operator.sessions.read", "operator.sessions.write"]);
    const { bubble } = buildUserMessageThread();

    openContextMenu(bubble, { onForkMessage: paneForkCallback(readOnly, "owner") });
    expect(menuLabels()).not.toContain(FORK_LABEL);
    dismissThreadPortals();

    openContextMenu(bubble, { onForkMessage: paneForkCallback(writer, "member") });
    expect(menuLabels()).not.toContain(FORK_LABEL);
  });

  it("omits Fork from here when the pane withholds the fork callback", () => {
    const { bubble } = buildUserMessageThread();
    openContextMenu(bubble, {});

    // The menu still opens (copy is available); only the fork entry is absent.
    expect(menuLabels().length).toBeGreaterThan(0);
    expect(menuLabels()).not.toContain(FORK_LABEL);
  });
});
