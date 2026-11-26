// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { patchSettings } from "../../app/settings.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import {
  placeReviewedDictation,
  type DictationFormattingTarget,
} from "./composer-dictation-formatting.ts";
import {
  controllerFixture,
  emit,
  installDictationSessionFixtures,
  recordRequests,
  request,
  sessionResult,
  startDirect,
  transcript,
  type ControllerOptions,
} from "./composer-dictation.test-support.ts";

installDictationSessionFixtures();

describe("reviewed dictation lifecycle", () => {
  beforeEach(() => patchSettings({ dictationFormatting: { version: 1, mode: "explicit" } }));
  afterEach(() => patchSettings({ dictationFormatting: undefined }));

  function reviewFixture(overrides: Omit<Partial<ControllerOptions>, "client"> = {}) {
    const target: DictationFormattingTarget = {
      identity: {},
      revision: 1,
      value: "",
      start: 0,
      end: 0,
      editable: true,
      focused: true,
      capabilities: {
        version: 1,
        revision: 1,
        formats: ["text/plain", "text/markdown"],
        markdownProfile: "commonmark-0.31.2-lists",
        safeMultiline: true,
      },
    };
    const fixture = controllerFixture({
      readFormattingTarget: () => ({
        ...target,
        capabilities: { ...target.capabilities, formats: [...target.capabilities.formats] },
      }),
      ...overrides,
    });
    fixture.onCommit.mockImplementation((text, _late, _preview, placement) => {
      target.value = placeReviewedDictation(text, placement).value;
      target.revision++;
      return true;
    });
    return { ...fixture, target };
  }

  async function prepareReview(
    fixture: ReturnType<typeof reviewFixture>,
    text = "Shopping list bullet milk next item eggs",
  ) {
    await startDirect(fixture.controller);
    transcript(text);
    const finished = fixture.controller.finishActive();
    emit({ type: "close", reason: "completed" });
    await finished;
  }

  it("prepares a final list once and writes only after explicit review", async () => {
    const fixture = reviewFixture();
    await startDirect(fixture.controller);
    emit({ type: "partial", text: "Shopping list bullet milk" });
    expect(fixture.controller.formattingReview).toBeUndefined();
    expect(fixture.onCommit).not.toHaveBeenCalled();
    transcript("Shopping list bullet milk next item eggs");
    const finishing = fixture.controller.finishActive();
    expect(fixture.controller.transcribing).toBe(true);
    emit({ type: "close", reason: "completed" });
    await finishing;
    expect(fixture.controller.formattingReview).toMatchObject({
      canApply: true,
      result: { status: "formatted", counts: { items: 2 } },
    });
    expect(fixture.onCommit).not.toHaveBeenCalled();
    expect(fixture.controller.acceptFormatting("formatted")).toBe(true);
    expect(fixture.target.value).toBe("Shopping list\n\n- milk\n- eggs");
    expect(fixture.controller.formattingReceipt).toBe("committed");
    expect(fixture.controller.acceptFormatting("original")).toBe(false);
    expect(fixture.onCommit).toHaveBeenCalledOnce();
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "talk.session.create",
      "talk.session.close",
    ]);
    expect(fixture.controller.formattingDiagnostics).toMatchObject({
      version: 1,
      isFinal: true,
      transcriptRevision: 1,
      providerPolicy: "local-deterministic",
      receipt: "committed",
    });
    expect(JSON.stringify(fixture.controller.formattingDiagnostics)).not.toContain("milk");
  });

  it.each(["new capture", "cancel", "scope replacement"])(
    "retires the stopped source when a phase listener causes %s",
    async (change) => {
      let created = 0;
      recordRequests(async () => sessionResult(`dictation-${++created}`));
      const fixture = reviewFixture();
      await startDirect(fixture.controller);
      transcript("Old source bullet milk");
      let reacted = false;
      let restarted = false;
      const unsubscribe = fixture.controller.subscribe(() => {
        const boundary =
          change === "cancel" ? fixture.controller.finalizing : !fixture.controller.active;
        if (reacted || !boundary || fixture.controller.transcribing) {
          return;
        }
        reacted = true;
        if (change === "new capture") {
          fixture.target.value = "newer draft";
          fixture.target.end = fixture.target.value.length;
          fixture.target.revision++;
          restarted = fixture.controller.startDirect();
        } else if (change === "cancel") {
          fixture.controller.cancel();
        } else {
          fixture.controller.update({ ...fixture.options, draftKey: "other" });
        }
      });
      const finished = fixture.controller.finishActive();
      unsubscribe();
      emit({ type: "close", reason: "completed" });
      expect(await finished).toBe(false);
      expect(reacted).toBe(true);
      expect(fixture.controller.formattingReview).toBeUndefined();
      expect(fixture.onCommit).not.toHaveBeenCalled();
      if (change === "new capture") {
        expect(restarted).toBe(true);
        await vi.dynamicImportSettled();
        await waitForFast(() => expect(created).toBe(2));
        transcript("New source bullet bread", "dictation-2");
        const nextFinished = fixture.controller.finishActive();
        emit({ transcriptionSessionId: "dictation-2", type: "close", reason: "completed" });
        await nextFinished;
        expect(fixture.controller.formattingReview).toMatchObject({
          canApply: true,
          result: { originalText: "New source bullet bread" },
        });
        expect(fixture.target.value).toBe("newer draft");
      }
    },
  );

  it.each(["user", "preserve", "scope", "dispose", "scope during cancel", "dispose during cancel"])(
    "restores Cancel focus only for the still-current explicit user request (%s)",
    async (change) => {
      if (change === "preserve") {
        patchSettings({ dictationFormatting: undefined });
      }
      const onFormattingDismiss = vi.fn();
      const fixture = reviewFixture({ onFormattingDismiss });
      await startDirect(fixture.controller);
      transcript("Pending source bullet milk");
      const finished = fixture.controller.finishActive();
      const retire = () => {
        if (change.startsWith("dispose")) {
          fixture.controller.dispose();
        } else {
          fixture.controller.update({ ...fixture.options, draftKey: "other" });
        }
      };
      let unsubscribe = () => {};
      if (change.endsWith("during cancel")) {
        unsubscribe = fixture.controller.subscribe(() => {
          unsubscribe();
          retire();
        });
      }
      if (change === "scope" || change === "dispose") {
        retire();
      } else {
        fixture.controller.cancel();
      }
      unsubscribe();
      emit({ type: "close", reason: "completed" });
      await finished;
      expect(onFormattingDismiss).toHaveBeenCalledTimes(change === "user" ? 1 : 0);
      expect(fixture.controller.formattingReview).toBeUndefined();
      expect(fixture.onCommit).not.toHaveBeenCalled();
    },
  );

  it.each(["scope", "dispose"])(
    "does not restore Dismiss focus after synchronous %s",
    async (change) => {
      const onFormattingDismiss = vi.fn();
      const fixture = reviewFixture({ onFormattingDismiss });
      await prepareReview(fixture);
      const unsubscribe = fixture.controller.subscribe(() => {
        unsubscribe();
        if (change === "dispose") {
          fixture.controller.dispose();
        } else {
          fixture.controller.update({ ...fixture.options, draftKey: "other" });
        }
      });
      fixture.controller.dismissFormatting();
      expect(onFormattingDismiss).not.toHaveBeenCalled();
      expect(fixture.onCommit).not.toHaveBeenCalled();
    },
  );

  it.each(["revision", "value", "selection", "identity", "capability", "focus", "read-only"])(
    "refuses an altered %s at the final insertion boundary",
    async (change) => {
      const fixture = reviewFixture();
      await prepareReview(fixture);
      const target = fixture.target;
      if (change === "revision") {
        target.revision++;
      }
      if (change === "value") {
        target.value = "newer draft";
      }
      if (change === "selection") {
        target.end = 1;
      }
      if (change === "identity") {
        target.identity = {};
      }
      if (change === "capability") {
        target.capabilities.revision++;
      }
      if (change === "focus") {
        target.focused = false;
      }
      if (change === "read-only") {
        target.editable = false;
      }
      expect(fixture.controller.acceptFormatting("formatted")).toBe(false);
      expect(fixture.controller.acceptFormatting("original")).toBe(false);
      expect(fixture.onCommit).not.toHaveBeenCalled();
      expect(fixture.controller.formattingReview?.result.originalText).toContain("milk");
    },
  );

  it("does not recapture a moved selection at Stop", async () => {
    const fixture = reviewFixture();
    fixture.target.value = "selected original";
    fixture.target.end = fixture.target.value.length;
    await startDirect(fixture.controller);
    fixture.target.start = fixture.target.end;
    transcript("Shopping list bullet milk next item eggs");
    const finished = fixture.controller.finishActive();
    emit({ type: "close", reason: "completed" });
    await finished;
    expect(fixture.controller.acceptFormatting("original")).toBe(false);
    expect(fixture.target.value).toBe("selected original");
    expect(fixture.onCommit).not.toHaveBeenCalled();
  });

  it.each(["window blur", "focus departure", "policy round-trip", "draft edit round-trip"])(
    "latches %s while finalization is pending",
    async (change) => {
      const fixture = reviewFixture();
      await startDirect(fixture.controller);
      transcript("Shopping list bullet milk next item eggs");
      const finished = fixture.controller.finishActive();
      if (change === "window blur") {
        window.dispatchEvent(new Event("blur"));
      }
      if (change === "focus departure") {
        fixture.target.focused = false;
        document.dispatchEvent(new Event("focusin"));
        fixture.target.focused = true;
      }
      if (change === "policy round-trip") {
        patchSettings({ dictationFormatting: undefined });
        patchSettings({ dictationFormatting: { version: 1, mode: "explicit" } });
      }
      if (change === "draft edit round-trip") {
        fixture.target.revision++;
        document.dispatchEvent(new Event("input"));
      }
      emit({ type: "close", reason: "completed" });
      await finished;
      expect(fixture.controller.formattingReview?.canApply).toBe(false);
      expect(fixture.controller.acceptFormatting("original")).toBe(false);
      expect(fixture.onCommit).not.toHaveBeenCalled();
    },
  );

  it.each(["cancel", "scope", "account", "connection"])(
    "retires the source after %s",
    async (change) => {
      const fixture = reviewFixture();
      await startDirect(fixture.controller);
      transcript("Shopping list bullet milk");
      const finished = fixture.controller.finishActive();
      if (change === "cancel") {
        fixture.controller.cancel();
      }
      if (change === "scope") {
        fixture.controller.update({ ...fixture.options, draftKey: "other" });
      }
      if (change === "account") {
        Object.defineProperty(fixture.options.client, "auth", { value: {} });
      }
      if (change === "connection") {
        Object.defineProperty(fixture.options.client, "connectionGeneration", { value: 2 });
      }
      emit({ type: "close", reason: "completed" });
      await finished;
      expect(fixture.controller.formattingReview).toBeUndefined();
      expect(fixture.onCommit).not.toHaveBeenCalled();
    },
  );

  it("keeps incomplete recovery incomplete after reprocessing and ignores a late final", async () => {
    const fixture = reviewFixture();
    await startDirect(fixture.controller);
    emit({ type: "partial", text: "Shopping list bullet unfinished" });
    const finished = fixture.controller.finishActive();
    await vi.advanceTimersByTimeAsync(2_500);
    await finished;
    expect(fixture.controller.formattingReview?.result).toMatchObject({
      status: "raw-fallback",
      reason: "deadline",
    });
    fixture.controller.reprocessFormatting();
    expect(fixture.controller.formattingReview?.result).toMatchObject({
      status: "raw-fallback",
      reason: "deadline",
      document: undefined,
    });
    transcript("Late replacement");
    emit({ type: "close", reason: "completed" });
    expect(fixture.controller.formattingReview?.result.originalText).toBe(
      "Shopping list bullet unfinished",
    );
    expect(fixture.onCommit).not.toHaveBeenCalled();
  });

  it("requires terminal success even when an earlier final transcript exists", async () => {
    const fixture = reviewFixture();
    await startDirect(fixture.controller);
    transcript("Shopping list bullet milk");
    const finished = fixture.controller.finishActive();
    await vi.advanceTimersByTimeAsync(2_500);
    await finished;
    expect(fixture.controller.formattingReview?.result.status).toBe("raw-fallback");
    expect(fixture.controller.formattingDiagnostics?.isFinal).toBe(false);
  });

  it("reprocesses confirmed exact paragraph markers without changing source identity or contacting a provider", async () => {
    const fixture = reviewFixture();
    await prepareReview(fixture, "Opening paragraph new paragraph closing paragraph");
    const initial = fixture.controller.formattingReview!.result;
    expect(initial.status).toBe("needs-review");
    const source = initial.document!.source;
    fixture.controller.confirmFormattingMarkers(
      initial.candidates.map((candidate) => candidate.source),
    );
    const accepted = fixture.controller.formattingReview!.result;
    expect(accepted.plainText).toBe("Opening paragraph\n\nclosing paragraph");
    expect(accepted.document?.source).toEqual(source);
    expect(fixture.onCommit).not.toHaveBeenCalled();
    expect(request.mock.calls.filter(([method]) => method === "talk.session.create")).toHaveLength(
      1,
    );
  });

  it.each(["throw", "missing receipt", "cancel inside write"])(
    "never retries after %s",
    async (effect) => {
      const fixture = reviewFixture();
      await prepareReview(fixture);
      fixture.onCommit.mockImplementation(() => {
        if (effect === "cancel inside write") {
          fixture.controller.cancel();
        }
        if (effect === "throw") {
          throw new Error("write outcome unknown");
        }
      });
      expect(fixture.controller.acceptFormatting("formatted")).toBe(false);
      expect(fixture.controller.formattingReceipt).toBe("outcome-unknown");
      fixture.controller.reprocessFormatting();
      expect(fixture.controller.acceptFormatting("original")).toBe(false);
      expect(fixture.onCommit).toHaveBeenCalledOnce();
    },
  );
});
