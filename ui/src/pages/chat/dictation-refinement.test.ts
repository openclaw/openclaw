import { afterEach, describe, expect, it, vi } from "vitest";
import type { DictationCleanupPolicy } from "../../app/settings-contract.ts";
import type { DictationCleanupSource } from "./dictation-cleanup.ts";
import { DictationRefinement } from "./dictation-refinement.ts";

const policy: DictationCleanupPolicy = { version: 1, mode: "conservative", locale: "en" };
const source: DictationCleanupSource = {
  id: "capture-1",
  revision: 1,
  text: "um please call me tomorrow",
  isFinal: true,
};

function fixture() {
  let value = "Existing draft";
  let revision = 0;
  let authorized = true;
  const writes: string[] = [];
  const binding = {
    isCurrent: () => authorized,
    readDraft: () => ({ revision, value }),
    publish: (text: string) => {
      value = `${value} ${text}`;
      revision += 1;
      writes.push(value);
    },
  };
  const changed = vi.fn();
  const owner = new DictationRefinement(changed);
  const prepare = (next = source) => owner.prepare(next, policy, binding, binding.readDraft());
  return {
    owner,
    changed,
    prepare,
    binding,
    writes,
    edit: (text: string) => {
      value = text;
      revision += 1;
    },
    revoke: () => {
      authorized = false;
    },
  };
}

afterEach(() => vi.restoreAllMocks());

describe("owned dictation refinement", () => {
  it("keeps the original recoverable once when semantic cleanup is unavailable", async () => {
    const h = fixture();
    h.prepare();
    expect(h.writes).toEqual([]);
    await Promise.resolve();
    expect(h.owner.review).toMatchObject({
      rawText: source.text,
      status: "ready",
      reason: "semantic-unavailable",
      canUseRaw: true,
      canRetry: false,
    });
    h.owner.retry(policy);
    expect(h.owner.review?.status).toBe("ready");
    expect(h.writes).toEqual([]);
    expect(h.owner.chooseRaw()).toBe(true);
    expect(h.owner.chooseRaw()).toBe(false);
    expect(h.writes).toEqual([`Existing draft ${source.text}`]);
    expect(h.owner.review).toBeNull();
  });

  it("raw choice before the deferred candidate retires all later publication", async () => {
    const h = fixture();
    h.prepare();
    expect(h.owner.chooseRaw()).toBe(true);
    await Promise.resolve();
    expect(h.owner.chooseRaw()).toBe(false);
    expect(h.writes).toEqual([`Existing draft ${source.text}`]);
    expect(h.owner.review).toBeNull();
  });

  it.each(["before result", "after result"])(
    "does not overwrite an edit-and-undo %s",
    async (when) => {
      const h = fixture();
      h.prepare();
      if (when !== "before result") {
        await Promise.resolve();
      }
      const previous = h.binding.readDraft().value;
      h.edit("User changed this");
      h.edit(previous);
      await Promise.resolve();
      const writes = h.writes.length;
      expect(h.owner.chooseRaw()).toBe(false);
      expect(h.writes).toHaveLength(writes);
      expect(h.owner.review?.rawText).toBe(source.text);
    },
  );

  it("explicit retry adopts the current draft and still requires a choice", async () => {
    const h = fixture();
    h.prepare();
    h.edit("My replacement");
    await Promise.resolve();
    expect(h.owner.review?.canRetry).toBe(true);
    h.owner.retry(policy);
    await Promise.resolve();
    expect(h.writes).toEqual([]);
    expect(h.owner.review).toMatchObject({ reason: "semantic-unavailable", canRetry: false });
    expect(h.owner.chooseRaw()).toBe(true);
    expect(h.writes).toEqual([`My replacement ${source.text}`]);
  });

  it("cancel retains eligible raw text but cannot publish a late candidate", async () => {
    const h = fixture();
    h.prepare();
    h.owner.cancel();
    await Promise.resolve();
    expect(h.owner.blocksCapture).toBe(false);
    expect(h.writes).toEqual([]);
    expect(h.owner.chooseRaw()).toBe(true);
    expect(h.writes).toEqual([`Existing draft ${source.text}`]);
  });

  it.each(["before result", "after result"])(
    "hides revoked source and rejects insertion %s",
    async (when) => {
      const h = fixture();
      h.prepare();
      if (when !== "before result") {
        await Promise.resolve();
      }
      h.revoke();
      const writes = h.writes.length;
      expect(h.owner.review).toMatchObject({
        status: "unavailable",
        rawText: "",
        reason: undefined,
        canUseRaw: false,
        canRetry: false,
      });
      await Promise.resolve();
      expect(h.owner.chooseRaw()).toBe(false);
      expect(h.writes).toHaveLength(writes);
    },
  );

  it("keeps deliberate repetition in only the latest recoverable source revision", async () => {
    const h = fixture();
    h.prepare();
    h.prepare({ ...source, revision: 2, text: "I I need the invoice" });
    await Promise.resolve();
    expect(h.owner.review).toMatchObject({
      rawText: "I I need the invoice",
      reason: "semantic-unavailable",
    });
    expect(h.owner.chooseRaw()).toBe(true);
    expect(h.writes).toEqual(["Existing draft I I need the invoice"]);
  });

  it("keeps provisional and timed-out results available only as original text", async () => {
    const h = fixture();
    h.prepare({ ...source, isFinal: false });
    await Promise.resolve();
    expect(h.owner.review).toMatchObject({
      status: "failed",
      canUseRaw: true,
      canRetry: false,
    });
    vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValueOnce(2_501);
    h.prepare();
    await Promise.resolve();
    expect(h.owner.review).toMatchObject({
      status: "failed",
      canUseRaw: true,
      canRetry: true,
    });
    expect(h.writes).toEqual([]);
  });

  it("dismissal releases text and retires a scheduled result", async () => {
    const h = fixture();
    h.prepare();
    h.owner.dismiss();
    await Promise.resolve();
    expect(h.owner.review).toBeNull();
    expect(h.owner.blocksCapture).toBe(false);
    expect(h.writes).toEqual([]);
  });

  it("does not retain an oversized source in transient review", async () => {
    const h = fixture();
    h.prepare({ ...source, text: "x".repeat(32 * 1024 + 1) });
    await Promise.resolve();
    expect(h.owner.review).toMatchObject({
      status: "unavailable",
      rawText: "",
      canUseRaw: false,
      canRetry: false,
    });
    expect(h.owner.chooseRaw()).toBe(false);
    expect(h.writes).toEqual([]);
    h.owner.cancel();
    h.edit("User replacement");
    expect(h.owner.review).toMatchObject({
      status: "unavailable",
      canUseRaw: false,
      canRetry: false,
    });
    expect(h.owner.chooseRaw()).toBe(false);
    expect(h.writes).toEqual([]);
  });

  it.each(["refused", "uncertain"])(
    "never reports a %s original-text write as published",
    async (outcome) => {
      const h = fixture();
      const publish = vi.fn(() => {
        if (outcome === "uncertain") {
          throw new Error("owner failed");
        }
        return false as const;
      });
      h.owner.prepare(source, policy, { ...h.binding, publish }, h.binding.readDraft());
      await Promise.resolve();
      expect(publish).not.toHaveBeenCalled();
      expect(h.owner.chooseRaw()).toBe(false);
      expect(h.owner.review).toMatchObject({ status: "failed" });
      expect(publish).toHaveBeenCalledTimes(1);
      if (outcome === "uncertain") {
        expect(h.owner.chooseRaw()).toBe(false);
        expect(h.owner.review?.canRetry).toBe(false);
        expect(h.owner.review?.publicationUncertain).toBe(true);
      } else {
        expect(h.owner.review).toMatchObject({
          canUseRaw: true,
          canRetry: true,
          publicationUncertain: false,
        });
      }
    },
  );
});
