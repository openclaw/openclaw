/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import { shouldHandleNewChatShortcut } from "./app-host.ts";

function keydownTarget(target: EventTarget, init: KeyboardEventInit): KeyboardEvent {
  let event: KeyboardEvent | null = null;
  target.addEventListener(
    "keydown",
    (next) => {
      event = next as KeyboardEvent;
    },
    { once: true },
  );
  target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
  if (!event) {
    throw new Error("expected keydown event");
  }
  return event;
}

function createShell() {
  const Shell = customElements.get("openclaw-app-shell");
  if (!Shell) {
    throw new Error("openclaw-app-shell was not registered");
  }
  return new Shell() as HTMLElement & {
    activeSessionKey: string;
    context: unknown;
    createSessionFromShortcut: () => Promise<void>;
  };
}

describe("OpenClaw app shell shortcuts", () => {
  it("handles Cmd/Ctrl+N outside editable targets only", () => {
    expect(
      shouldHandleNewChatShortcut(keydownTarget(document.body, { key: "n", metaKey: true })),
    ).toBe(true);
    expect(
      shouldHandleNewChatShortcut(keydownTarget(document.body, { key: "N", ctrlKey: true })),
    ).toBe(true);
    expect(
      shouldHandleNewChatShortcut(
        keydownTarget(document.body, { key: "n", ctrlKey: true, shiftKey: true }),
      ),
    ).toBe(false);

    const input = document.createElement("input");
    document.body.append(input);
    expect(shouldHandleNewChatShortcut(keydownTarget(input, { key: "n", metaKey: true }))).toBe(
      false,
    );

    const editor = document.createElement("div");
    editor.setAttribute("contenteditable", "");
    document.body.append(editor);
    expect(shouldHandleNewChatShortcut(keydownTarget(editor, { key: "n", ctrlKey: true }))).toBe(
      false,
    );

    const dialog = document.createElement("dialog");
    const button = document.createElement("button");
    dialog.append(button);
    document.body.append(dialog);
    expect(shouldHandleNewChatShortcut(keydownTarget(button, { key: "n", metaKey: true }))).toBe(
      false,
    );
  });

  it("creates a focused chat session from the existing shell session flow", async () => {
    const create = vi.fn(async () => "agent:main:new");
    const setSessionKey = vi.fn();
    const navigate = vi.fn();
    const shell = createShell();
    shell.activeSessionKey = "agent:main:old";
    shell.context = {
      agentSelection: { state: { selectedId: "main" } },
      gateway: {
        snapshot: {
          assistantAgentId: "main",
          connected: true,
          hello: null,
          sessionKey: "agent:main:old",
        },
        setSessionKey,
      },
      navigate,
      sessions: {
        create,
        state: {
          agentId: "main",
          deletedSessions: [],
          error: null,
          loading: false,
          modelOverrides: {},
          result: {
            count: 1,
            defaults: {},
            hasMore: false,
            sessions: [{ key: "agent:main:old", hasActiveRun: false }],
          },
        },
      },
    };

    await shell.createSessionFromShortcut();

    expect(create).toHaveBeenCalledWith({
      agentId: "main",
      currentSessionKey: "agent:main:old",
    });
    expect(setSessionKey).toHaveBeenCalledWith("agent:main:new");
    expect(navigate).toHaveBeenCalledWith("chat", {
      search: "?session=agent%3Amain%3Anew&focusComposer=1",
    });
  });
});
