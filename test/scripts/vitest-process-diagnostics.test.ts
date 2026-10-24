import { spawnSync } from "node:child_process";
import nodePath from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  terminateVitestProcessGroupForTimeout,
  writeVitestProcessDiagnostics,
} from "../../scripts/vitest-process-group.mts";
import { testRunnerFixtureEnv } from "./prepared-script-wrapper.test-support.js";

const posixIt = process.platform === "win32" ? it.skip : it;
afterEach(() => vi.useRealTimers());

it("signals the process group before a stuck diagnostic and bounds the wait", async () => {
  vi.useFakeTimers();
  const kill = vi.fn(() => true);
  const log = vi.fn();
  const startDiagnostics = vi.fn((_signal: AbortSignal) => new Promise<void>(() => {}));

  const result = terminateVitestProcessGroupForTimeout({
    child: { pid: 42 },
    diagnosticsDeadlineMs: 50,
    kill,
    log,
    platform: "darwin",
    startDiagnostics,
  });

  expect(kill).toHaveBeenCalledWith(-42, "SIGTERM");
  expect(startDiagnostics).not.toHaveBeenCalled();

  await Promise.resolve();
  expect(startDiagnostics).toHaveBeenCalledTimes(1);

  await vi.advanceTimersByTimeAsync(50);
  await expect(result.diagnostics).resolves.toBeUndefined();
  expect(startDiagnostics.mock.calls[0]?.[0].aborted).toBe(true);
  expect(log).toHaveBeenCalledWith("[vitest] process diagnostics deadline reached after 50ms.");
});

it.each(["darwin", "win32"] as const)(
  "sanitizes diagnostics or skips probes on %s",
  async (platform) => {
    const probe = vi.fn(async (command: string, args: string[]) => {
      if (command === "pgrep") {
        return "42\n43\n";
      }
      if (command === "lsof") {
        return "p42\nf0\ntCHR\nn/Users/alice/private-token\nf1\ntREG\nnhttps://internal.example/SECRET_TOKEN";
      }
      const parent =
        "42 7 42 01:02 S 87.5 204800 wait /Users/alice/private/node --token SECRET_TOKEN";
      return args.at(-1) === "42"
        ? parent
        : `${parent}\n43 42 42 01:01 D 12.5 102400 futex ci.internal.example:8443`;
    });
    const log = vi.fn();
    await writeVitestProcessDiagnostics({
      childPid: 42,
      log,
      platform,
      probe,
      signal: new AbortController().signal,
    });
    if (platform === "win32") {
      expect(probe).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith(
        "[vitest] process diagnostics: pid=42 platform=win32 details=unavailable",
      );
      return;
    }

    const output = log.mock.calls.flat().join("\n");
    expect(output).toContain("comm=node");
    expect(output).toContain("comm=other");
    expect(output).toContain("fd summary: total=2 types=CHR:1,REG:1");
    expect(output).not.toMatch(
      /SECRET_TOKEN|internal\.example|\/Users\/alice|private-token|alice/u,
    );
  },
);

posixIt.each(["mjs", "mts"])(
  "preserves SIGTERM exit 143 and one final %s trailer end to end",
  (extension) => {
    const result = spawnSync(
      process.execPath,
      [
        nodePath.resolve(`scripts/run-vitest.${extension}`),
        "run",
        "--config",
        "test/vitest/vitest.tooling.config.ts",
        "test/scripts/run-vitest-profile.test.ts",
      ],
      {
        encoding: "utf8",
        env: testRunnerFixtureEnv({
          OPENCLAW_VITEST_NO_OUTPUT_HEARTBEAT_MS: "0",
          OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS: "1",
        }),
        timeout: 15_000,
      },
    );

    expect(result.signal).toBe("SIGTERM");
    const trailer = `[${extension === "mjs" ? "test" : "vitest"}] FAILED (exit 143)`;
    expect(result.stderr.match(/^\[.*\] FAILED \(exit \d+\)$/gmu)).toEqual([trailer]);
    expect(result.stderr.trim().split("\n").at(-1)).toBe(trailer);
  },
);
