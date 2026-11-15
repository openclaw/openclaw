import { afterEach, expect, it, vi } from "vitest";
import {
  terminateVitestProcessGroupForTimeout,
  writeVitestProcessDiagnostics,
} from "../../scripts/vitest-process-group.mts";
afterEach(() => vi.useRealTimers());

it("signals the process group before a stuck diagnostic and bounds the wait", async () => {
  vi.useFakeTimers();
  const kill = vi.fn(() => true);
  const startDiagnostics = vi.fn((_signal: AbortSignal) => new Promise<void>(() => {}));

  const result = terminateVitestProcessGroupForTimeout({
    child: { pid: 42 },
    diagnosticsDeadlineMs: 50,
    kill,
    log: vi.fn(),
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
});

it.each(["darwin", "win32"] as const)("safe diagnostics: %s", async (platform) => {
  const parent = "42 7 42 01:02 S 87.5 204800 wait /Users/alice/private/node --token SECRET_TOKEN";
  const outputs: Record<string, string> = {
    pgrep: "42\n43\n",
    lsof: "p42\nf0\ntCHR\nn/Users/alice/private-token\nf1\ntREG\nnhttps://internal.example/SECRET_TOKEN",
  };
  const probe = vi.fn(
    async (command: string, args: string[]) =>
      outputs[command] ??
      (args.at(-1) === "42"
        ? parent
        : `${parent}\n43 42 42 01:01 D 12.5 102400 futex ci.internal.example:8443`),
  );
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
  expect(output).not.toMatch(/SECRET_TOKEN|internal\.example|\/Users\/alice|private-token|alice/u);
});
