/* @vitest-environment jsdom */
import { createSignal, flush, type Setter } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import { prepareDictationFormatting } from "../../../lib/dictation/formatting.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { ComposerDictationOwner } from "../composer-dictation.ts";
import { ComposerDictationSendAction } from "./chat-composer-controls.tsx";
import { DictationFormattingReview } from "./composer-dictation-formatting.tsx";

type Review = NonNullable<ComposerDictationOwner["formattingReview"]>;

function mountReview(initial: Review) {
  const actions = {
    setFormattingMode: vi.fn(),
    acceptFormatting: vi.fn(() => true),
    dismissFormatting: vi.fn(),
    reprocessFormatting: vi.fn(),
    confirmFormattingMarkers: vi.fn(),
  };
  let update: Setter<Review> | undefined;
  const view = mountSolid(() => {
    const [review, setReview] = createSignal(initial);
    update = setReview;
    const owner = {
      ...actions,
      formattingMode: "explicit" as const,
      get formattingReview() {
        return review();
      },
    };
    return <DictationFormattingReview readDictation={() => owner} />;
  });
  flush();
  return {
    ...view,
    actions,
    update(next: Review) {
      if (!update) {
        throw new Error("Review was not mounted");
      }
      update(next);
      flush();
    },
  };
}

function choose(element: HTMLElement, value: string) {
  if (!(element instanceof HTMLSelectElement)) {
    throw new Error("Expected a native select");
  }
  element.value = value;
  element.dispatchEvent(new Event("change", { bubbles: true }));
  flush();
}

afterEach(() => vi.unstubAllGlobals());

it.each([true, false])(
  "uses the capture's review policy before awaiting finish: %s",
  async (requiresReview) => {
    const owner = new ComposerDictationOwner({
      client: null,
      connected: true,
      enabled: true,
      realtimeTalkActive: false,
      onCommit: vi.fn(),
      onError: vi.fn(),
    });
    const active = vi.spyOn(owner, "active", "get").mockReturnValue(true);
    const policy = vi
      .spyOn(owner, "requiresFormattingReview", "get")
      .mockReturnValue(requiresReview);
    const pending = createDeferred<boolean>();
    const finish = vi.spyOn(owner, "finishActive").mockImplementation(() => {
      policy.mockReturnValue(!requiresReview);
      return pending.promise;
    });
    const onSend = vi.fn();
    const view = mountSolid(() => (
      <ComposerDictationSendAction readDictation={() => owner} onSend={onSend} />
    ));
    try {
      view.getByRole("button", { name: requiresReview ? "Finish and review" : "Send" }).click();
      expect(finish).toHaveBeenCalledOnce();
      expect(onSend).not.toHaveBeenCalled();
      pending.resolve(true);
      await pending.promise;
      flush();
      expect(onSend).toHaveBeenCalledTimes(requiresReview ? 0 : 1);
    } finally {
      view.unmount();
      finish.mockRestore();
      policy.mockRestore();
      active.mockRestore();
      owner.dispose();
    }
  },
);

it("previews real list semantics and escaped literal content with explicit insertion controls", () => {
  const original = "Shopping list bullet milk next item <img src=x onerror=alert(1)>";
  const result = prepareDictationFormatting(original, "explicit", {
    confirmedMarkers: [
      { start: 14, end: 20 },
      { start: 26, end: 35 },
    ],
  });
  const view = mountReview({
    result,
    canApply: true,
    canApplyOriginal: true,
    receipt: "not-committed",
  });
  try {
    const preview = view.getByRole("region", { name: "Semantic preview" });
    expect(preview.querySelectorAll("ul > li")).toHaveLength(2);
    expect(preview.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(preview.querySelector("img,script,a")).toBeNull();
    expect(preview.tabIndex).toBe(0);
    const status = view.getByRole("status");
    choose(view.getByRole("combobox", { name: "Preview format" }), "plain");
    const plain = view.getByRole("textbox", { name: "Plain text preview" });
    if (!(plain instanceof HTMLTextAreaElement)) {
      throw new Error("Expected a text preview");
    }
    expect(plain.value).toBe(result.plainText);
    expect(plain.readOnly).toBe(true);
    expect(view.getByRole("status")).toBe(status);
    choose(view.getByRole("combobox", { name: "Dictation formatting" }), "preserve");
    expect(view.actions.setFormattingMode).toHaveBeenCalledExactlyOnceWith("preserve");
    expect(view.actions.reprocessFormatting).not.toHaveBeenCalled();
    view.getByRole("button", { name: "Reprocess" }).click();
    expect(view.actions.reprocessFormatting).toHaveBeenCalledOnce();
    for (const button of view.getAllByRole("button")) {
      expect(button.getAttribute("type")).toBe("button");
    }
    view.getByRole("button", { name: "Keep original" }).click();
    expect(view.actions.acceptFormatting).toHaveBeenCalledExactlyOnceWith("original");
    view
      .getByRole("group", { name: "Review dictation" })
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(view.actions.dismissFormatting).toHaveBeenCalledOnce();
  } finally {
    view.unmount();
  }
});

it("retains focus and its live region when insertion becomes unsafe while allowing plain recovery", async () => {
  const result = prepareDictationFormatting("bullet one next item two", "explicit");
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  const view = mountReview({
    result,
    canApply: true,
    canApplyOriginal: true,
    receipt: "not-committed",
  });
  try {
    const status = view.getByRole("status");
    const selector = view.getByRole("combobox", { name: "Preview format" });
    selector.focus();
    view.update({ result, canApply: false, canApplyOriginal: true, receipt: "not-committed" });
    expect(view.getByRole("button", { name: "Use formatted text" }).hasAttribute("disabled")).toBe(
      true,
    );
    expect(view.getByRole("button", { name: "Keep original" }).hasAttribute("disabled")).toBe(
      false,
    );
    expect(status.textContent).toContain("select the whole message before recording");
    view.update({ result, canApply: false, canApplyOriginal: false, receipt: "not-committed" });
    expect(view.getByRole("status")).toBe(status);
    expect(status.textContent).toContain("insertion target changed");
    expect(document.activeElement).toBe(selector);
    view.update({ result, canApply: true, canApplyOriginal: true, receipt: "outcome-unknown" });
    for (const name of ["Use formatted text", "Keep original", "Reprocess"]) {
      const button = view.getByRole("button", { name });
      expect(button.hasAttribute("disabled")).toBe(true);
      button.click();
    }
    expect(view.actions.acceptFormatting).not.toHaveBeenCalled();
    expect(view.actions.reprocessFormatting).not.toHaveBeenCalled();
    expect(status.textContent).toContain("Insertion could not be confirmed");
    view.getByRole("button", { name: "Copy plain text" }).click();
    await waitForSolid(() => expect(status.textContent).toContain("Plain text copied."));
    expect(writeText).toHaveBeenCalledExactlyOnceWith(result.plainText);
    expect(view.getByRole("status")).toBe(status);
  } finally {
    view.unmount();
  }
});

it("shows complete original text when resource limits prevent a semantic preview", () => {
  const original = "long ".repeat(7_000);
  const result = prepareDictationFormatting(original, "explicit");
  const view = mountReview({
    result,
    canApply: true,
    canApplyOriginal: true,
    receipt: "not-committed",
  });
  try {
    const plain = view.getByRole("textbox", { name: "Plain text preview" });
    if (!(plain instanceof HTMLTextAreaElement)) {
      throw new Error("Expected a text preview");
    }
    expect(plain.value).toBe(original);
    expect(view.getByRole("status").textContent).toContain("Formatting was unavailable");
    expect(view.getByRole("button", { name: "Use formatted text" }).hasAttribute("disabled")).toBe(
      true,
    );
    expect(view.getByRole("button", { name: "Keep original" }).hasAttribute("disabled")).toBe(
      false,
    );
  } finally {
    view.unmount();
  }
});

it("explains command overflow while retaining the complete original without automatic insertion", () => {
  const original = Array.from({ length: 21 }, (_, index) => `bullet item ${index}`).join(" ");
  const result = prepareDictationFormatting(original, "explicit");
  expect(result.reason).toBe("too-many-ambiguous-commands");
  const view = mountReview({
    result,
    canApply: true,
    canApplyOriginal: true,
    receipt: "not-committed",
  });
  try {
    expect(view.getByRole("status").textContent).toContain("Command review is limited to 20 phrases");
    expect(view.queryByRole("checkbox")).toBeNull();
    expect(view.queryByRole("button", { name: "Interpret selected commands" })).toBeNull();
    expect(view.getByRole("textbox", { name: "Recognized text" })).toHaveProperty("value", original);
    expect(view.actions.acceptFormatting).not.toHaveBeenCalled();
    expect(view.actions.confirmFormattingMarkers).not.toHaveBeenCalled();
  } finally {
    view.unmount();
  }
});

it("confirms only selected source commands and resets selection for a replacement preparation", () => {
  const original = "Opening paragraph new paragraph closing paragraph";
  const result = prepareDictationFormatting(original, "explicit");
  const view = mountReview({
    result,
    canApply: true,
    canApplyOriginal: true,
    receipt: "not-committed",
  });
  try {
    const status = view.getByRole("status");
    const interpret = () => view.getByRole("button", { name: "Interpret selected commands" });
    expect(interpret().hasAttribute("disabled")).toBe(true);
    expect(view.getByRole("region", { name: "Semantic preview" }).textContent).toBe(original);
    view.getByRole("checkbox").click();
    flush();
    expect(interpret().hasAttribute("disabled")).toBe(false);
    const replacement = prepareDictationFormatting(original, "explicit", { sourceRevision: 2 });
    view.update({
      result: replacement,
      canApply: true,
      canApplyOriginal: true,
      receipt: "not-committed",
    });
    expect(interpret().hasAttribute("disabled")).toBe(true);
    expect(view.getByRole("status")).toBe(status);
    view.getByRole("checkbox").click();
    flush();
    interpret().click();
    expect(view.actions.confirmFormattingMarkers).toHaveBeenCalledExactlyOnceWith(
      [{ start: 18, end: 31 }],
    );
    expect(view.actions.acceptFormatting).not.toHaveBeenCalled();
    const confirmed = prepareDictationFormatting(original, "explicit", {
      sourceRevision: 2,
      confirmedMarkers: [{ start: 18, end: 31 }],
    });
    view.update({
      result: confirmed,
      canApply: true,
      canApplyOriginal: true,
      receipt: "not-committed",
    });
    expect(view.queryByRole("checkbox")).toBeNull();
    expect(
      view.getByRole("region", { name: "Semantic preview" }).querySelectorAll("p"),
    ).toHaveLength(2);
    expect(view.getByRole("status")).toBe(status);
  } finally {
    view.unmount();
  }
});

it.each(["reprocess", "unmount"] as const)(
  "retires pending clipboard fallback and feedback after %s",
  async (retirement) => {
    const result = prepareDictationFormatting("bullet old", "explicit");
    const pending = createDeferred();
    vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn(() => pending.promise) } });
    const previous = Object.getOwnPropertyDescriptor(document, "execCommand");
    const execCommand = vi.fn(() => true);
    Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });
    const view = mountReview({
      result,
      canApply: true,
      canApplyOriginal: true,
      receipt: "not-committed",
    });
    try {
      const status = view.getByRole("status");
      view.getByRole("button", { name: "Copy plain text" }).click();
      if (retirement === "unmount") {
        view.unmount();
      } else {
        view.update({
          result: prepareDictationFormatting("bullet newer", "explicit"),
          canApply: true,
          canApplyOriginal: true,
          receipt: "not-committed",
        });
      }
      pending.reject(new Error("clipboard denied"));
      await pending.promise.catch(() => undefined);
      flush();
      expect(execCommand).not.toHaveBeenCalled();
      expect(status.textContent).not.toContain("Copy failed");
      expect(status.textContent).not.toContain("Plain text copied");
      if (retirement === "reprocess") {
        expect(view.getByRole("status")).toBe(status);
        expect(view.getByRole("region", { name: "Semantic preview" }).textContent).toContain(
          "newer",
        );
      }
    } finally {
      if (retirement !== "unmount") {
        view.unmount();
      }
      if (previous) {
        Object.defineProperty(document, "execCommand", previous);
      } else {
        Reflect.deleteProperty(document, "execCommand");
      }
    }
  },
);
