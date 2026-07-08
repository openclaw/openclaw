/* @vitest-environment jsdom */

// U-V1: a pending ask_user_question renders as an inline card in the composer
// status-stack (Codex swap-in), not a page-locking modal.

import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import type { QuestionCardEntry } from "../../app/question-card.ts";
import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { renderChatComposer, resetChatComposerState } from "./components/chat-composer.ts";

type ComposerProps = Parameters<typeof renderChatComposer>[0];

const SESSION_KEY = "main";

function sessions(): SessionsListResult {
  const row: GatewaySessionRow = { key: SESSION_KEY, kind: "direct", updatedAt: 0 };
  return {
    ts: 0,
    path: "",
    count: 1,
    defaults: { modelProvider: null, model: null, contextTokens: 200_000 },
    sessions: [row],
  };
}

const ENTRY: QuestionCardEntry = {
  id: "card-1",
  sessionKey: SESSION_KEY,
  turnSourceChannel: null,
  createdAtMs: 0,
  questions: [
    {
      id: "q1",
      header: "Ship it?",
      question: "Ready to deploy?",
      isOther: true,
      isSecret: false,
      options: [{ label: "Yes" }, { label: "No" }],
    },
  ],
};

function createProps(overrides: Partial<ComposerProps> = {}): ComposerProps {
  return {
    paneId: "pane-q",
    sessionKey: SESSION_KEY,
    currentAgentId: "main",
    connected: true,
    canSend: true,
    disabledReason: null,
    sending: false,
    messages: [],
    stream: null,
    queue: [] as ChatQueueItem[],
    draft: "",
    sessions: sessions(),
    assistantName: "OpenClaw",
    onDraftChange: () => undefined,
    onSend: () => undefined,
    onQueueRemove: () => undefined,
    onNewSession: () => undefined,
    ...overrides,
  };
}

describe("composer inline question (U-V1)", () => {
  let container: HTMLElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    resetChatComposerState();
  });

  afterEach(() => {
    resetChatComposerState();
    container.remove();
    vi.restoreAllMocks();
  });

  it("mounts the inline question card in the status-stack when a question is pending", async () => {
    const onSubmit = vi.fn();
    const onDismiss = vi.fn();
    render(
      renderChatComposer(
        createProps({
          questionInline: { entry: ENTRY, busy: false, error: null, onSubmit, onDismiss },
        }),
      ),
      container,
    );

    const stack = container.querySelector(".agent-chat__composer-status-stack");
    expect(stack).not.toBeNull();
    const inline = stack!.querySelector("openclaw-inline-question");
    expect(inline).not.toBeNull();
    await (inline as HTMLElement & { updateComplete: Promise<unknown> }).updateComplete;
    expect(inline!.querySelector(".inline-question")).not.toBeNull();
  });

  it("renders no inline question card when none is pending", () => {
    render(renderChatComposer(createProps({ questionInline: null })), container);
    expect(container.querySelector("openclaw-inline-question")).toBeNull();
  });
});
