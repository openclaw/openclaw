import { describe, expect, it, vi } from "vitest";
import { execLaunchctl } from "./launchd-exec.js";
import { LAUNCH_AGENT_EXIT_TIMEOUT_SECONDS } from "./launchd-plist.js";
import { bootstrapLaunchAgentOrThrow, probeLaunchAgentState } from "./launchd-runtime.js";

vi.mock("./launchd-exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./launchd-exec.js")>()),
  execLaunchctl: vi.fn(),
}));

const target = "gui/501/ai.openclaw.fixture";

it.each([
  {
    name: "selected job state, ignoring nested coalitions",
    output: `${target} = {
\tstate =  running \t
\tpid = 4242
\tlast exit status = 1
\tlast exit reason =  exited \t
\tresource coalition = {
\t\tstate = active
\t}
\tjetsam coalition = {
\t\tstate = active
\t}
}`,
    expected: {
      state: "running",
      runtime: { state: "running", pid: 4242, lastExitStatus: 1, lastExitReason: "exited" },
    },
  },
  {
    name: "invalid integer suffixes",
    output: `${target} = {\n\tstate = waiting\n\tpid = 123abc\n\tlast exit status = 7ms\n\tlast exit reason = exited\n}`,
    expected: { state: "stopped", runtime: { state: "waiting", lastExitReason: "exited" } },
  },
  ...[
    "gui/501/ai.openclaw.other = {\n\tstate = running\n\tpid = 4242\n}",
    `${target} = {\n\tstate = running\n\tstate = waiting\n}`,
  ].map((output) => ({
    name: `unrecognized output: ${output}`,
    output,
    expected: { state: "unknown", detail: expect.any(String) },
  })),
])("reports $name", async ({ output: stdout, expected }) => {
  vi.mocked(execLaunchctl).mockResolvedValue({ code: 0, termination: "exit", stderr: "", stdout });
  await expect(probeLaunchAgentState(target)).resolves.toEqual(expected);
});

describe("bootstrapLaunchAgentOrThrow teardown retry deadline", () => {
  const plistPath = "/tmp/ai.openclaw.fixture.plist";
  const teardownTimeoutMs = (LAUNCH_AGENT_EXIT_TIMEOUT_SECONDS + 10) * 1_000;
  const pollMs = 500;

  it.each([
    {
      name: "a forward wall-clock jump does not truncate the retry budget",
      wallJumpMs: 1_000_000,
      advanceMs: pollMs,
      bootstrapKeepsFailing: false,
    },
    {
      name: "a backward wall-clock jump does not inflate the retry budget",
      wallJumpMs: -5_000,
      advanceMs: teardownTimeoutMs,
      bootstrapKeepsFailing: true,
    },
  ])("$name", async ({ wallJumpMs, advanceMs, bootstrapKeepsFailing }) => {
    let bootCalls = 0;
    vi.mocked(execLaunchctl).mockImplementation(async (args) => {
      if (args[0] !== "bootstrap") {
        return { code: 0, termination: "exit", stdout: "", stderr: "" };
      }
      if (bootCalls++ === 0) {
        // The wall clock jumps between the deadline seed and the remaining read.
        vi.setSystemTime(Date.now() + wallJumpMs);
        return { code: 1, termination: "exit", stdout: "", stderr: "bootstrap failed: 5" };
      }
      if (bootstrapKeepsFailing) {
        return { code: 1, termination: "exit", stdout: "", stderr: "bootstrap failed: 5" };
      }
      return { code: 0, termination: "exit", stdout: "", stderr: "" };
    });
    vi.useFakeTimers();

    let settled = false;
    const result = bootstrapLaunchAgentOrThrow({
      domain: "gui/501",
      serviceTarget: target,
      plistPath,
      actionHint: "test",
      retryPendingTeardown: true,
    });
    void result.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    await vi.advanceTimersByTimeAsync(advanceMs);
    await Promise.resolve();
    // The loop must settle within the monotonic budget regardless of the wall clock.
    expect(settled).toBe(true);

    if (wallJumpMs > 0) {
      await expect(result).resolves.toBe("bootstrapped");
    } else {
      await expect(result).rejects.toThrow("launchctl bootstrap failed");
    }
    vi.useRealTimers();
  });
});
