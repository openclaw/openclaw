// Channel config example tests validate channel configuration snippets in docs.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import JSON5 from "json5";
import { describe, expect, it } from "vitest";
import { OpenClawSchema } from "../config/zod-schema.js";
import { expectNoReaddirSyncDuring } from "../test-utils/fs-scan-assertions.js";
import { listGitTrackedFiles } from "../test-utils/repo-files.js";

const CHANNEL_DOCS_DIR = path.join(process.cwd(), "docs", "channels");

// Bound the `find` fallback used when `git ls-files` is unavailable. `find`
// over a directory with a stalled NFS/FUSE mount can hang indefinitely; this
// bound keeps the test suite moving and surfaces the timeout as a `find`
// non-zero exit (which the caller maps back to `null`).
//
// When `find` times out we do NOT fall back to `readdirSync(CHANNEL_DOCS_DIR)`
// — the same filesystem stall that hung `find` would also hang `readdirSync`.
// Instead the caller skips the channel docs tests with a clear reason.
const FIND_CHANNEL_DOCS_TIMEOUT_MS = 5_000;

class ChannelDocsFilesystemTimeoutError extends Error {
  constructor(public readonly cause: "find" | "readdirSync") {
    super(`timed out enumerating ${CHANNEL_DOCS_DIR} via ${cause}; filesystem may be stalled`);
    this.name = "ChannelDocsFilesystemTimeoutError";
  }
}

function lineNumberAt(source: string, index: number): number {
  return source.slice(0, index).split("\n").length;
}

function listChannelDocFiles(): string[] {
  const external = listExternalChannelDocFiles();
  if (external.kind === "files") {
    return external.files;
  }
  // `find` was unavailable OR timed out. If it timed out, the underlying
  // filesystem is stalled and `readdirSync` would hang the same way; throw
  // so the test surfaces the timeout instead of locking the suite.
  if (external.kind === "timeout") {
    throw new ChannelDocsFilesystemTimeoutError(external.cause);
  }
  return fs
    .readdirSync(CHANNEL_DOCS_DIR)
    .filter((entry) => entry.endsWith(".md"))
    .map((fileName) => path.join(CHANNEL_DOCS_DIR, fileName))
    .toSorted();
}

type ExternalChannelDocFiles =
  | { kind: "files"; files: string[] }
  | { kind: "unavailable" }
  | { kind: "timeout"; cause: "find" | "readdirSync" };

function listExternalChannelDocFiles(): ExternalChannelDocFiles {
  const gitResult = listGitChannelDocFiles();
  if (gitResult !== null) {
    return { kind: "files", files: gitResult };
  }
  return listFindChannelDocFiles();
}

function listGitChannelDocFiles(): string[] | null {
  const files = listGitTrackedFiles({ pathspecs: "docs/channels/*.md" });
  if (!files) {
    return null;
  }
  return files.map((filePath) => path.join(process.cwd(), filePath)).toSorted();
}

function listFindChannelDocFiles(): ExternalChannelDocFiles {
  const result = spawnSync(
    "find",
    [CHANNEL_DOCS_DIR, "-maxdepth", "1", "-type", "f", "-name", "*.md"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: FIND_CHANNEL_DOCS_TIMEOUT_MS,
      killSignal: "SIGKILL",
    },
  );
  // Distinguish timeout (status === null && signal === "SIGKILL") from a
  // normal non-zero exit. A timeout means the filesystem is likely stalled
  // and the caller must NOT fall back to `readdirSync` on the same dir.
  if (result.status === null && result.signal === "SIGKILL") {
    return { kind: "timeout", cause: "find" };
  }
  if (result.status !== 0) {
    return { kind: "unavailable" };
  }
  return {
    kind: "files",
    files: result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .toSorted(),
  };
}

describe("channel docs config examples", () => {
  it("lists channel docs without scanning the docs directory in-process", () => {
    expectNoReaddirSyncDuring(() => {
      const files = listChannelDocFiles();

      expect(files.length).toBeGreaterThan(0);
      expect(files.every((filePath) => filePath.endsWith(".md"))).toBe(true);
    });
  });

  it("keeps channel docs JSON fences parseable", () => {
    const failures: string[] = [];
    for (const docPath of listChannelDocFiles()) {
      const fileName = path.basename(docPath);
      const markdown = fs.readFileSync(docPath, "utf8");
      const blocks = markdown.matchAll(/```(?:json5|json)\n([\s\S]*?)```/g);
      for (const match of blocks) {
        const code = match[1] ?? "";
        const location = `${fileName}:${lineNumberAt(markdown, match.index ?? 0)}`;
        const isStrictJson = match[0].startsWith("```json\n");
        try {
          if (isStrictJson) {
            JSON.parse(code);
          } else {
            JSON5.parse(code);
          }
        } catch (error) {
          failures.push(
            `${location} ${isStrictJson ? "JSON" : "JSON5"} parse failed: ${String(error)}`,
          );
        }
      }
    }
    expect(failures).toStrictEqual([]);
  });

  it("keeps OpenClaw channel config snippets parseable and schema-valid", () => {
    const failures: string[] = [];
    for (const docPath of listChannelDocFiles()) {
      const fileName = path.basename(docPath);
      const markdown = fs.readFileSync(docPath, "utf8");
      const blocks = markdown.matchAll(/```(?:json5|json)\n([\s\S]*?)```/g);
      for (const match of blocks) {
        const code = match[1] ?? "";
        if (!/(^|\n)\s*(?:"channels"|channels)\s*:/.test(code)) {
          continue;
        }
        const location = `${fileName}:${lineNumberAt(markdown, match.index ?? 0)}`;
        let parsed: unknown;
        try {
          parsed = JSON5.parse(code);
        } catch (error) {
          failures.push(`${location} JSON5 parse failed: ${String(error)}`);
          continue;
        }
        const result = OpenClawSchema.safeParse(parsed);
        if (!result.success) {
          const issues = result.error.issues
            .slice(0, 3)
            .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
            .join("; ");
          failures.push(`${location} schema failed: ${issues}`);
        }
      }
    }
    expect(failures).toStrictEqual([]);
  });
});

describe("channel docs find timeout detection", () => {
  // Regression guard for the ClawSweeper review on PR #111176: a `find`
  // timeout must NOT silently fall back to `readdirSync(CHANNEL_DOCS_DIR)`
  // because the same filesystem stall that hung `find` would also hang
  // `readdirSync`. The discriminated union returned by the helpers encodes
  // this: a SIGKILL'd find (status === null && signal === "SIGKILL")
  // surfaces as `{ kind: "timeout", cause: "find" }`, which
  // `listChannelDocFiles` converts into a thrown
  // `ChannelDocsFilesystemTimeoutError` instead of falling through to
  // `readdirSync`. A normal non-zero exit is treated as "find unavailable"
  // and the `readdirSync` fallback is allowed.
  //
  // We assert the contract structurally rather than simulating a real
  // timeout, because forcing a real SIGKILL timeout in a unit test would
  // introduce a 5s wall-clock penalty per run and would race with the git
  // ls-files cache.
  it("distinguishes find SIGKILL timeout from a normal non-zero exit", () => {
    const src = listFindChannelDocFiles.toString();
    // The find call site must use killSignal: SIGKILL and a finite timeout.
    expect(src).toMatch(/killSignal:\s*\\?"SIGKILL\\?"/);
    expect(src).toMatch(/timeout:\s*FIND_CHANNEL_DOCS_TIMEOUT_MS/);
    // status === null && signal === "SIGKILL" must produce kind: "timeout".
    expect(src).toMatch(/status\s*===\s*null\s*&&\s*result\.signal\s*===\s*\\?"SIGKILL\\?"/);
    expect(src).toMatch(/kind:\s*\\?"timeout\\?"/);
    // The non-timeout non-zero branch must produce kind: "unavailable" so
    // that the caller is allowed to fall back to readdirSync.
    expect(src).toMatch(/kind:\s*\\?"unavailable\\?"/);
  });

  it("throws ChannelDocsFilesystemTimeoutError when find times out", () => {
    // `listChannelDocFiles` must throw on kind === "timeout" rather than
    // falling through to readdirSync. This is the core regression guard
    // for the bug where a stalled filesystem would re-hang in readdirSync
    // after find already timed out.
    const src = listChannelDocFiles.toString();
    expect(src).toMatch(
      /kind\s*===\s*\\?"timeout\\?"[\s\S]*?throw\s+new\s+ChannelDocsFilesystemTimeoutError/,
    );
    // And the readdirSync fallback must only run for kind === "unavailable".
    expect(src).toMatch(/readdirSync\(CHANNEL_DOCS_DIR\)/);
  });
});
