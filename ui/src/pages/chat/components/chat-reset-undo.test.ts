/* @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { threadFixture } from "./chat-transcript-fixture.test-support.tsx";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
  threadProps,
} from "./chat-transcript.test-support.ts";

beforeEach(installTranscriptDomMocks);
afterEach(resetTranscriptTestDom);

const msg = (role: string, content: unknown, timestamp = 1_000, extra = {}) => ({
  role,
  content,
  timestamp,
  ...extra,
});

it("offers reset Undo only for the current explicit boundary and refreshes its action", async () => {
  const originalUndo = vi.fn();
  const currentUndo = vi.fn();
  const reset = (id: string, boundaryId?: string) =>
    msg("system", [], 2_000, { __openclaw: { kind: "reset", id, boundaryId } });
  const props = threadProps(
    "pane-reset-undo",
    "agent:main:reset-undo",
    [
      msg("user", "Keep this earlier question"),
      reset("old-reset", "old-boundary"),
      reset("current-reset", "current-boundary"),
    ],
    { onUndoReset: originalUndo },
  );
  const { transcript, container, rerender } = threadFixture(props);
  const undo = () => container.querySelector<HTMLButtonElement>(".chat-divider button");
  try {
    rerender();
    await waitForSolid(() => expect(undo()?.textContent).toBe("Undo"));
    expect(container.querySelectorAll(".chat-divider button")).toHaveLength(1);
    undo()!.click();
    expect(originalUndo).toHaveBeenCalledExactlyOnceWith("current-boundary");

    props.onUndoReset = currentUndo;
    props.undoResetPending = true;
    rerender();
    await waitForSolid(() => expect(undo()?.disabled).toBe(true));
    undo()!.click();
    expect(currentUndo).not.toHaveBeenCalled();

    props.undoResetPending = false;
    rerender();
    await waitForSolid(() => expect(undo()?.disabled).toBe(false));
    undo()!.click();
    expect(currentUndo).toHaveBeenCalledExactlyOnceWith("current-boundary");
    expect(originalUndo).toHaveBeenCalledTimes(1);

    // A legacy reset still retires the earlier receipt; its display ID is not an Undo receipt.
    props.messages = [...props.messages, reset("legacy-reset")];
    rerender();
    await waitForSolid(() => expect(undo()).toBeNull());
  } finally {
    transcript.dispose();
  }
});
