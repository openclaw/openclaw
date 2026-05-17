import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { logWarn } from "../../logger.js";
import { normalizeToolParams } from "../pi-tools.params.js";
import { sanitizeFileToolParams, sanitizeToolArg } from "./sanitize-tool-args.js";

vi.mock("../../logger.js", () => ({
  logWarn: vi.fn(),
  logInfo: vi.fn(),
}));

const here = path.dirname(fileURLToPath(import.meta.url));
const agentsDir = path.resolve(here, "..");

describe("sanitizeToolArg / sanitizeFileToolParams", () => {
  afterEach(() => {
    vi.mocked(logWarn).mockClear();
  });

  // 1) read.file_path 에 sentinel → sanitize
  it("sanitizes a sentinel-leaked read file_path", () => {
    const out = sanitizeFileToolParams({ path: '<<|"|/tmp/notes.md' }, "read");
    expect(out.path).toBe("/tmp/notes.md");
  });

  // 2) write.file_path 에 sentinel → sanitize (and content is left untouched)
  it("sanitizes write path but never mutates content", () => {
    const out = sanitizeFileToolParams(
      { path: '<<|"|out.txt', content: "literal <<| and <|x|> stay" },
      "write",
    );
    expect(out.path).toBe("out.txt");
    expect(out.content).toBe("literal <<| and <|x|> stay");
  });

  // 3) raw file_path key (pre-normalization) is also covered
  it("sanitizes the file_path key directly", () => {
    const out = sanitizeFileToolParams({ file_path: '<|<|"docs/readme.md' }, "edit");
    expect(out.file_path).toBe("docs/readme.md");
  });

  // 4) clean args → no-op (returns same reference)
  it("is a no-op for clean params", () => {
    const input = { path: "memory/people/이서현.md", content: "hello" };
    const out = sanitizeFileToolParams(input, "read");
    expect(out).toBe(input);
  });

  // 5) 비-string args → no-op
  it("leaves non-string path values unchanged", () => {
    const input = { path: 123 as unknown as string };
    expect(sanitizeToolArg(input.path, "read", "path")).toBe(input.path);
    const out = sanitizeFileToolParams(input, "read");
    expect(out).toBe(input);
  });

  // 6) 이벤트 emit 검증
  it("emits a tool.sanitize_special_tokens warning when it strips a token", () => {
    sanitizeToolArg('<<|"|/tmp/x', "read", "path");
    expect(logWarn).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logWarn).mock.calls[0]?.[0]).toMatch(
      /^tool\.sanitize_special_tokens tool=read arg=path original_len=\d+ sanitized_len=\d+$/,
    );
  });

  it("does not emit a warning for clean input", () => {
    sanitizeToolArg("/tmp/clean.md", "read", "path");
    expect(logWarn).not.toHaveBeenCalled();
  });

  // 7) normalizeToolParams chokepoint pipes the sanitized path through
  //    (this is the single entry point read/write/edit all call).
  it("normalizeToolParams renames file_path then strips the sentinel", () => {
    const normalized = normalizeToolParams({ file_path: '<<|"|/tmp/report.md' });
    expect(normalized).toEqual({ path: "/tmp/report.md" });
  });

  // 8) entry-point check: the file tools route through normalizeToolParams,
  //    and normalizeToolParams routes through sanitizeFileToolParams.
  it("all core file tools route through the sanitize chokepoint", () => {
    const paramsSrc = readFileSync(path.join(agentsDir, "pi-tools.params.ts"), "utf-8");
    expect(paramsSrc).toContain('from "./tools/sanitize-tool-args.js"');
    expect(paramsSrc).toContain("return sanitizeFileToolParams(normalized);");

    const readSrc = readFileSync(path.join(agentsDir, "pi-tools.read.ts"), "utf-8");
    // read tool entry point
    expect(readSrc).toMatch(/createOpenClawReadTool[\s\S]*normalizeToolParams\(params\)/);
    // write/edit entry point
    expect(paramsSrc).toMatch(/wrapToolParamNormalization[\s\S]*normalizeToolParams\(params\)/);
  });
});
