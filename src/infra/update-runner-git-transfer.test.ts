import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { gitNullConfigPath } from "./git-exec.js";
import { prepareGitCandidateTransfer } from "./update-runner-git-transfer.js";
import type { CommandRunner, RunStepOptions, UpdateStepResult } from "./update-runner-types.js";

const temporary = useAutoCleanupTempDirTracker(afterEach);

// Windows forcibly terminates children instead of delivering the handled POSIX signal.
it.skipIf(process.platform === "win32").each(["none", "inventory", "pack"] as const)(
  "bounds transfer inventories and binary input (failure=%s)",
  async (failure) => {
    const overflow = failure === "inventory";
    const oversized = failure === "pack";
    const root = temporary.make("git-transfer-bounds-");
    const source = path.join(root, "source");
    const install = path.join(root, "install");
    fs.mkdirSync(source);
    const env = {
      ...process.env,
      GIT_CONFIG_GLOBAL: gitNullConfigPath(),
      GIT_CONFIG_NOSYSTEM: "1",
    };
    const git = async (cwd: string, ...args: string[]) => {
      const result = await runCommandWithTimeout(["git", "-C", cwd, ...args], {
        timeoutMs: 15_000,
        env,
      });
      expect(result.code, result.stderr).toBe(0);
      return result.stdout.trim();
    };
    await git(source, "init", "-b", "main");
    await git(source, "config", "user.name", "Transfer fixture");
    await git(source, "config", "user.email", "fixture@example.invalid");
    fs.writeFileSync(path.join(source, "base"), "base\n");
    await git(source, "add", ".");
    await git(source, "commit", "-m", "base");
    const beforeSha = await git(source, "rev-parse", "HEAD");
    await git(root, "clone", source, install);
    for (let index = 0; index < 250; index++) {
      const bytes = Buffer.concat(
        Array.from({ length: 8 }, (_, block) =>
          createHash("sha256").update(`${index}:${block}`).digest(),
        ),
      );
      fs.writeFileSync(path.join(source, `object-${index}`), bytes);
    }
    await git(source, "add", ".");
    await git(source, "commit", "-m", "candidate");
    const candidateSha = await git(source, "rev-parse", "HEAD");
    const results: UpdateStepResult[] = [];
    let inventoryBytes = 0;
    let packBytes = 0;
    let boundedExitObserved = false;
    const runCommand: CommandRunner = async (argv, options) => {
      if (overflow && argv.includes("rev-list")) {
        // The child emits real Git output and handles termination with exit zero.
        // This is legal process behavior; exit status alone cannot admit its tail.
        const script = `const { spawnSync } = require("node:child_process");
        process.on("SIGTERM", () => process.exit(0));
        const result = spawnSync(process.argv[1], process.argv.slice(2), { encoding: "utf8" });
        if (result.status !== 0) process.exit(result.status ?? 1);
        process.stdout.write(result.stdout); setInterval(() => {}, 1000);`;
        const result = await runCommandWithTimeout([process.execPath, "-e", script, ...argv], {
          ...options,
          env,
          maxOutputBytes: 41 * 12,
        });
        expect(result.code).toBe(0);
        expect(result.outputLimitExceeded).toBe(true);
        boundedExitObserved = true;
        return result;
      }
      if (argv.includes("pack-objects")) {
        inventoryBytes = Buffer.byteLength(options.input as string);
      }
      if (argv.includes("index-pack")) {
        packBytes = (options.input as Buffer).byteLength;
      }
      const result = await runCommandWithTimeout(argv, { ...options, env });
      if (oversized && argv.includes("pack-objects") && result.code === 0) {
        // Grow a real staged pack sparsely; refusal must precede a large allocation.
        const packPath = `${argv.at(-1)}-${result.stdout.trim()}.pack`;
        fs.chmodSync(packPath, 0o600);
        fs.truncateSync(packPath, 256 * 1024 * 1024 + 1);
      }
      return result;
    };
    const step = (cwd: string): RunStepOptions => ({
      runCommand,
      cwd,
      argv: [],
      name: "transfer proof",
      timeoutMs: 15_000,
      stepIndex: 0,
      totalSteps: 1,
      results,
    });
    const transfer = await prepareGitCandidateTransfer({
      candidateSha,
      beforeSha,
      step: step(source),
    });
    if (overflow || oversized) {
      expect(transfer).toBeUndefined();
      if (overflow) {
        expect(boundedExitObserved).toBe(true);
        expect(inventoryBytes).toBe(0);
      } else {
        expect(results).toContainEqual(
          expect.objectContaining({
            exitCode: 1,
            stderrTail: expect.stringContaining("file exceeds limit of 268435456 bytes"),
          }),
        );
      }
      expect(await git(install, "rev-parse", "HEAD")).toBe(beforeSha);
      return;
    }
    expect(transfer).toBeDefined();
    expect(inventoryBytes).toBeGreaterThan(8000);
    expect(await transfer!.importInto(step(install))).toBe(true);
    expect(packBytes).toBeGreaterThan(8000);
    await git(install, "checkout", "--detach", candidateSha);
    await transfer!.cleanup(step(install));
    for (let index = 0; index < 250; index++) {
      expect(fs.readFileSync(path.join(install, `object-${index}`))).toEqual(
        fs.readFileSync(path.join(source, `object-${index}`)),
      );
    }
  },
);
