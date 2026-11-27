/* @vitest-environment jsdom */
import { redo, undo } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { expect, it, onTestFinished, vi } from "vitest";
import { prepareFileReferenceDestination } from "../../lib/chat/file-reference-destination.ts";
import {
  composerFileReferenceFixture,
  fileReferenceFixture,
} from "../../lib/chat/file-references.test-support.ts";
import { fileReferenceText } from "../../lib/chat/file-references.ts";
import { createFileReferenceDestinationFixture } from "./composer-file-reference-destination.test-support.ts";

function fixture(text = "Review at file example") {
  const result = createFileReferenceDestinationFixture(text);
  onTestFinished(() => result.dispose());
  const content = result.input.parentElement!.querySelector<HTMLElement>(".cm-content")!;
  const view = EditorView.findFromDOM(content)!;
  const commit = (id = "approval-one") =>
    result.destination.commit({
      id,
      snapshot: result.destination.snapshot(),
      from: 7,
      to: result.text.length,
      text: "@src/example.ts",
      references: [composerFileReferenceFixture],
    });
  return { ...result, source: result, view, commit };
}

it("commits text and opaque identity together once, with atomic undo and redo", () => {
  const f = fixture();
  const observed: unknown[] = [];
  f.source.onEdit(() => observed.push({ text: f.source.text, references: f.source.references }));
  const receipt = f.commit();
  expect(receipt.status).toBe("committed");
  const expected = [{ start: 7, end: 22, reference: fileReferenceFixture }];
  expect(observed).toEqual([{ text: "Review @src/example.ts", references: expected }]);
  expect(f.commit()).toBe(receipt);
  expect(observed).toHaveLength(1);
  expect(undo(f.view)).toBe(true);
  expect(f.source.text).toBe("Review at file example");
  expect(f.source.references).toEqual([]);
  expect(redo(f.view)).toBe(true);
  expect(f.source.text).toBe("Review @src/example.ts");
  expect(f.source.references).toEqual(expected);
});

it("preserves references through boundary typing and remount, but clears same-text replacements", () => {
  const f = fixture();
  expect(f.commit().status).toBe("committed");
  f.view.dispatch({ changes: { from: 22, insert: " please" }, userEvent: "input.type" });
  expect(f.source.references[0]?.reference.objectId).toBe("opaque-file-one");
  const priorTarget = f.source.destination.snapshot().targetId;
  f.source.remount();
  expect(f.source.destination.snapshot().targetId).not.toBe(priorTarget);
  expect(f.source.destination.snapshot().references).toEqual([
    { start: 7, end: 22, reference: fileReferenceFixture },
  ]);
  const text = f.source.text;
  f.source.externalEdit(text);
  expect(f.source.text).toBe(text);
  expect(f.source.destination.snapshot().references).toEqual([]);
});

it("refuses stale or unsupported destinations and converts without changing text", async () => {
  const unbound = document.createElement("textarea");
  expect(await prepareFileReferenceDestination(unbound)).toBeNull();
  const f = fixture();
  const snapshot = f.source.destination.snapshot();
  f.source.externalEdit("Newer draft");
  expect(
    f.source.destination.commit({
      id: "stale",
      snapshot,
      from: 7,
      to: 22,
      text: "@src/example.ts",
      references: [composerFileReferenceFixture],
    }).status,
  ).toBe("not-committed");
  expect(f.source.text).toBe("Newer draft");
  f.source.externalEdit("Review at file example");
  expect(f.commit("fresh").status).toBe("committed");
  f.source.input.disabled = true;
  f.source.destination.snapshot();
  expect(f.source.references).toHaveLength(1);
  f.source.input.disabled = false;
  f.source.destination.clearReferences();
  expect(f.source.text).toBe("Review @src/example.ts");
  expect(f.source.references).toEqual([]);
  expect(fileReferenceText({ ...fileReferenceFixture, relativePath: "<img>\u202e\n.ts" })).toBe(
    "@<img>\\u{202e}\\u{a}.ts",
  );
  expect(document.querySelector("img")).toBeNull();
});

// A native dispatch may commit before a foreign host callback fails. The receipt still owns retry.
it("never repeats an insertion after a post-commit dispatch failure", () => {
  const f = fixture();
  const request = {
    id: "uncertain",
    snapshot: f.source.destination.snapshot(),
    from: 7,
    to: 22,
    text: "@src/example.ts",
    references: [composerFileReferenceFixture],
  };
  const dispatch = f.view.dispatch.bind(f.view);
  const failed = vi.spyOn(f.view, "dispatch").mockImplementation((transaction) => {
    dispatch(transaction);
    throw new Error("Synthetic host failure after dispatch");
  });
  const receipt = f.source.destination.commit(request);
  failed.mockRestore();
  expect(receipt.status).toBe("outcome-unknown");
  expect(f.source.destination.commit(request)).toBe(receipt);
  expect(f.source.text).toBe("Review @src/example.ts");
  expect(f.source.references).toHaveLength(1);
});
