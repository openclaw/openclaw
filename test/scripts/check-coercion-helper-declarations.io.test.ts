import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCoercionHelperDeclarationGuard } from "../../scripts/check-coercion-helper-declarations.mts";
import { createDeferred } from "../helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const parseError = vi.hoisted(() => new Error("first source parse failed"));

vi.mock("typescript", async (importOriginal) => {
  const actual = await importOriginal<{ default: typeof import("typescript") }>();
  return {
    ...actual,
    default: {
      ...actual.default,
      createSourceFile: (...args: Parameters<typeof actual.default.createSourceFile>) => {
        if (args[0] === "a-parse.ts") {
          throw parseError;
        }
        return actual.default.createSourceFile(...args);
      },
    },
  };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

function createTrackedRepo(files: string[]) {
  const repoRoot = tempDirs.make("coercion-helper-io-");
  for (const file of files) {
    fs.writeFileSync(path.join(repoRoot, file), "function readString() {}\n");
  }
  execFileSync("git", ["init", "-q"], { cwd: repoRoot });
  execFileSync("git", ["add", "--", ...files], { cwd: repoRoot });
  return repoRoot;
}

function captureGuard(repoRoot: string) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const completion = runCoercionHelperDeclarationGuard({
    repoRoot,
    carveOuts: [],
    io: {
      stdout: { write: (value) => stdout.push(value) },
      stderr: { write: (value) => stderr.push(value) },
    },
  });
  return { completion, stdout, stderr };
}

describe("coercion helper guard file reads", () => {
  it("overlaps a bounded set of reads and keeps sorted diagnostics with tracked deletions", async () => {
    const files = Array.from({ length: 80 }, (_, index) => `${String(index).padStart(3, "0")}.ts`);
    const repoRoot = createTrackedRepo([...files, "deleted.ts"]);
    fs.unlinkSync(path.join(repoRoot, "deleted.ts"));
    fs.writeFileSync(path.join(repoRoot, "untracked.ts"), "function readNumber() {}\n");
    const release = createDeferred();
    const started: string[] = [];
    let active = 0;
    let maximumActive = 0;
    vi.spyOn(fs.promises, "readFile").mockImplementation(async (file) => {
      if (typeof file !== "string") {
        throw new Error("Expected a string file path");
      }
      started.push(path.basename(file));
      active++;
      maximumActive = Math.max(maximumActive, active);
      try {
        await release.promise;
        return fs.readFileSync(file, "utf8");
      } finally {
        active--;
      }
    });

    const { completion, stdout, stderr } = captureGuard(repoRoot);
    try {
      expect(started.length).toBeGreaterThan(1);
      expect(started.length).toBeLessThan(files.length);
    } finally {
      release.resolve();
      await completion;
    }
    expect(await completion).toBe(1);
    expect(active).toBe(0);
    expect(maximumActive).toBeLessThan(files.length);
    expect(started).toEqual(files);
    expect(stdout).toEqual([]);
    expect(stderr.filter((line) => line.includes("(function declaration)"))).toEqual(
      files.map((file) => `- ${file}:1 readString (function declaration)\n`),
    );
  });

  it.each(["read", "parse"] as const)(
    "drains pending reads before reporting the first sorted %s error",
    async (firstFailure) => {
      const firstFile = firstFailure === "parse" ? "a-parse.ts" : "a-read.ts";
      const repoRoot = createTrackedRepo([firstFile, "b-read.ts", "c-pending.ts"]);
      const first = createDeferred<string>();
      const second = createDeferred<string>();
      const last = createDeferred<string>();
      const firstReadError = new Error("first sorted read failed");
      const laterReadError = new Error("later sorted read failed first");
      vi.spyOn(fs.promises, "readFile").mockImplementation((file) => {
        if (typeof file !== "string") {
          throw new Error("Expected a string file path");
        }
        switch (path.basename(file)) {
          case firstFile:
            return first.promise;
          case "b-read.ts":
            return second.promise;
          case "c-pending.ts":
            return last.promise;
          default:
            throw new Error(`Unexpected read: ${file}`);
        }
      });
      const { completion, stdout, stderr } = captureGuard(repoRoot);
      let settled = false;
      const outcome = Promise.resolve(completion).then(
        (value) => {
          settled = true;
          return { value };
        },
        (error: unknown) => {
          settled = true;
          return { error };
        },
      );
      try {
        second.reject(laterReadError);
        if (firstFailure === "parse") {
          first.resolve("function readString() {}\n");
        } else {
          first.reject(firstReadError);
        }
        await Promise.allSettled([first.promise, second.promise]);
        expect(settled).toBe(false);
        last.resolve("");
        expect(await outcome).toEqual({
          error: firstFailure === "parse" ? parseError : firstReadError,
        });
        expect(stdout).toEqual([]);
        expect(stderr).toEqual([]);
      } finally {
        first.resolve("");
        second.resolve("");
        last.resolve("");
        await outcome;
      }
    },
  );
});
