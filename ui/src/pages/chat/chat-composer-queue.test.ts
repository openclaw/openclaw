/* @vitest-environment jsdom */

import { createComponent, createSignal, getOwner, merge } from "solid-js";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { i18n, t } from "../../i18n/index.ts";
import type { HumanMention } from "../../lib/chat/chat-types.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import { renderChatQueueSolid } from "./components/chat-composer-queue.tsx";

type QueueProps = Parameters<typeof renderChatQueueSolid>[0];
const queues = new WeakMap<HTMLElement, (props: QueueProps) => void>();
const keydown = (key: string, extra: KeyboardEventInit = {}) =>
  new KeyboardEvent("keydown", { key, bubbles: true, ...extra });
const find = <T extends Element = HTMLElement>(root: ParentNode | null | undefined, part: string) =>
  root?.querySelector<T>(`.chat-queue__${part}`);
const text = (root: ParentNode | null | undefined, part: string) =>
  find(root, part)?.textContent?.trim();
const waitingPath = 'path[d="M21 5v12a2 2 0 0 1-2 2h-6"]';

afterEach(async () => {
  document.body.replaceChildren();
  await i18n.setLocale("en");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("chat composer steering queue", () => {
  it("keeps attempted unconfirmed messages inline while local commands retain retry and discard", () => {
    const onQueueRetry = vi.fn();
    const onQueueRemove = vi.fn();
    const container = renderQueue({
      queue: [
        waiting("message", 1, {
          sendState: "unconfirmed",
          sendAttempts: 1,
        }),
        waiting("reset", 2, {
          text: "/reset",
          localCommandName: "reset",
          sendState: "unconfirmed",
          sendError: "Check the conversation before retrying the command.",
          sendAttempts: 1,
        }),
      ],
      onQueueRetry,
      onQueueRemove,
    });

    const rows = container.querySelectorAll(".chat-queue__item");
    expect(rows).toHaveLength(1);
    expect(text(container, "global-state")).toBe(
      "Queue paused. Retry or discard the earlier unconfirmed message in the conversation.",
    );
    expect(rows[0]?.getAttribute("data-chat-queue-item")).toBe("reset");
    expect(text(rows[0], "badge")).toBe(t("chat.queue.states.needsReview"));
    find<HTMLButtonElement>(rows[0], "retry")?.click();
    find<HTMLButtonElement>(rows[0], "remove")?.click();
    expect(onQueueRetry).toHaveBeenCalledWith("reset");
    expect(onQueueRemove).toHaveBeenCalledWith("reset");
  });

  it("renders one actionable steer control without a duplicate state badge", () => {
    const onQueueSteer = vi.fn();
    const container = renderQueue({
      canAbort: true,
      queue: [waiting("steer-1", 1, { queueMode: "steer", sendState: "waiting-idle" })],
      onQueueSteer,
    });

    expect(find(container, "badge")).toBeNull();
    const steerButton = find<HTMLButtonElement>(container, "steer");
    expect(steerButton?.textContent?.trim()).toBe(t("chat.queue.steer"));
    steerButton?.click();
    expect(onQueueSteer).toHaveBeenCalledWith("steer-1");
    expect(find(container, "state")).toBeNull();
    expect(find(container, "global-state")).toBeNull();
    const icon = find(container, "icon");
    expect(icon?.querySelector(waitingPath)).not.toBeNull();
    expect(icon?.querySelector('path[d="M12 19V5m-7 7 7-7 7 7"]')).toBeNull();
    expect(icon?.querySelector("circle")).toBeNull();
  });

  it("keeps the queue identifier on failed and unconfirmed rows", () => {
    const container = renderQueue({
      queue: [
        waiting("failed-steer", 1, {
          queueMode: "steer",
          sendState: "failed",
          sendError: "steer rejected",
        }),
        waiting("unconfirmed", 2, { sendState: "unconfirmed" }),
      ],
    });

    const rows = [...container.querySelectorAll(".chat-queue__item")];
    expect(rows).toHaveLength(2);
    for (const terminalRow of rows) {
      const terminalIcon = find(terminalRow, "icon");
      expect(terminalIcon?.querySelector(waitingPath)).not.toBeNull();
      expect(terminalIcon?.querySelector('path[d^="m21.73 18"]')).toBeNull();
    }
    const row = rows[0];
    expect(row?.classList.contains("chat-queue__item--failed")).toBe(true);
    expect(text(row, "error .chat-queue__badge")).toBe(t("common.failed"));
  });
});

function renderQueue(
  options: Omit<QueueProps, "onQueueRemove"> & Partial<Pick<QueueProps, "onQueueRemove">>,
  container = document.body.appendChild(document.createElement("div")),
) {
  const props: QueueProps = { onQueueRemove: vi.fn(), ...options };
  const update = queues.get(container);
  if (update) {
    update(props);
  } else {
    const [current, setCurrent] = createSignal(props, { ownedWrite: true });
    const view = mountSolid(() => createComponent(renderChatQueueSolid, merge(current)), {
      container,
    });
    queues.set(container, setCurrent);
    onTestFinished(() => {
      queues.delete(container);
      view.unmount();
    });
  }
  if (!getOwner()) {
    flush();
  }
  return container;
}

function queueEdit(overrides: Partial<NonNullable<QueueProps["queuedEdit"]>>) {
  return { editingId: null, onCancel: vi.fn(), ...overrides };
}
function editFixture(editingText?: string) {
  const change = vi.fn(),
    submit = vi.fn(),
    cancel = vi.fn();
  const props = {
    queue: [waiting("a", 1)],
    queuedEdit: queueEdit({
      editingId: "a",
      editingText,
      onEditChange: change,
      onEditSubmit: submit,
      onCancel: cancel,
    }),
  };
  const container = renderQueue(props);
  return {
    props,
    container,
    editor: find<HTMLTextAreaElement>(container, "edit-input")!,
    change,
    submit,
    cancel,
  };
}

const waiting = (
  id: string,
  createdAt: number,
  overrides: Partial<QueueProps["queue"][number]> = {},
) => ({
  id,
  text: id,
  createdAt,
  sendState: "waiting-reconnect" as const,
  ...overrides,
});
const items = (
  ids: string,
  sendState: QueueProps["queue"][number]["sendState"] = "waiting-reconnect",
) => [...ids].map((id, index) => waiting(id, index + 1, { sendState }));

describe("chat composer queue reordering", () => {
  it("caps long queues and records both scroll boundaries", () => {
    const container = renderQueue({
      queue: items("abcd"),
    });
    const scroll = find<HTMLElement>(container, "scroll")!;
    Object.defineProperties(scroll, {
      clientHeight: { configurable: true, value: 149 },
      scrollHeight: { configurable: true, value: 220 },
    });

    expect(scroll.dataset).toMatchObject({ scrollable: "true", atStart: "true", atEnd: "false" });
    scroll.scrollTop = 24;
    scroll.dispatchEvent(new Event("scroll"));
    expect(scroll.dataset).toMatchObject({ atStart: "false", atEnd: "false" });
    scroll.scrollTop = 71;
    scroll.dispatchEvent(new Event("scroll"));
    expect(scroll.dataset.atEnd).toBe("true");
  });

  it("auto-scrolls a long queue while a drag stays near its edge", () => {
    const frames: FrameRequestCallback[] = [];
    const requestFrame = vi.fn((callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    const cancelFrame = vi.fn();
    vi.stubGlobal("requestAnimationFrame", requestFrame);
    vi.stubGlobal("cancelAnimationFrame", cancelFrame);
    const container = renderQueue({
      queue: items("abcd"),
      onQueueMove: vi.fn(),
    });
    const scroll = find<HTMLElement>(container, "scroll")!;
    vi.spyOn(scroll, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 100, 100));
    scroll.scrollTop = 10;
    const dragOver = new Event("dragover", { bubbles: true });
    Object.defineProperties(dragOver, {
      clientY: { value: 99 },
      dataTransfer: { value: { types: ["application/x-openclaw-queued-message"] } },
    });
    scroll.dispatchEvent(dragOver);
    expect(requestFrame).toHaveBeenCalledOnce();
    frames.shift()?.(0);
    expect(scroll.scrollTop).toBeGreaterThan(10);

    const dragLeave = new Event("dragleave", { bubbles: true });
    Object.defineProperty(dragLeave, "relatedTarget", { value: null });
    scroll.dispatchEvent(dragLeave);
    expect(cancelFrame).toHaveBeenCalled();
  });

  it.each([false, true])("ignores non-reorder gestures (editing=%s)", (editing) => {
    const onQueueMove = vi.fn();
    const container = renderQueue({
      queue: items(editing ? "abc" : "ab"),
      queuedEdit: editing ? queueEdit({ editingId: "b" }) : undefined,
      onQueueMove,
    });

    const rows = [...container.querySelectorAll(".chat-queue__item")];
    const grips = rows.map((row) => find(row, "grip"));
    if (editing) {
      expect(grips.every((grip) => grip !== null)).toBe(true);
      // The edited row splits the queue; neither neighbor has anywhere to go.
      expect(grips.map((grip) => grip!.hasAttribute("disabled"))).toEqual([true, true, true]);
      expect(rows[1]?.classList.contains("chat-queue__item--editing")).toBe(true);
    }

    const event = keydown(editing ? "ArrowUp" : "Enter", { cancelable: true });
    grips[editing ? 1 : 0]!.dispatchEvent(event);

    expect(onQueueMove).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("renders the inline editor while keeping other rows actionable", () => {
    const onQueueEdit = vi.fn();
    const onQueueSteer = vi.fn();
    const onQueueRemove = vi.fn();
    const container = renderQueue({
      canAbort: true,
      queue: items("abc", "waiting-idle"),
      queuedEdit: queueEdit({ editingId: "b", onEdit: onQueueEdit }),
      onQueueSteer,
      onQueueMove: vi.fn(),
      onQueueRemove,
    });

    const rows = [...container.querySelectorAll(".chat-queue__item")];
    const has = (selector: string) => rows.map((row) => row.querySelector(selector) !== null);
    expect(has(".chat-queue__overflow")).toEqual([true, false, true]);
    expect(find(rows[1], "edit-input")).not.toBeNull();
    expect(find(rows[1], "edit-submit")).not.toBeNull();
    expect(find(rows[1], "edit-cancel")).not.toBeNull();
    expect(has(".chat-queue__action")).toEqual([true, false, true]);

    const disabled = (selector: string) =>
      rows.map((row) => row.querySelector(selector)?.hasAttribute("disabled") ?? false);
    expect(disabled(".chat-queue__more")).toEqual([true, false, true]);
    expect(disabled(".chat-queue__remove")).toEqual([false, false, false]);

    find<HTMLButtonElement>(rows[2], "remove")?.click();
    expect(onQueueRemove).toHaveBeenCalledWith("c");
  });

  it("routes inline draft changes, submit, cancel, and keyboard shortcuts", () => {
    const { props, container, editor, change, submit, cancel } = editFixture("a draft");
    expect(editor.value).toBe("a draft");
    editor.dispatchEvent(new FocusEvent("focus"));
    expect(editor.selectionStart).toBe(editor.value.length);
    editor.value = "updated draft";
    editor.dispatchEvent(new Event("input", { bubbles: true }));
    expect(change).toHaveBeenCalledWith("updated draft");
    const valueWrites = vi.spyOn(editor, "value", "set");
    const publishDraft = (editingText: string) =>
      renderQueue({ ...props, queuedEdit: { ...props.queuedEdit, editingText } }, container);
    publishDraft("updated draft");
    expect(find(container, "edit-input")).toBe(editor);
    expect(valueWrites).not.toHaveBeenCalled();
    publishDraft("recovered draft");
    expect(editor.value).toBe("recovered draft");
    expect(valueWrites).toHaveBeenCalledExactlyOnceWith("recovered draft");
    editor.dispatchEvent(keydown("Escape"));
    expect(cancel).toHaveBeenCalledOnce();
    editor.dispatchEvent(keydown("Enter", { shiftKey: true }));
    expect(submit).not.toHaveBeenCalled();
    editor.dispatchEvent(keydown("Enter"));
    expect(submit).toHaveBeenCalledOnce();
  });

  it("leaves queue editor shortcuts to IME confirmation until keyup", () => {
    const { editor, submit, cancel } = editFixture();
    const composingEnter = keydown("Enter", { cancelable: true, isComposing: true });
    const legacyImeEscape = keydown("Escape", { cancelable: true, keyCode: 229 });

    editor.dispatchEvent(composingEnter);
    editor.dispatchEvent(legacyImeEscape);
    const compositionEnd = new CompositionEvent("compositionend", { bubbles: true });
    editor.dispatchEvent(compositionEnd);
    const confirmingEnter = keydown("Enter", { keyCode: 13, cancelable: true });
    Object.defineProperty(confirmingEnter, "timeStamp", {
      value: compositionEnd.timeStamp - 1,
    });
    editor.dispatchEvent(confirmingEnter);

    expect(
      [composingEnter, legacyImeEscape, confirmingEnter].map((event) => event.defaultPrevented),
    ).toEqual([false, false, false]);
    expect(submit).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    editor.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true }));
    editor.dispatchEvent(keydown("Enter"));
    expect(submit).toHaveBeenCalledOnce();
  });

  it("edits and explicitly removes queued recipients without reassigning identical labels", () => {
    let editingText = "@Alex @Alex";
    let editingMentions: readonly HumanMention[] = [
      { profileId: "first-alex", start: 0, end: 5 },
      { profileId: "second-alex", start: 6, end: 11 },
    ];
    const container = document.createElement("div");
    document.body.append(container);
    const draw = () =>
      renderQueue(
        {
          queue: [{ ...waiting("a", 1), text: "@Alex @Alex" }],
          queuedEdit: queueEdit({
            editingId: "a",
            editingText,
            editingMentions,
            onEditChange: (draft, mentions) => {
              editingText = draft;
              editingMentions = mentions ?? [];
              draw();
            },
          }),
        },
        container,
      );
    draw();
    const editor = container.querySelector<HTMLTextAreaElement>("textarea")!;
    editor.setSelectionRange(0, 6);
    editor.dispatchEvent(
      new InputEvent("beforeinput", { bubbles: true, inputType: "deleteContentBackward" }),
    );
    editor.value = "@Alex";
    editor.dispatchEvent(
      new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }),
    );
    expect(editingMentions).toEqual([{ profileId: "second-alex", start: 0, end: 5 }]);
    expect(container.textContent).toContain("Will notify: @Alex");
    container.querySelector<HTMLButtonElement>('button[aria-label="Remove mention"]')!.click();
    expect(editingMentions).toEqual([]);
    expect(editor.value).toBe("@Alex");
    expect(container.textContent).not.toContain("Will notify:");
  });

  it("projects one offline state on each row without a queue header", () => {
    const container = renderQueue({
      offline: true,
      queue: [waiting("a", 1, { queueMode: "steer", sendState: "waiting-idle" })],
    });

    const row = find(container, "item");
    expect(row?.classList.contains("chat-queue__item--reconnect")).toBe(true);
    expect(row?.querySelectorAll(".chat-queue__badge")).toHaveLength(1);
    expect(text(row, "badge--reconnect")).toBe(t("chat.queue.states.waitingForReconnect"));
    expect(find(row, "state")).toBeNull();
    expect(container.querySelectorAll(".chat-queue__global-state")).toHaveLength(0);
  });

  it("projects applying settings once and preserves the steer affordance", () => {
    const container = renderQueue({
      canAbort: true,
      queue: [
        waiting("a", 1, { queueMode: "steer", sendState: "waiting-model" }),
        waiting("b", 2, { sendState: "waiting-model" }),
      ],
      onQueueSteer: vi.fn(),
    });

    expect(container.querySelectorAll(".chat-queue__global-state")).toHaveLength(1);
    expect(text(container, "global-state")).toBe(t("chat.queue.states.applyingSettings"));
    expect(container.querySelectorAll(".chat-queue__state")).toHaveLength(0);
    const steerButtons = [...container.querySelectorAll<HTMLButtonElement>(".chat-queue__steer")];
    expect(steerButtons).toHaveLength(2);
    expect(steerButtons.every((button) => button.disabled)).toBe(true);
    expect(container.querySelectorAll(".chat-queue__badge--steered")).toHaveLength(1);
  });

  it("reports the drop position of the row the message was dropped on", () => {
    const onQueueMove = vi.fn();
    const container = renderQueue({
      queue: items("abc"),
      onQueueMove,
    });
    const rows = [...container.querySelectorAll(".chat-queue__item")];
    const dataTransfer = {
      types: ["application/x-openclaw-queued-message"],
      getData: () => "c",
      setData: vi.fn(),
      dropEffect: "none",
      effectAllowed: "none",
    };

    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", { value: dataTransfer });
    rows[0]!.dispatchEvent(drop);

    expect(onQueueMove.mock.calls).toEqual([["c", "a"]]);
  });
});
