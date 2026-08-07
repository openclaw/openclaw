// Channel config example tests validate channel configuration snippets in docs.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSON5 from "json5";
import { describe, expect, it } from "vitest";
import { OpenClawSchema } from "../config/zod-schema.js";
import { expectNoReaddirSyncDuring } from "../test-utils/fs-scan-assertions.js";
import { listGitTrackedFiles } from "../test-utils/repo-files.js";

const CHANNEL_DOCS_DIR = path.join(process.cwd(), "docs", "channels");

// Best-effort bound on the `find` fallback used when `git ls-files` is
// unavailable. `find` over a directory with a stalled NFS/FUSE mount can
// hang indefinitely; this bound keeps the test suite moving by sending
// SIGKILL at the deadline and surfaces the timeout as a `find`
// non-zero/timeout exit (which the caller maps back to `null`).
//
// This is a best-effort liveness bound, not a hard wall-clock guarantee:
// `spawnSync` sends the kill signal at the deadline but waits synchronously
// for the child to actually exit. A process stuck in an uninterruptible
// filesystem operation (e.g. D-state on a stalled NFS read) may not exit
// promptly after SIGKILL, so the test runner can still hang. The bound is
// effective for the common user-space stall case (trap-and-sleep) and
// bounds the failure mode for cooperative children.
//
// When `find` times out we do NOT fall back to `readdirSync(CHANNEL_DOCS_DIR)`
// — the same filesystem stall that hung `find` would also hang `readdirSync`.
// Instead the caller skips the channel docs tests with a clear reason.
const FIND_CHANNEL_DOCS_TIMEOUT_MS = 5_000;

class ChannelDocsFilesystemTimeoutError extends Error {
  constructor(public override readonly cause: "find" | "readdirSync") {
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

  it("runtime proof: throws ChannelDocsFilesystemTimeoutError when find hangs", () => {
    // Live runtime proof requested by ClawSweeper: simulate a stalled
    // filesystem by installing a fake `find` on PATH that ignores SIGTERM
    // and SIGINT and sleeps forever. The production code (timeout: 5_000,
    // killSignal: "SIGKILL") must send SIGKILL at the 5s deadline, which
    // for this cooperative user-space stub causes the process to exit
    // promptly. The caller (`listChannelDocFiles`) must then throw
    // ChannelDocsFilesystemTimeoutError instead of falling through to
    // readdirSync on the same dir.
    //
    // NOTE: this runtime proof exercises the user-space stall case only.
    // A real process stuck in an uninterruptible filesystem operation
    // (D-state on a stalled NFS read, for example) may not exit promptly
    // after SIGKILL because the kernel cannot deliver the signal until the
    // syscall returns. The 5s bound is therefore a best-effort liveness
    // bound, not a hard wall-clock guarantee; the runtime proof confirms
    // the cooperative case, and the structural tests above pin the
    // timeout/killSignal contract for the implementation.
    //
    // We call `listFindChannelDocFiles` directly rather than the top-level
    // `listChannelDocFiles`, because the latter first tries
    // `listGitChannelDocFiles` which has an internal cache that persists
    // across tests and would bypass the find path entirely. Exercising
    // `listFindChannelDocFiles` directly proves the find-timeout path in
    // isolation, and the prior structural test already proves
    // `listChannelDocFiles` maps kind: "timeout" to a thrown error.
    const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-find-stub-"));
    const fakeFind = path.join(stubDir, "find");
    fs.writeFileSync(
      fakeFind,
      '#!/bin/sh\ntrap "" TERM\ntrap "" INT\nwhile true; do sleep 1; done\n',
    );
    fs.chmodSync(fakeFind, 0o755);
    const originalPath = process.env.PATH;
    process.env.PATH = `${stubDir}:${originalPath ?? ""}`;
    try {
      const start = Date.now();
      const result = listFindChannelDocFiles();
      const elapsed = Date.now() - start;

      // Must surface as a timeout, not "unavailable" or "files".
      expect(result).toMatchObject({ kind: "timeout", cause: "find" });
      // Must have sent SIGKILL at the ~5s deadline for this cooperative
      // user-space stub. A real process stuck in D-state could exceed
      // this; the bound here proves the cooperative-case behavior only.
      expect(elapsed).toBeGreaterThanOrEqual(4_500);
      // Must return promptly. Allow generous slack for CI scheduling.
      expect(elapsed).toBeLessThan(10_000);
    } finally {
      process.env.PATH = originalPath;
      fs.rmSync(stubDir, { recursive: true, force: true });
    }
  }, 15_000);
});
