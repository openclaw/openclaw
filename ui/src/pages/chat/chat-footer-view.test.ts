/* @vitest-environment jsdom */
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { ExecApprovalRequest } from "../../app/exec-approval.ts";
import type { SolidBridgeElement } from "../../lib/solid-bridge.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import { resetChatViewState } from "./chat-view-state.test-support.ts";
import { renderChatView, requireElement } from "./chat-view.test-helpers.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
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

it("keeps Swarm progress between the transcript and composer", () => {
  const sessionKey = "agent:main:parent";
  const childKey = "agent:main:subagent:worker";
  const groupId = `swarm:${sessionKey}:turn-42`;
  const group = {
    groupId,
    createdAt: 1,
    children: [{ sessionKey: childKey, status: "running" as const }],
    queued: 0,
    running: 1,
    done: 0,
    failed: 0,
  };
  const sessions: GatewaySessionRow[] = [
    { key: sessionKey, kind: "direct", swarm: { groups: [group], otherActiveGroups: 0 } },
    { key: childKey, kind: "direct", swarmGroupId: groupId, label: "Worker A" },
  ];
  const container = renderChatView({
    sessionKey,
    canAbort: true,
    showNewMessages: true,
    swarm: { sessionKey, sessions },
  });
  const widget = requireElement(container, "[data-test-id=chat-swarm]", "Swarm progress");
  expectFooterContext(container, widget);
  expect(container.querySelector(".chat-swarm__task-name")?.textContent).toBe("Worker A");
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
    await expectDefined(
      container.querySelector<SolidBridgeElement<object>>("openclaw-exec-approval-card"),
      "inline approval host",
    ).updateComplete;
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
