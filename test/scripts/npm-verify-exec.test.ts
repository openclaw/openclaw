// Npm Verify Exec tests cover npm verify exec script behavior.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runNpmVerifyCommand } from "../../scripts/lib/npm-verify-exec.ts";
<<<<<<< HEAD
import { withEnv } from "../../src/test-utils/env.js";
=======
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df

const tempDirs: string[] = [];

function makeTempRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "openclaw-npm-verify-exec-"));
  tempDirs.push(root);
  return root;
}

<<<<<<< HEAD
=======
function withProcessEnv<T>(env: Record<string, string>, callback: () => T): T {
  const previous = new Map<string, string | undefined>();
  for (const key of Object.keys(env)) {
    previous.set(key, process.env[key]);
  }
  for (const [key, value] of Object.entries(env)) {
    process.env[key] = value;
  }
  try {
    return callback();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("npm verifier command execution", () => {
  it("trims successful command output", () => {
    const root = makeTempRoot();

    expect(
      runNpmVerifyCommand(
        {
          command: process.execPath,
          args: ["-e", "process.stdout.write('  ok\\n')"],
        },
        root,
        { timeoutMs: 5_000 },
      ),
    ).toBe("ok");
  });

  it("bounds hung commands even when they ignore SIGTERM", () => {
    const root = makeTempRoot();
    const startedAt = Date.now();

    expect(() =>
      runNpmVerifyCommand(
        {
          command: process.execPath,
          args: ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
        },
        root,
        { timeoutMs: 100 },
      ),
    ).toThrow(/ETIMEDOUT|timed out/u);
    expect(Date.now() - startedAt).toBeLessThan(2_500);
  });

  it("bounds buffered command output", () => {
    const root = makeTempRoot();

    expect(() =>
      runNpmVerifyCommand(
        {
          command: process.execPath,
          args: ["-e", "process.stdout.write('x'.repeat(2048));"],
        },
        root,
        { maxBufferBytes: 1024, timeoutMs: 5_000 },
      ),
    ).toThrow(/ENOBUFS|maxBuffer/u);
  });

  it("rejects malformed command limit environment values", () => {
    const root = makeTempRoot();

<<<<<<< HEAD
    withEnv({ OPENCLAW_NPM_VERIFY_COMMAND_TIMEOUT_MS: "5m" }, () => {
=======
    withProcessEnv({ OPENCLAW_NPM_VERIFY_COMMAND_TIMEOUT_MS: "5m" }, () => {
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
      expect(() =>
        runNpmVerifyCommand(
          { command: process.execPath, args: ["-e", "process.stdout.write('ok')"] },
          root,
        ),
      ).toThrow("invalid OPENCLAW_NPM_VERIFY_COMMAND_TIMEOUT_MS: 5m");
    });

<<<<<<< HEAD
    withEnv({ OPENCLAW_NPM_VERIFY_COMMAND_MAX_BUFFER_BYTES: "16mb" }, () => {
=======
    withProcessEnv({ OPENCLAW_NPM_VERIFY_COMMAND_MAX_BUFFER_BYTES: "16mb" }, () => {
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
      expect(() =>
        runNpmVerifyCommand(
          { command: process.execPath, args: ["-e", "process.stdout.write('ok')"] },
          root,
        ),
      ).toThrow("invalid OPENCLAW_NPM_VERIFY_COMMAND_MAX_BUFFER_BYTES: 16mb");
    });
  });
});
