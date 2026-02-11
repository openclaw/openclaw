import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  elideQueueText,
  buildQueueSummaryLine,
  shouldSkipQueueItem,
  applyQueueDropPolicy,
  waitForQueueDebounce,
  buildQueueSummaryPrompt,
  buildCollectPrompt,
  hasCrossChannelItems,
  QueueState,
  QueueSummaryState,
} from "./queue-helpers";

describe("queue-helpers", () => {
  describe("elideQueueText", () => {
    it("returns original text if shorter than limit", () => {
      expect(elideQueueText("short text", 20)).toBe("short text");
    });

    it("returns original text if equal to limit", () => {
      expect(elideQueueText("exact", 5)).toBe("exact");
    });

    it("truncates text and adds ellipsis if longer than limit", () => {
      expect(elideQueueText("hello world", 8)).toBe("hello w…");
    });

    it("trims whitespace before ellipsis", () => {
      expect(elideQueueText("hello   world", 8)).toBe("hello…");
    });

    it("uses default limit of 140", () => {
      const longText = "a".repeat(141);
      const expected = "a".repeat(139) + "…";
      expect(elideQueueText(longText)).toBe(expected);
    });
  });

  describe("buildQueueSummaryLine", () => {
    it("replaces newlines with spaces and trims", () => {
      const input = "  line1\nline2  \n\n line3 ";
      expect(buildQueueSummaryLine(input)).toBe("line1 line2 line3");
    });

    it("elides text if too long", () => {
      const input = "hello world";
      expect(buildQueueSummaryLine(input, 8)).toBe("hello w…");
    });
  });

  describe("shouldSkipQueueItem", () => {
    it("returns false if no dedupe function provided", () => {
      expect(shouldSkipQueueItem({ item: 1, items: [] })).toBe(false);
    });

    it("returns result of dedupe function", () => {
      const dedupe = vi.fn().mockReturnValue(true);
      const params = { item: 1, items: [1], dedupe };
      expect(shouldSkipQueueItem(params)).toBe(true);
      expect(dedupe).toHaveBeenCalledWith(1, [1]);
    });
  });

  describe("applyQueueDropPolicy", () => {
    let queue: QueueState<number>;
    const summarize = (n: number) => `Item ${n}`;

    beforeEach(() => {
      queue = {
        dropPolicy: "old",
        droppedCount: 0,
        summaryLines: [],
        items: [1, 2, 3],
        cap: 2,
      };
    });

    it("returns true and does nothing if under cap", () => {
      queue.cap = 5;
      const result = applyQueueDropPolicy({ queue, summarize });
      expect(result).toBe(true);
      expect(queue.items).toEqual([1, 2, 3]);
    });

    it("returns false if policy is 'new' and over cap", () => {
      queue.dropPolicy = "new";
      const result = applyQueueDropPolicy({ queue, summarize });
      expect(result).toBe(false);
      expect(queue.items).toEqual([1, 2, 3]);
    });

    it("drops old items if policy is 'old'", () => {
      queue.dropPolicy = "old";
      const result = applyQueueDropPolicy({ queue, summarize });
      expect(result).toBe(true);
      expect(queue.items).toEqual([3]);
    });

    it("summarizes dropped items if policy is 'summarize'", () => {
      queue.dropPolicy = "summarize";
      const result = applyQueueDropPolicy({ queue, summarize });
      expect(result).toBe(true);
      expect(queue.items).toEqual([3]);
      expect(queue.droppedCount).toBe(2);
      expect(queue.summaryLines).toEqual(["Item 1", "Item 2"]);
    });

    it("respects summaryLimit", () => {
        queue.dropPolicy = "summarize";
        queue.items = [1, 2, 3, 4];
        queue.cap = 1;
        const result = applyQueueDropPolicy({ queue, summarize, summaryLimit: 2 });
        expect(result).toBe(true);
        expect(queue.summaryLines).toHaveLength(2);
        expect(queue.summaryLines).toEqual(["Item 3", "Item 4"]);
    });
  });

  describe("waitForQueueDebounce", () => {
    it("resolves immediately if debounceMs <= 0", async () => {
      const p = waitForQueueDebounce({ debounceMs: 0, lastEnqueuedAt: Date.now() });
      await expect(p).resolves.toBeUndefined();
    });

    it("waits if time has not passed", async () => {
      const debounceMs = 50;
      const lastEnqueuedAt = Date.now();
      const p = waitForQueueDebounce({ debounceMs, lastEnqueuedAt });

      let resolved = false;
      p.then(() => { resolved = true; });

      // Check immediately (allow microtasks to process)
      await new Promise(r => setTimeout(r, 10));
      expect(resolved).toBe(false);

      // Check after debounce
      await new Promise(r => setTimeout(r, 60));
      expect(resolved).toBe(true);
    });
  });

  describe("buildQueueSummaryPrompt", () => {
    it("returns undefined if policy is not summarize", () => {
        const state: QueueSummaryState = { dropPolicy: "old", droppedCount: 1, summaryLines: ["line"] };
        expect(buildQueueSummaryPrompt({ state, noun: "item" })).toBeUndefined();
    });

    it("returns undefined if droppedCount <= 0", () => {
        const state: QueueSummaryState = { dropPolicy: "summarize", droppedCount: 0, summaryLines: ["line"] };
        expect(buildQueueSummaryPrompt({ state, noun: "item" })).toBeUndefined();
    });

    it("builds summary prompt and resets state", () => {
        const state: QueueSummaryState = {
            dropPolicy: "summarize",
            droppedCount: 2,
            summaryLines: ["Line 1", "Line 2"]
        };
        const prompt = buildQueueSummaryPrompt({ state, noun: "item" });
        expect(prompt).toContain("[Queue overflow] Dropped 2 items due to cap.");
        expect(prompt).toContain("Summary:");
        expect(prompt).toContain("- Line 1");
        expect(prompt).toContain("- Line 2");

        // Verify reset
        expect(state.droppedCount).toBe(0);
        expect(state.summaryLines).toEqual([]);
    });
  });

  describe("buildCollectPrompt", () => {
    it("builds prompt with title and items", () => {
        const items = ["a", "b"];
        const renderItem = (item: string) => `Item: ${item}`;
        const result = buildCollectPrompt({ title: "Title", items, renderItem });

        expect(result).toContain("Title");
        expect(result).toContain("Item: a");
        expect(result).toContain("Item: b");
    });
  });

  describe("hasCrossChannelItems", () => {
      it("returns false for single key items", () => {
          const items = [{ k: "a" }, { k: "a" }];
          const resolve = (i: any) => ({ key: i.k });
          expect(hasCrossChannelItems(items, resolve)).toBe(false);
      });

      it("returns true for multiple keys", () => {
          const items = [{ k: "a" }, { k: "b" }];
          const resolve = (i: any) => ({ key: i.k });
          expect(hasCrossChannelItems(items, resolve)).toBe(true);
      });

      it("returns true if cross flag is set", () => {
          const items = [{ k: "a" }];
          const resolve = (i: any) => ({ key: i.k, cross: true });
          expect(hasCrossChannelItems(items, resolve)).toBe(true);
      });
  });
});
