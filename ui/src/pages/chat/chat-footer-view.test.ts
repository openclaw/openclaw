/* @vitest-environment jsdom */
import { expectDefined } from "@openclaw/normalization-core";
import type { LitElement } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecApprovalRequest } from "../../app/exec-approval.ts";
import { resetChatViewState } from "./chat-view-state.ts";
import { renderChatView } from "./chat-view.test-helpers.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";

beforeEach(() => installTranscriptDomMocks());
afterEach(() => {
  resetChatViewState();
  resetTranscriptTestDom();
});

function requireElement(container: Element, selector: string, label: string): Element {
  return expectDefined(container.querySelector(selector), label);
}

describe("chat Swarm progress", () => {
  it.each(["agent:main:parent", "parent"])(
    "stays visible for %s between the transcript and composer",
    (routeKey) => {
      const parentSessionKey = "agent:main:parent";
      const container = renderChatView({
        sessionKey: routeKey,
        canAbort: true,
        showNewMessages: true,
        swarm: {
          sessionKey: parentSessionKey,
          sessions: [
            {
              key: "agent:main:parent",
              kind: "direct",
              swarm: {
                groups: [
                  {
                    groupId: "swarm:agent:main:parent:turn-42",
                    createdAt: 1,
                    children: [{ sessionKey: "agent:main:subagent:worker", status: "running" }],
                    queued: 0,
                    running: 1,
                    done: 0,
                    failed: 0,
                  },
                ],
                otherActiveGroups: 0,
              },
            },
            {
              key: "agent:main:subagent:worker",
              kind: "direct",
              updatedAt: 1,
              parentSessionKey,
              swarmGroupId: "swarm:agent:main:parent:turn-42",
              label: "Worker A",
              status: "running",
            },
          ],
        },
      });

      const widget = requireElement(container, "[data-test-id=chat-swarm]", "Swarm progress");
      const shell = requireElement(container, ".agent-chat__composer-shell", "composer shell");
      const footer = requireElement(container, ".chat-footer", "footer");
      const scrollAnchor = footer.previousElementSibling;
      expect(scrollAnchor?.classList.contains("chat-scroll-to-bottom-wrap")).toBe(true);
      expect(scrollAnchor?.previousElementSibling?.classList.contains("chat-thread")).toBe(true);
      expect(widget.closest(".chat-footer")).toBe(footer);
      expect(shell.closest(".chat-footer")).toBe(footer);
      const input = requireElement(shell, ".agent-chat__input", "composer input");
      expect(widget.closest(".chat-footer__context")).not.toBeNull();
      expect(input.closest(".chat-footer__context")).toBeNull();
      expect(widget.compareDocumentPosition(input)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
      expect(container.querySelector(".chat-swarm__task-name")?.textContent).toBe("Worker A");
    },
  );
});

describe("inline approval card", () => {
  it("renders between the transcript and composer and enforces its grant projection", async () => {
    const onApprovalDecision = vi.fn();
    const inlineApproval = {
      id: "approval-inline",
      kind: "exec",
      request: {
        command: "rm -rf build",
        agentId: "main",
        sessionKey: "agent:main:current",
        commandSpans: [{ startIndex: 0, endIndex: 5 }],
      },
      createdAtMs: 1,
      expiresAtMs: 61_000,
    } satisfies ExecApprovalRequest;

    const container = renderChatView({
      inlineApproval,
      approvalCanGrant: false,
      approvalErrors: new Map([["approval-inline", "Approval failed: gateway unavailable"]]),
      onApprovalDecision,
    });

    const card = container.querySelector(".chat-inline-approval .exec-approval-card");
    const inlineSurface = requireElement(container, ".chat-inline-approval", "inline approval");
    const shell = requireElement(container, ".agent-chat__composer-shell", "composer shell");
    expect(card?.getAttribute("data-approval-id")).toBe("approval-inline");
    const footer = requireElement(container, ".chat-footer", "footer");
    const scrollAnchor = footer.previousElementSibling;
    expect(scrollAnchor?.classList.contains("chat-scroll-to-bottom-wrap")).toBe(true);
    expect(scrollAnchor?.previousElementSibling?.classList.contains("chat-thread")).toBe(true);
    expect(inlineSurface.closest(".chat-footer")).toBe(footer);
    expect(shell.closest(".chat-footer")).toBe(footer);
    const input = requireElement(shell, ".agent-chat__input", "composer input");
    expect(inlineSurface.closest(".chat-footer__context")).not.toBeNull();
    expect(input.closest(".chat-footer__context")).toBeNull();
    expect(inlineSurface.compareDocumentPosition(input)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    const countdown = expectDefined(
      container.querySelector<LitElement>(".exec-approval-countdown"),
      "inline approval countdown",
    );
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000);
    document.body.append(container);
    try {
      await countdown.updateComplete;
      expect(countdown.textContent?.trim()).toBe("expires in 01:00");
    } finally {
      container.remove();
      nowSpy.mockRestore();
    }
    expect(container.querySelector(".exec-approval-command-span")?.textContent).toBe("rm -r");
    expect(container.querySelector(".exec-approval-error")?.textContent).toBe(
      "Approval failed: gateway unavailable",
    );
    expect(container.querySelector(".exec-approval-warning")?.textContent?.trim()).toBe(
      "Review only. Sign in with approval access to record a decision.",
    );
    expect(
      Array.from(
        container.querySelectorAll<HTMLButtonElement>(".exec-approval-actions button"),
      ).every((button) => button.disabled),
    ).toBe(true);
    container.querySelector<HTMLButtonElement>(".exec-approval-actions button")?.click();
    expect(onApprovalDecision).not.toHaveBeenCalled();

    const authorizedContainer = renderChatView({
      inlineApproval,
      approvalCanGrant: true,
      onApprovalDecision,
    });
    authorizedContainer.querySelector<HTMLButtonElement>(".exec-approval-actions button")?.click();
    expect(onApprovalDecision).toHaveBeenCalledWith("approval-inline", "allow-once");
  });
});
