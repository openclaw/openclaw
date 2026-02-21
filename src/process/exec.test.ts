import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import { runCommandWithTimeout, shouldSpawnWithShell } from "./exec.js";
import {
  PROCESS_TEST_NO_OUTPUT_TIMEOUT_MS,
  PROCESS_TEST_SCRIPT_DELAY_MS,
  PROCESS_TEST_TIMEOUT_MS,
} from "./test-timeouts.js";

describe("runCommandWithTimeout", () => {
  it("never enables shell execution (Windows cmd.exe injection hardening)", () => {
    expect(
      shouldSpawnWithShell({
        resolvedCommand: "npm.cmd",
        platform: "win32",
      }),
    ).toBe(false);
  });

  it("merges custom env with process.env", async () => {
    await withEnvAsync({ OPENCLAW_BASE_ENV: "base" }, async () => {
      const result = await runCommandWithTimeout(
        [
          process.execPath,
          "-e",
          'process.stdout.write((process.env.OPENCLAW_BASE_ENV ?? "") + "|" + (process.env.OPENCLAW_TEST_ENV ?? ""))',
        ],
        {
          timeoutMs: PROCESS_TEST_TIMEOUT_MS.medium,
          env: { OPENCLAW_TEST_ENV: "ok" },
        },
      );

      expect(result.code).toBe(0);
      expect(result.stdout).toBe("base|ok");
      expect(result.termination).toBe("exit");
    });
  });

  it("kills command when no output timeout elapses", async () => {
    const result = await runCommandWithTimeout(
      [
        process.execPath,
        "-e",
        `setTimeout(() => {}, ${PROCESS_TEST_SCRIPT_DELAY_MS.silentProcess})`,
      ],
      {
        timeoutMs: PROCESS_TEST_TIMEOUT_MS.standard,
        noOutputTimeoutMs: PROCESS_TEST_NO_OUTPUT_TIMEOUT_MS.exec,
      },
    );

    expect(result.termination).toBe("no-output-timeout");
    expect(result.noOutputTimedOut).toBe(true);
    expect(result.code).not.toBe(0);
  });

  it("resets no output timer when command keeps emitting output", async () => {
    const result = await runCommandWithTimeout(
      [
        process.execPath,
        "-e",
        `process.stdout.write(".\\n"); const interval = setInterval(() => process.stdout.write(".\\n"), ${PROCESS_TEST_SCRIPT_DELAY_MS.streamingInterval}); setTimeout(() => { clearInterval(interval); process.exit(0); }, ${PROCESS_TEST_SCRIPT_DELAY_MS.streamingDuration});`,
      ],
      {
        timeoutMs: PROCESS_TEST_TIMEOUT_MS.extraLong,
        noOutputTimeoutMs: PROCESS_TEST_NO_OUTPUT_TIMEOUT_MS.streamingAllowance,
      },
    );

    expect(result.signal).toBeNull();
    expect(result.code ?? 0).toBe(0);
    expect(result.termination).toBe("exit");
    expect(result.noOutputTimedOut).toBe(false);
    expect(result.stdout.length).toBeGreaterThanOrEqual(2);
  });

  it("reports global timeout termination when overall timeout elapses", async () => {
    const result = await runCommandWithTimeout(
      [
        process.execPath,
        "-e",
        `setTimeout(() => {}, ${PROCESS_TEST_SCRIPT_DELAY_MS.silentProcess})`,
      ],
      {
        timeoutMs: PROCESS_TEST_TIMEOUT_MS.short,
      },
    );

    expect(result.termination).toBe("timeout");
    expect(result.noOutputTimedOut).toBe(false);
    expect(result.code).not.toBe(0);
  });
});

describe("runCommandWithTimeout Corepack prompt suppression", () => {
  // Creates a fake package manager script in a temp dir and returns argv[0] to pass.
  // On Windows: writes a .cmd batch file; for pnpm/yarn resolveCommand auto-appends
  // .cmd so we return the path without extension; for bun we return the .cmd path directly.
  // On Unix: writes an executable shell script and returns its path.
  function createFakePackageManager(dir: string, name: string): string {
    const printEnv = `process.stdout.write(process.env.COREPACK_ENABLE_DOWNLOAD_PROMPT ?? "unset")`;
    if (process.platform === "win32") {
      writeFileSync(join(dir, `${name}.cmd`), `@${process.execPath} -e "${printEnv}"`);
      // resolveCommand auto-appends .cmd for pnpm and yarn; bun gets no auto-suffix
      const autoCmd = name === "pnpm" || name === "yarn";
      return autoCmd ? join(dir, name) : join(dir, `${name}.cmd`);
    } else {
      const p = join(dir, name);
      writeFileSync(p, `#!/bin/sh\n${process.execPath} -e '${printEnv}'`);
      chmodSync(p, 0o755);
      return p;
    }
  }

  for (const manager of ["pnpm", "yarn", "bun"]) {
    it(`sets COREPACK_ENABLE_DOWNLOAD_PROMPT=0 when running ${manager}`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "exec-corepack-test-"));
      try {
        const argv0 = createFakePackageManager(dir, manager);
        const result = await runCommandWithTimeout([argv0], { timeoutMs: 5_000 });
        expect(result.code).toBe(0);
        expect(result.stdout).toBe("0");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  it("does not set COREPACK_ENABLE_DOWNLOAD_PROMPT when running node", async () => {
    const envSnapshot = captureEnv(["COREPACK_ENABLE_DOWNLOAD_PROMPT"]);
    delete process.env.COREPACK_ENABLE_DOWNLOAD_PROMPT;
    try {
      const result = await runCommandWithTimeout(
        [
          process.execPath,
          "-e",
          'process.stdout.write(process.env.COREPACK_ENABLE_DOWNLOAD_PROMPT ?? "unset")',
        ],
        { timeoutMs: 5_000 },
      );
      expect(result.code).toBe(0);
      expect(result.stdout).toBe("unset");
    } finally {
      envSnapshot.restore();
    }
  });

  it("does not override COREPACK_ENABLE_DOWNLOAD_PROMPT when already set in env option", async () => {
    const dir = mkdtempSync(join(tmpdir(), "exec-corepack-test-"));
    try {
      const argv0 = createFakePackageManager(dir, "pnpm");
      const result = await runCommandWithTimeout([argv0], {
        timeoutMs: 5_000,
        env: { COREPACK_ENABLE_DOWNLOAD_PROMPT: "1" },
      });
      expect(result.code).toBe(0);
      expect(result.stdout).toBe("1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
