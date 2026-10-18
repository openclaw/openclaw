/* @vitest-environment jsdom */

import { createComponent, createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { ExecApprovalRequest } from "../app/exec-approval.ts";
import { i18n } from "../i18n/index.ts";
import { getRenderedModalDialog, installDialogPolyfill } from "../test-helpers/modal-dialog.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { flush } from "../test-helpers/solid-settle.ts";
import {
  ExecApproval,
  type ExecApprovalElement,
  type ExecApprovalProps,
} from "./exec-approval-solid.tsx";

let container: HTMLDivElement;
let restoreDialogPolyfill: () => void;
let setProps: ((props: ExecApprovalProps) => void) | undefined;

function request(overrides: Partial<ExecApprovalRequest> = {}): ExecApprovalRequest {
  return {
    id: "approval-1",
    kind: "exec",
    request: {
      command: "echo hello",
      ask: "on-request",
    },
    createdAtMs: Date.now() - 1_000,
    expiresAtMs: Date.now() + 60_000,
    ...overrides,
  };
}

async function render(
  requestOrQueue: ExecApprovalRequest | ExecApprovalRequest[] = request(),
  overrides: Partial<Omit<ExecApprovalProps, "queue" | "onDecision">> & {
    onDecision?: Mock<ExecApprovalProps["onDecision"]>;
  } = {},
) {
  const queue = Array.isArray(requestOrQueue) ? requestOrQueue : [requestOrQueue];
  const props = {
    queue,
    busy: false,
    canGrant: true,
    errors: new Map<string, string>(),
    onDecision: vi.fn<ExecApprovalProps["onDecision"]>(),
    ...overrides,
  };
  const { onDecision } = props;
  if (setProps) {
    setProps(props);
  } else {
    mountSolid(
      () => {
        const [current, setCurrent] = createSignal(props);
        setProps = setCurrent;
        return createComponent(ExecApproval, {
          get props() {
            return current();
          },
        });
      },
      { container },
    );
  }
  flush();
  const approval = container.querySelector<ExecApprovalElement>("openclaw-exec-approval");
  if (!approval) {
    throw new Error("Expected exec approval");
  }
  await approval.updateComplete;
  return { approval, onDecision };
}

async function openApproval(
  requestOrQueue: ExecApprovalRequest | ExecApprovalRequest[] = request(),
  overrides: Parameters<typeof render>[1] = {},
) {
  const rendered = await render(requestOrQueue, overrides);
  rendered.approval.show();
  await rendered.approval.updateComplete;
  return { ...rendered, ...(await getRenderedModalDialog(container)) };
}

function part<T extends HTMLElement = HTMLElement>(name: string) {
  return container.querySelector<T>(`.exec-approval-${name}`);
}

function activeId() {
  return part("card")?.getAttribute("data-approval-id");
}

function chord(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  return new KeyboardEvent("keydown", { key, metaKey: true, bubbles: true, ...init });
}

describe("openclaw-exec-approval", () => {
  beforeEach(async () => {
    restoreDialogPolyfill = installDialogPolyfill();
    await i18n.setLocale("en");
    container = document.createElement("div");
    document.body.append(container);
  });

  afterEach(async () => {
    setProps = undefined;
    vi.useRealTimers();
    container.remove();
    await i18n.setLocale("en");
    restoreDialogPolyfill();
    vi.restoreAllMocks();
  });

  it("does not show exec unavailable copy for restricted plugin approvals", async () => {
    await openApproval(
      request({
        id: "plugin-approval-1",
        kind: "plugin",
        request: {
          command: "Plugin approval",
          allowedDecisions: ["allow-once", "deny"],
        },
        pluginTitle: "Plugin approval",
      }),
    );
    expect(
      Array.from(container.querySelectorAll(".exec-approval-actions button > span")).map((label) =>
        label.textContent?.trim(),
      ),
    ).toEqual(["Allow once", "Deny"]);
    expect(part("warning")).toBeNull();
  });

  it("keeps the visible and accessible expiry countdowns synchronized", async () => {
    const intervals = vi.spyOn(globalThis, "setInterval");
    let nowMs = 0;
    vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    await openApproval(request({ expiresAtMs: 90_500 }));
    const { dialog } = await getRenderedModalDialog(container);
    const countdown = part<HTMLElement>("countdown");
    if (!countdown) {
      throw new Error("Expected approval countdown");
    }
    flush();
    expect(countdown.textContent?.trim()).toBe("expires in 01:31");
    expect(dialog.getAttribute("aria-description")).toBe("expires in 01:31");
    const card = part("card");
    nowMs = 1_000;
    const tick = intervals.mock.calls.find(([, delay]) => delay === 1_000)?.[0];
    if (typeof tick !== "function") {
      throw new Error("Expected countdown interval");
    }
    tick();
    flush();
    expect(countdown.textContent?.trim()).toBe("expires in 01:30");
    await getRenderedModalDialog(container);
    expect(dialog.getAttribute("aria-description")).toBe("expires in 01:30");
    expect(part("card")).toBe(card);
  });

  it("selects another queued request without changing queue order", async () => {
    const queue = [
      request({ id: "approval-oldest", createdAtMs: 1 }),
      request({
        id: "approval-newer",
        createdAtMs: 2,
        request: { command: "pnpm test", agentId: "worker" },
      }),
    ];
    const { approval, onDecision } = await openApproval(queue);
    const card = part("card")!;
    const actions = card.querySelector(".exec-approval-actions")!;
    const pending = part("list")!;
    expect(card.contains(pending)).toBe(true);
    expect(card.lastElementChild).toBe(actions);
    expect(
      pending.compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(activeId()).toBe("approval-oldest");
    part<HTMLButtonElement>("list__item")?.click();
    await approval.updateComplete;
    expect(activeId()).toBe("approval-newer");
    expect(queue.map((entry) => entry.id)).toEqual(["approval-oldest", "approval-newer"]);
    part<HTMLButtonElement>("actions button")!.click();
    expect(onDecision).toHaveBeenCalledWith("approval-newer", "allow-once");
  });

  it("compacts queued commands without splitting a surrogate pair", async () => {
    // The emoji straddles the truncation boundary; slicing UTF-16 would split it.
    const queue = [
      request({ id: "approval-active", createdAtMs: 1 }),
      request({
        id: "approval-queued",
        createdAtMs: 2,
        request: { command: `${"a".repeat(60)}🙂 --extra` },
      }),
    ];
    await openApproval(queue);
    expect(part("list__command")?.textContent).toBe(`${"a".repeat(60)}…`);
  });

  it("handles modal approval keyboard shortcuts", async () => {
    const { onDecision, modal } = await openApproval();
    modal.dispatchEvent(chord("Enter"));
    modal.dispatchEvent(chord("Enter", { shiftKey: true }));
    modal.dispatchEvent(chord("в", { code: "KeyD", metaKey: false, ctrlKey: true }));
    expect(onDecision.mock.calls).toEqual([
      ["approval-1", "allow-once"],
      ["approval-1", "allow-always"],
      ["approval-1", "deny"],
    ]);
  });

  it("keeps review-only decisions disabled and ignores their shortcuts", async () => {
    const { onDecision, modal } = await openApproval(request(), {
      canGrant: false,
    });
    const buttons = Array.from(
      container.querySelectorAll<HTMLButtonElement>(".exec-approval-actions button"),
    );
    expect(part("warning")?.textContent?.trim()).toBe(
      "Review only. Sign in with approval access to record a decision.",
    );
    expect(buttons.every((button) => button.disabled)).toBe(true);
    buttons[0]?.click();
    modal.dispatchEvent(chord("Enter"));
    modal.dispatchEvent(chord("d"));
    expect(onDecision).not.toHaveBeenCalled();
  });

  it.each([
    [
      "bare or alt-modified keys",
      [
        new KeyboardEvent("keydown", { key: "a", bubbles: true }),
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
        new KeyboardEvent("keydown", { key: "d", bubbles: true }),
        chord("Enter", { altKey: true }),
      ],
    ],
    [
      "auto-repeated shortcuts",
      [chord("Enter", { repeat: true }), chord("Enter", { shiftKey: true, repeat: true })],
    ],
  ] as const)("ignores %s", async (_name, events) => {
    const { onDecision, modal } = await openApproval();
    for (const event of events) {
      modal.dispatchEvent(event);
    }
    expect(onDecision).not.toHaveBeenCalled();
  });

  it("keeps the displayed approval pinned when an older request arrives", async () => {
    const newer = request({ id: "approval-newer", createdAtMs: 2_000 });
    const older = request({ id: "approval-older", createdAtMs: 1_000 });
    const { approval } = await openApproval([newer]);
    expect(activeId()).toBe("approval-newer");
    // A late older request must not replace the card being reviewed.
    await render([older, newer]);
    await approval.updateComplete;
    expect(activeId()).toBe("approval-newer");
    // Once the pinned request settles, the head takes over.
    await render([older]);
    await approval.updateComplete;
    expect(activeId()).toBe("approval-older");
  });

  it("guards shortcuts while busy, disallowed, or focused in text input", async () => {
    const restricted = request({
      request: { command: "echo hello", allowedDecisions: ["allow-once", "deny"] },
    });
    const onDecision = vi.fn();
    await openApproval(restricted, { busy: true, onDecision });
    let rendered = await getRenderedModalDialog(container);
    rendered.modal.dispatchEvent(chord("Enter"));
    await render(restricted, { onDecision });
    rendered = await getRenderedModalDialog(container);
    rendered.modal.dispatchEvent(chord("Enter", { shiftKey: true }));
    const input = document.createElement("input");
    rendered.modal.append(input);
    input.dispatchEvent(chord("d", { composed: true }));
    const editor = document.createElement("div");
    editor.setAttribute("contenteditable", "true");
    const editorChild = document.createElement("span");
    editor.append(editorChild);
    rendered.modal.append(editor);
    editorChild.dispatchEvent(chord("Enter", { composed: true }));
    expect(onDecision).not.toHaveBeenCalled();
  });

  it("blocks dismissal while a decision is in flight", async () => {
    const { onDecision, modal } = await openApproval(
      request({ request: { command: "echo hello" } }),
      { busy: true },
    );
    const cancel = new CustomEvent("modal-cancel", {
      bubbles: true,
      composed: true,
      cancelable: true,
    });
    expect(modal.dispatchEvent(cancel)).toBe(false);
    expect(cancel.defaultPrevented).toBe(true);
    expect(onDecision).not.toHaveBeenCalled();
  });
  // Settings Escape guards distinguish a passive queue from an open dialog.
  it("records dialogOpen only while the dialog is explicitly open", async () => {
    const { approval, onDecision } = await render();
    const opener = document.createElement("button");
    container.append(opener);
    opener.focus();
    expect(approval.dialogOpen).toBe(false);
    expect(container.querySelector("openclaw-modal-dialog")).toBeNull();
    approval.show();
    await approval.updateComplete;
    expect(approval.dialogOpen).toBe(true);
    const { dialog } = await getRenderedModalDialog(container);
    expect(dialog.open).toBe(true);
    expect(dialog.contains(document.activeElement)).toBe(true);
    dialog.dispatchEvent(new Event("cancel", { cancelable: true }));
    await approval.updateComplete;
    expect(approval.dialogOpen).toBe(false);
    expect(container.querySelector("openclaw-modal-dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
    expect(onDecision).not.toHaveBeenCalled();
    approval.show();
    await approval.updateComplete;
    const reopened = await getRenderedModalDialog(container);
    expect(reopened.dialog.open).toBe(true);
    expect(approval.dialogOpen).toBe(true);
    expect(onDecision).not.toHaveBeenCalled();
  });

  it("closes and resets after the approval queue drains", async () => {
    await openApproval();
    expect(container.querySelector("openclaw-modal-dialog")).not.toBeNull();
    let rendered = await render([]);
    await rendered.approval.updateComplete;
    expect(container.querySelector("openclaw-modal-dialog")).toBeNull();
    rendered = await render();
    await rendered.approval.updateComplete;
    expect(container.querySelector("openclaw-modal-dialog")).toBeNull();
  });
});
