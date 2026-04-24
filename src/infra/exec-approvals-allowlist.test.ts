import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { joinShellLineContinuations } from "./exec-approvals-analysis.js";
import { makePathEnv, makeTempDir } from "./exec-approvals-test-helpers.js";
import { evaluateShellAllowlist } from "./exec-approvals.js";

function makeAllowlistedBinDir(binaries: string[]): { dir: string; paths: Record<string, string> } {
  const tmp = makeTempDir();
  const binDir = path.join(tmp, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const paths: Record<string, string> = {};
  for (const name of binaries) {
    const full = path.join(binDir, name);
    fs.writeFileSync(full, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(full, 0o755);
    paths[name] = full;
  }
  return { dir: binDir, paths };
}

describe("evaluateShellAllowlist: POSIX line continuations", () => {
  it("resolves a multi-line allowlisted curl identically to its single-line form", () => {
    if (process.platform === "win32") {
      return;
    }
    const { dir, paths } = makeAllowlistedBinDir(["curl"]);
    const multiLine =
      'curl -sS \\\n  -H "X-One: a" \\\n  -H "X-Two: b" \\\n  "http://example.invalid/path"';
    const singleLine = 'curl -sS -H "X-One: a" -H "X-Two: b" "http://example.invalid/path"';

    const multi = evaluateShellAllowlist({
      command: multiLine,
      allowlist: [{ pattern: paths.curl }],
      safeBins: new Set(),
      env: makePathEnv(dir),
      cwd: dir,
    });
    const single = evaluateShellAllowlist({
      command: singleLine,
      allowlist: [{ pattern: paths.curl }],
      safeBins: new Set(),
      env: makePathEnv(dir),
      cwd: dir,
    });

    expect(multi.analysisOk).toBe(true);
    expect(multi.allowlistSatisfied).toBe(true);
    expect(multi.segments[0]?.argv).toEqual(single.segments[0]?.argv);
  });

  it("accepts CRLF line continuations the same as LF", () => {
    if (process.platform === "win32") {
      return;
    }
    const { dir, paths } = makeAllowlistedBinDir(["curl"]);
    const crlf = 'curl -sS \\\r\n  "http://example.invalid/path"';
    const result = evaluateShellAllowlist({
      command: crlf,
      allowlist: [{ pattern: paths.curl }],
      safeBins: new Set(),
      env: makePathEnv(dir),
      cwd: dir,
    });
    expect(result.analysisOk).toBe(true);
    expect(result.allowlistSatisfied).toBe(true);
    expect(result.segments[0]?.argv).toEqual(["curl", "-sS", "http://example.invalid/path"]);
  });

  it("still misses the allowlist when the binary is not listed, without analysis failure", () => {
    if (process.platform === "win32") {
      return;
    }
    const { dir, paths } = makeAllowlistedBinDir(["curl", "wget"]);
    const result = evaluateShellAllowlist({
      command: 'wget \\\n  "http://example.invalid/"',
      allowlist: [{ pattern: paths.curl }],
      safeBins: new Set(),
      env: makePathEnv(dir),
      cwd: dir,
    });
    expect(result.analysisOk).toBe(true);
    expect(result.allowlistSatisfied).toBe(false);
  });
});

describe("joinShellLineContinuations", () => {
  it("splices unquoted `\\<LF>` pairs", () => {
    expect(joinShellLineContinuations("echo one \\\ntwo")).toBe("echo one two");
  });

  it("splices `\\<CRLF>` pairs", () => {
    expect(joinShellLineContinuations("echo one \\\r\ntwo")).toBe("echo one two");
  });

  it("preserves `\\<LF>` inside single quotes", () => {
    const input = "echo 'a\\\nb'";
    expect(joinShellLineContinuations(input)).toBe(input);
  });

  it("splices `\\<LF>` inside double quotes", () => {
    expect(joinShellLineContinuations('echo "one\\\ntwo"')).toBe('echo "onetwo"');
  });

  it("preserves `\\<LF>` inside a `#` comment to end of line", () => {
    const input = "echo hi # literal \\\nnext";
    expect(joinShellLineContinuations(input)).toBe(input);
  });

  it("preserves quoted-heredoc bodies verbatim", () => {
    const input = "cat <<'EOF'\nliteral \\\nstill literal\nEOF\n";
    expect(joinShellLineContinuations(input)).toBe(input);
  });

  it("splices inside unquoted heredoc bodies (matches bash)", () => {
    expect(joinShellLineContinuations("cat <<EOF\nhello \\\nworld\nEOF\n")).toBe(
      "cat <<EOF\nhello world\nEOF\n",
    );
  });

  it("recognizes a terminator whose letters are split by a continuation", () => {
    // bash: the logical line after splicing is `EOF`, so the heredoc terminates.
    expect(joinShellLineContinuations("cat <<EOF\nbody\nEO\\\nF\ntail\n")).toBe(
      "cat <<EOF\nbody\nEOF\ntail\n",
    );
  });

  it("does not terminate when a continuation joins text into the delimiter line", () => {
    // bash: the logical line is `foo EOF`, which is NOT the delimiter; keep
    // consuming the body until a standalone `EOF` arrives.
    expect(joinShellLineContinuations("cat <<EOF\nfoo \\\nEOF\nEOF\ntail\n")).toBe(
      "cat <<EOF\nfoo EOF\nEOF\ntail\n",
    );
  });

  it("returns the original command for unterminated quotes", () => {
    const input = "echo 'unterminated \\\n";
    expect(joinShellLineContinuations(input)).toBe(input);
  });

  it("is a no-op when the command has no continuation", () => {
    const input = 'curl -sS "http://example.invalid/"';
    expect(joinShellLineContinuations(input)).toBe(input);
  });
});
