import { afterEach, describe, expect, it, vi } from "vitest";
import { Parser } from "web-tree-sitter";
import { getBashParserForCommandExplanation } from "./tree-sitter-runtime.js";

afterEach(() => vi.restoreAllMocks());

describe("Bash parser preparation and limits", () => {
  it("shares initialization and retries after transient initialization failure", async () => {
    const init = vi.spyOn(Parser, "init").mockRejectedValueOnce(new Error("transient init"));
    const first = getBashParserForCommandExplanation();
    expect(getBashParserForCommandExplanation()).toBe(first);
    await expect(first).rejects.toThrow("transient init");
    const parse = await getBashParserForCommandExplanation();
    expect(init).toHaveBeenCalledTimes(2);
    const tree = parse("echo recovered");
    try {
      expect(tree.rootNode.hasError).toBe(false);
    } finally {
      tree.delete();
    }
  });

  it("resets a timed-out parser at the 500ms bound and can parse afterward", async () => {
    const parse = await getBashParserForCommandExplanation();
    const reset = vi.spyOn(Parser.prototype, "reset");
    vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValue(501);
    const nativeParse = vi
      .spyOn(Parser.prototype, "parse")
      .mockImplementationOnce((_source, _oldTree, options) => {
        expect(options?.progressCallback?.({ currentOffset: 0, hasError: false })).toBe(true);
        return null;
      });
    expect(() => parse("echo deadline")).toThrow("timed out after 500ms");
    expect(reset).toHaveBeenCalledTimes(1);
    nativeParse.mockRestore();
    vi.restoreAllMocks();
    const tree = parse("echo recovered");
    tree.delete();
  });

  it("resets an empty native parse result without misreporting a timeout", async () => {
    const parse = await getBashParserForCommandExplanation();
    const reset = vi.spyOn(Parser.prototype, "reset");
    vi.spyOn(Parser.prototype, "parse").mockReturnValueOnce(null);
    expect(() => parse("echo missing")).toThrow("returned no parse tree");
    expect(reset).toHaveBeenCalledTimes(1);
  });
});
