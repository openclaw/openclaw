import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { logWarn } from "../../logger.js";
import { normalizeToolParams } from "../pi-tools.params.js";
import type { AnyAgentTool } from "../pi-tools.types.js";
import {
  sanitizeFileToolParams,
  sanitizeSearchToolParams,
  sanitizeToolArg,
  wrapSearchToolArgSanitization,
} from "./sanitize-tool-args.js";

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

  // 1b) jsonl 격리본 실측 read path 값 (cc1646c8…hallucinated, 2026-05-19).
  //     path 전체가 sentinel-only → "" 로 비워져 assertRequiredParams 가
  //     명시적 retry 를 유도 (ENOENT 후 모델 환각보다 안전).
  it("empties a sentinel-only read path (observed jsonl <|<|)", () => {
    const out = sanitizeFileToolParams({ path: "<|<|" }, "read");
    expect(out.path).toBe("");
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

describe("sanitizeSearchToolParams / wrapSearchToolArgSanitization (find/grep/ls)", () => {
  afterEach(() => {
    vi.mocked(logWarn).mockClear();
  });

  // 1) path / pattern / glob 모두 sentinel strip
  it("sanitizes path, pattern and glob on a search params record", () => {
    const out = sanitizeSearchToolParams(
      { pattern: '<|<|"황선아', path: '<<|"|claude-ref/', glob: '<|"|*.md' },
      "grep",
    );
    expect(out.pattern).toBe("황선아");
    expect(out.path).toBe("claude-ref/");
    expect(out.glob).toBe("*.md");
  });

  // 2) clean args → no-op (same reference, content-style keys untouched)
  it("is a no-op for clean search params", () => {
    const input = { pattern: "황선아", path: "memory/", glob: "*.md" };
    expect(sanitizeSearchToolParams(input, "find")).toBe(input);
  });

  // 3) 비-string args → no-op
  it("leaves non-string search args unchanged", () => {
    const input = { pattern: 42 as unknown as string };
    expect(sanitizeSearchToolParams(input, "find")).toBe(input);
  });

  // 4) wrap helper strips leaked tokens before the tool runs
  it("wrapSearchToolArgSanitization strips leaked tokens before execute", async () => {
    let received: Record<string, unknown> | undefined;
    const tool = {
      name: "grep",
      description: "",
      parameters: {},
      execute: async (_id: string, params: Record<string, unknown>) => {
        received = params;
        return { content: [] };
      },
    } as unknown as AnyAgentTool;
    const wrapped = wrapSearchToolArgSanitization(tool);
    await wrapped.execute(
      "call-1",
      { pattern: '<|<|"황선아', path: "claude-ref/" },
      undefined,
      undefined,
    );
    expect(received).toEqual({ pattern: "황선아", path: "claude-ref/" });
  });

  // 5) non-object params pass through untouched
  it("wrapSearchToolArgSanitization passes non-object params untouched", async () => {
    let received: unknown = "unset";
    const tool = {
      name: "ls",
      description: "",
      parameters: {},
      execute: async (_id: string, params: unknown) => {
        received = params;
        return { content: [] };
      },
    } as unknown as AnyAgentTool;
    const wrapped = wrapSearchToolArgSanitization(tool);
    await wrapped.execute("call-2", undefined, undefined, undefined);
    expect(received).toBe(undefined);
  });

  // 6) entry-point check: find/grep/ls route through the search sanitize wrapper
  it("find/grep/ls route through wrapSearchToolArgSanitization", () => {
    const piToolsSrc = readFileSync(path.join(agentsDir, "pi-tools.ts"), "utf-8");
    expect(piToolsSrc).toContain('from "./tools/sanitize-tool-args.js"');
    expect(piToolsSrc).toMatch(
      /tool\.name === "find" \|\| tool\.name === "grep" \|\| tool\.name === "ls"/,
    );
    expect(piToolsSrc).toContain("wrapSearchToolArgSanitization(tool)");
  });
});
