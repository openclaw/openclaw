import { afterEach, describe, expect, it, vi } from "vitest";
import { Parser, Tree } from "web-tree-sitter";
import { CommandExplanationWorkLimitError, explainShellCommand } from "./extract.js";
import { getBashParserForCommandExplanation } from "./tree-sitter-runtime.js";

const sources = [
  `bash -c 'sh -c "echo first && echo second | cat"'`,
  `sh -c 'bash -c "printf hello; pwd || echo failed"'`,
  `bash -c 'sh -c "echo hello > out & wait"'`,
  `sh -c 'bash -c "echo one && echo two"'`,
] as const;

function trackTrees(failSource?: string, failDeleteAt?: number) {
  const live = new Set<Tree>();
  const atYield: number[] = [];
  let peak = 0;
  let created = 0;
  let deleted = 0;
  // oxlint-disable typescript/unbound-method -- Native methods are invoked below with their original receivers.
  const parse = Parser.prototype.parse;
  const dispose = Tree.prototype.delete;
  // oxlint-enable typescript/unbound-method
  vi.spyOn(Parser.prototype, "parse").mockImplementation(function (this: Parser, ...args) {
    if (args[0] === failSource) {
      throw new Error("nested parse failure");
    }
    const tree = parse.apply(this, args);
    if (tree) {
      live.add(tree);
      created++;
      peak = Math.max(peak, live.size);
      queueMicrotask(() => atYield.push(live.size));
    }
    return tree;
  });
  vi.spyOn(Tree.prototype, "delete").mockImplementation(function (this: Tree) {
    expect(live.delete(this)).toBe(true);
    deleted++;
    dispose.call(this);
    if (deleted === failDeleteAt) {
      throw new Error("tree disposal failure");
    }
  });
  return { live, atYield, stats: () => ({ peak, created, deleted }) };
}

afterEach(() => vi.restoreAllMocks());

describe("native Bash tree lifetime", () => {
  it("bounds four concurrent nested explanations to three real live trees", async () => {
    const expected = [];
    for (const source of sources) {
      expected.push(await explainShellCommand(source));
    }
    const tracker = trackTrees();
    const actual = await Promise.all(sources.map((source) => explainShellCommand(source)));
    expect(actual).toEqual(expected);
    expect(tracker.stats()).toEqual({ peak: 3, created: 12, deleted: 12 });
    expect(tracker.live.size).toBe(0);
    expect(tracker.atYield.every((count) => count === 0)).toBe(true);
  });

  it("deletes root and nested trees when the shared node budget throws", async () => {
    await getBashParserForCommandExplanation();
    const tracker = trackTrees();
    const command = `bash -c '${"echo x;".repeat(13000)}'`;
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () => explainShellCommand(command)),
    );
    for (const result of results) {
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") {
        expect(result.reason).toBeInstanceOf(CommandExplanationWorkLimitError);
      }
    }
    expect(tracker.stats()).toEqual({ peak: 2, created: 8, deleted: 8 });
    expect(tracker.live.size).toBe(0);
    expect(tracker.atYield.every((count) => count === 0)).toBe(true);
  });

  it("deletes every ancestor if a nested parser throws", async () => {
    await getBashParserForCommandExplanation();
    const tracker = trackTrees("echo first && echo second | cat");
    await expect(explainShellCommand(sources[0])).rejects.toThrow("nested parse failure");
    expect(tracker.stats()).toEqual({ peak: 2, created: 2, deleted: 2 });
    expect(tracker.live.size).toBe(0);
    expect(tracker.atYield.every((count) => count === 0)).toBe(true);
  });
  it("still deletes outer trees when nested disposal throws", async () => {
    await getBashParserForCommandExplanation();
    const tracker = trackTrees(undefined, 1);
    await expect(explainShellCommand(sources[0])).rejects.toThrow("tree disposal failure");
    expect(tracker.stats()).toEqual({ peak: 3, created: 3, deleted: 3 });
    expect(tracker.live.size).toBe(0);
    expect(tracker.atYield.every((count) => count === 0)).toBe(true);
  });
});
