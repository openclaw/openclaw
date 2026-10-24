/* @vitest-environment jsdom */
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { ExecApprovalRequest } from "../../app/exec-approval.ts";
import type { SolidBridgeElement } from "../../lib/solid-bridge.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { resetChatViewState } from "./chat-view-state.test-support.ts";
import {
  createTestTranscript,
  renderChatInto,
  renderChatView,
  requireElement,
} from "./chat-view.test-helpers.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
  resizeObservers,
} from "./components/chat-transcript.test-support.ts";

beforeEach(() => installTranscriptDomMocks());
afterEach(() => {
  resetChatViewState();
  resetTranscriptTestDom();
});

function expectFooterContext(container: Element, surface: Element) {
  const shell = requireElement(container, ".agent-chat__composer-shell", "composer shell");
  const footer = requireElement(container, ".chat-footer", "footer");
  const scrollAnchor = footer.previousElementSibling;
  const viewport = requireElement(container, ".chat-thread-viewport", "transcript viewport");
  expect(scrollAnchor?.classList.contains("chat-scroll-to-bottom-wrap")).toBe(true);
  expect(viewport.compareDocumentPosition(scrollAnchor!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  expect(viewport.querySelector(':scope > .chat-thread[role="log"]')).not.toBeNull();
  expect(surface.closest(".chat-footer")).toBe(footer);
  expect(shell.closest(".chat-footer")).toBe(footer);
  const input = requireElement(shell, ".agent-chat__input", "composer input");
  expect(surface.closest(".chat-footer__context")).not.toBeNull();
  expect(input.closest(".chat-footer__context")).toBeNull();
  expect(surface.compareDocumentPosition(input)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
}

it("leaves ordinary turn history and the draft intact without delegated-work rows", async () => {
  const sessionKey = "agent:main:parent";
  const childKey = "agent:main:subagent:worker";
  const groupId = "custom-review-batch";
  const sessions: GatewaySessionRow[] = [
    {
      key: sessionKey,
      kind: "direct",
      swarm: {
        groups: [
          {
            groupId,
            createdAt: 1,
            children: [{ sessionKey: childKey, status: "done" }],
            queued: 0,
            running: 0,
            done: 1,
            failed: 0,
          },
        ],
        otherActiveGroups: 0,
      },
    },
    {
      key: childKey,
      kind: "direct",
      swarmGroupId: groupId,
      label: "Check release notes",
      status: "done",
      runtimeMs: 42000,
    },
  ];
  const messages = [
    {
      role: "user",
      content: "Review this change",
      timestamp: 1,
      __openclaw: { id: "input-1", runId: "review-run" },
    },
    {
      role: "assistant",
      timestamp: 2,
      __openclaw: { id: "launch", runId: "review-run" },
      content: [
        {
          type: "toolCall",
          id: "spawn-1",
          name: "sessions_spawn",
          arguments: { label: "Check release notes", collect: true, groupId },
        },
      ],
    },
    {
      role: "toolResult",
      toolCallId: "spawn-1",
      toolName: "sessions_spawn",
      timestamp: 3,
      __openclaw: { id: "accepted", runId: "review-run" },
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "accepted",
            childSessionKey: childKey,
            runId: "child-run",
            groupId,
          }),
        },
      ],
    },
    {
      role: "assistant",
      content: "The release notes are ready.",
      timestamp: 4,
      __openclaw: { id: "answer-1", runId: "review-run" },
    },
    {
      role: "user",
      content: "Now do something unrelated",
      timestamp: 5,
      __openclaw: { id: "input-2", runId: "later-run" },
    },
  ];
  const transcript = createTestTranscript();
  const props = {
    transcript,
    sessionKey,
    messages,
    showToolCalls: true,
    subagentSessions: sessions.slice(1),
    draft: "Keep the draft while progress arrives",
  };
  const container = renderChatView(props);
  const viewport = transcript.scrollElement!;
  Object.defineProperty(viewport, "clientHeight", { configurable: true, value: 600 });
  for (const observer of resizeObservers) {
    observer.emitTarget(viewport, 800, 600);
  }
  const textarea = container.querySelector<HTMLTextAreaElement>("textarea")!;
  textarea.focus();
  await vi.dynamicImportSettled();
  await waitForSolid(() => {
    expect(container.textContent).toContain("The release notes are ready.");
    expect(container.textContent).toContain("Now do something unrelated");
  });
  const thread = requireElement(container, ".chat-thread", "transcript");
  expect(thread.querySelector("[data-test-id=chat-delegation]")).toBeNull();
  expect(thread.querySelector(".chat-subagent-activity")).toBeNull();
  expect(container.querySelector(".chat-footer [data-test-id=chat-swarm]")).toBeNull();
  const answer = [...container.querySelectorAll(".chat-text")].find((node) =>
    node.textContent?.includes("The release notes are ready."),
  );
  const later = [...container.querySelectorAll(".chat-text")].find((node) =>
    node.textContent?.includes("Now do something unrelated"),
  );
  expect(answer).toBeDefined();
  expect(later).toBeDefined();
  expect(answer!.compareDocumentPosition(later!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  renderChatInto(container, { ...props, runId: "later-run", runActive: true });
  await waitForSolid(() => {
    expect(container.querySelector("[data-test-id=chat-delegation]")).toBeNull();
    expect(container.querySelector(".chat-subagent-activity")).toBeNull();
    expect(container.textContent).toContain("The release notes are ready.");
  });
  expect(container.querySelector("textarea")).toBe(textarea);
  expect(textarea.value).toBe(props.draft);
  expect(document.activeElement).toBe(textarea);
});

it("places inline approval above the composer and enforces its grant projection", async () => {
  const onApprovalDecision = vi.fn();
  const request = { command: "rm -rf build", commandSpans: [{ startIndex: 0, endIndex: 5 }] };
  const inlineApproval = {
    id: "approval-inline",
    kind: "exec",
    request,
    createdAtMs: 1,
    expiresAtMs: 61_000,
  } satisfies ExecApprovalRequest;
  const approvalProps = { inlineApproval, onApprovalDecision };

  vi.spyOn(Date, "now").mockReturnValue(1_000);

  const render = async (approvalCanGrant: boolean, approvalErrors?: Map<string, string>) => {
    const container = renderChatView({ ...approvalProps, approvalCanGrant, approvalErrors });
    document.body.append(container);
    onTestFinished(() => container.remove());
    await vi.dynamicImportSettled();
    const host = await waitForSolid(() =>
      expectDefined(
        container.querySelector<SolidBridgeElement<object>>("openclaw-exec-approval-card"),
        "inline approval host",
      ),
    );
    await host.updateComplete;
    return container;
  };
  const container = await render(
    false,
    new Map([["approval-inline", "Approval failed: gateway unavailable"]]),
  );
  const text = (part: string) =>
    requireElement(container, `.exec-approval-${part}`, part).textContent;
  const card = container.querySelector(".chat-inline-approval .exec-approval-card");
  const inlineSurface = requireElement(container, ".chat-inline-approval", "inline approval");
  expect(card?.getAttribute("data-approval-id")).toBe("approval-inline");
  expectFooterContext(container, inlineSurface);
  flush();
  expect(text("countdown")?.trim()).toBe("expires in 01:00");
  expect(text("command-span")).toBe("rm -r");
  expect(text("error")).toBe("Approval failed: gateway unavailable");
  expect(text("warning")?.trim()).toBe(
    "Review only. Sign in with approval access to record a decision.",
  );
  const buttons = [
    ...container.querySelectorAll<HTMLButtonElement>(".exec-approval-actions button"),
  ];
  expect(buttons.every((button) => button.disabled)).toBe(true);
  buttons[0]?.click();
  expect(onApprovalDecision).not.toHaveBeenCalled();

  const authorizedContainer = await render(true);
  authorizedContainer.querySelector<HTMLButtonElement>(".exec-approval-actions button")?.click();
  expect(onApprovalDecision).toHaveBeenCalledWith("approval-inline", "allow-once");
});
