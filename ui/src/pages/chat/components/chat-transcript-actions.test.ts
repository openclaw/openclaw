/* @vitest-environment jsdom */
import { expect, it, vi } from "vitest";
import type { ChatDisplayFacts, ChatRowDisplay } from "../../../lib/chat/row-display-facts.ts";
import { createTranscriptActions } from "./chat-transcript-actions.ts";
import { threadProps } from "./chat-transcript.test-support.ts";

it("dispatches retained actions through the current target without changing availability", () => {
  const context: Parameters<typeof createTranscriptActions>[0] = {};
  const first = vi.fn();
  const next = vi.fn();
  const initial = createTranscriptActions(
    context,
    threadProps("actions", "main", [], { onFocusComposer: first }),
  );
  const current = createTranscriptActions(
    context,
    threadProps("actions", "main", [], { onFocusComposer: next }),
  );
  expect(initial.dependencies).toEqual(current.dependencies);
  initial.actions.onFocusComposer?.();
  expect(first).not.toHaveBeenCalled();
  expect(next).toHaveBeenCalledOnce();
  createTranscriptActions(context, threadProps("actions"));
  initial.actions.onFocusComposer?.();
  expect(next).toHaveBeenCalledOnce();
  expect(initial.actions.onOpenSidebar).toBeUndefined();
});

it("keeps retained display reads and writes inside their original scope", () => {
  const context: Parameters<typeof createTranscriptActions>[0] = {};
  const original: ChatRowDisplay = {
    read: () => ({ scope: "scope-a", facts: {} }),
    write: vi.fn(),
  };
  const write = vi.fn();
  let scope = "scope-a";
  const current: ChatRowDisplay = { read: () => ({ scope, facts: {} }), write };
  const facts = (row: ChatRowDisplay): ChatDisplayFacts => ({ forRow: () => row });
  const retained = createTranscriptActions(
    context,
    threadProps("display", "main", [], { displayFacts: facts(original) }),
  ).actions.displayFacts?.forRow("row");
  expect(retained).toBeDefined();
  createTranscriptActions(
    context,
    threadProps("display", "main", [], { displayFacts: facts(current) }),
  );
  expect(retained?.read()?.scope).toBe("scope-a");
  retained?.write({});
  expect(write).toHaveBeenCalledOnce();
  scope = "scope-b";
  expect(retained?.read()).toBeUndefined();
  retained?.write({});
  expect(write).toHaveBeenCalledOnce();
  expect(original.write).not.toHaveBeenCalled();
});
