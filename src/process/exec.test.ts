import { spawn } from "node:child_process";
import { chmodSync, copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import path from "node:path";
import process from "node:process";
import { afterEach, describe, expect, it } from "vitest";
import { captureEnv, withEnvAsync } from "../test-utils/env.js";
import { attachChildProcessBridge } from "./child-process-bridge.js";
import { runCommandWithTimeout, shouldSpawnWithShell } from "./exec.js";

const CHILD_READY_TIMEOUT_MS = 4_000;
const CHILD_EXIT_TIMEOUT_MS = 4_000;

function waitForLine(
  stream: NodeJS.ReadableStream,
  timeoutMs = CHILD_READY_TIMEOUT_MS,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = "";

    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("timeout waiting for line"));
    }, timeoutMs);

    const onData = (chunk: Buffer | string): void => {
      buffer += chunk.toString();
      const idx = buffer.indexOf("\n");
      if (idx >= 0) {
        const line = buffer.slice(0, idx).trim();
        cleanup();
        resolve(line);
      }
    };

    const onError = (err: unknown): void => {
      cleanup();
      reject(err);
    };

    const cleanup = (): void => {
      clearTimeout(timeout);
      stream.off("data", onData);
      stream.off("error", onError);
    };

    stream.on("data", onData);
    stream.on("error", onError);
  });
}

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
          timeoutMs: 5_000,
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
      [process.execPath, "-e", "setTimeout(() => {}, 40)"],
      {
        timeoutMs: 500,
        noOutputTimeoutMs: 20,
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
        [
          'process.stdout.write(".");',
          "let count = 0;",
          'const ticker = setInterval(() => { process.stdout.write(".");',
          "count += 1;",
          "if (count === 6) {",
          "clearInterval(ticker);",
          "process.exit(0);",
          "}",
          "}, 25);",
        ].join(" "),
      ],
      {
        timeoutMs: 3_000,
        // Keep a healthy margin above the emit interval while avoiding a 1s+ test delay.
        noOutputTimeoutMs: 400,
      },
    );

    expect(result.code ?? 0).toBe(0);
    expect(result.termination).toBe("exit");
    expect(result.noOutputTimedOut).toBe(false);
    expect(result.stdout.length).toBeGreaterThanOrEqual(7);
  });

  it("reports global timeout termination when overall timeout elapses", async () => {
    const result = await runCommandWithTimeout(
      [process.execPath, "-e", "setTimeout(() => {}, 40)"],
      {
        timeoutMs: 15,
      },
    );

    expect(result.termination).toBe("timeout");
    expect(result.noOutputTimedOut).toBe(false);
    expect(result.code).not.toBe(0);
  });

  it.runIf(process.platform === "win32")(
    "on Windows spawns node + npm-cli.js for npm argv to avoid spawn EINVAL",
    async () => {
      const result = await runCommandWithTimeout(["npm", "--version"], { timeoutMs: 10_000 });
      expect(result.code).toBe(0);
      expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
    },
  );
});

describe("attachChildProcessBridge", () => {
  const children: Array<{ kill: (signal?: NodeJS.Signals) => boolean }> = [];
  const detachments: Array<() => void> = [];

  afterEach(() => {
    for (const detach of detachments) {
      try {
        detach();
      } catch {
        // ignore
      }
    }
    detachments.length = 0;
    for (const child of children) {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
    }
    children.length = 0;
  });

  it("forwards SIGTERM to the wrapped child", async () => {
    const childPath = path.resolve(process.cwd(), "test/fixtures/child-process-bridge/child.js");

    const beforeSigterm = new Set(process.listeners("SIGTERM"));
    const child = spawn(process.execPath, [childPath], {
      stdio: ["ignore", "pipe", "inherit"],
      env: process.env,
    });
    const { detach } = attachChildProcessBridge(child);
    detachments.push(detach);
    children.push(child);
    const afterSigterm = process.listeners("SIGTERM");
    const addedSigterm = afterSigterm.find((listener) => !beforeSigterm.has(listener));

    if (!child.stdout) {
      throw new Error("expected stdout");
    }
    const ready = await waitForLine(child.stdout);
    expect(ready).toBe("ready");

    if (!addedSigterm) {
      throw new Error("expected SIGTERM listener");
    }
    addedSigterm("SIGTERM");

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("timeout waiting for child exit")),
        CHILD_EXIT_TIMEOUT_MS,
      );
      child.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  });
});

describe("runCommandWithTimeout Corepack prompt suppression", () => {
  // Creates a fake package manager executable and returns the full path to it.
  // On Windows: copies node.exe to {name}.exe and creates a .js script to run with it
  // On Unix: creates an executable shell script with shebang
  function createFakePackageManager(dir: string, name: string): string {
    const printEnv = `process.stdout.write(process.env.COREPACK_ENABLE_DOWNLOAD_PROMPT ?? "unset")`;

    if (process.platform === "win32") {
      // Create a .js script that prints the env var
      const scriptPath = join(dir, `${name}.js`);
      writeFileSync(scriptPath, printEnv);

      // Copy node.exe to {name}.exe so it can be executed directly
      // This way argv[0] will be "{name}.exe" which triggers the shouldSuppressCorePack logic
      const exePath = join(dir, `${name}.exe`);
      copyFileSync(process.execPath, exePath);

      // Return [exePath, scriptPath] to run the exe with the script
      // But we need to return just the command for the test to work
      // Actually, we need to modify how we call it
      return exePath;
    } else {
      const scriptPath = join(dir, name);
      writeFileSync(scriptPath, `#!/bin/sh\n"${process.execPath}" -e '${printEnv}'`);
      chmodSync(scriptPath, 0o755);
      return scriptPath;
    }
  }

  for (const manager of ["pnpm", "yarn", "bun"]) {
    it(`sets COREPACK_ENABLE_DOWNLOAD_PROMPT=0 when running ${manager}`, async () => {
      const envSnapshot = captureEnv(["COREPACK_ENABLE_DOWNLOAD_PROMPT"]);
      delete process.env.COREPACK_ENABLE_DOWNLOAD_PROMPT;
      const dir = mkdtempSync(join(tmpdir(), "exec-corepack-test-"));
      try {
        const command = createFakePackageManager(dir, manager);
        const argv =
          process.platform === "win32" ? [command, join(dir, `${manager}.js`)] : [command];
        const result = await runCommandWithTimeout(argv, { timeoutMs: 5_000 });
        expect(result.code).toBe(0);
        expect(result.stdout).toBe("0");
      } finally {
        rmSync(dir, { recursive: true, force: true });
        envSnapshot.restore();
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
      const command = createFakePackageManager(dir, "pnpm");
      const argv = process.platform === "win32" ? [command, join(dir, "pnpm.js")] : [command];
      const result = await runCommandWithTimeout(argv, {
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
