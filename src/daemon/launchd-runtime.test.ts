import { expect, it, vi } from "vitest";
import { execLaunchctl } from "./launchd-exec.js";
import { LAUNCH_AGENT_EXIT_TIMEOUT_SECONDS } from "./launchd-plist.js";
import { bootstrapLaunchAgentOrThrow, probeLaunchAgentState } from "./launchd-runtime.js";
import { nativeExit } from "./systemd-exec.test-support.js";

vi.mock("./launchd-exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./launchd-exec.js")>()),
  execLaunchctl: vi.fn(),
}));

const target = "gui/501/ai.openclaw.fixture";

const job = (fields: string, name = target) => `${name} = {\n${fields}\n}`;
const unknownJob = { state: "unknown", detail: expect.any(String) };
it.each([
  [
    "selected job state, ignoring nested coalitions",
    job(
      "\tstate =  running \t\n\tpid = 4242\n\tlast exit status = 1\n\tlast exit reason =  exited \t\n\tresource coalition = {\n\t\tstate = active\n\t}\n\tjetsam coalition = {\n\t\tstate = active\n\t}",
    ),
    {
      state: "running",
      runtime: { state: "running", pid: 4242, lastExitStatus: 1, lastExitReason: "exited" },
    },
  ],
  [
    "invalid integer suffixes",
    job("\tstate = waiting\n\tpid = 123abc\n\tlast exit status = 7ms\n\tlast exit reason = exited"),
    { state: "stopped", runtime: { state: "waiting", lastExitReason: "exited" } },
  ],
  ["foreign job", job("\tstate = running\n\tpid = 4242", "gui/501/ai.openclaw.other"), unknownJob],
  ["duplicate state", job("\tstate = running\n\tstate = waiting"), unknownJob],
] as const)("reports %s", async (_name, stdout, expected) => {
  vi.mocked(execLaunchctl).mockResolvedValue(nativeExit(stdout));
  await expect(probeLaunchAgentState(target)).resolves.toEqual(expected);
});

it.each([
  ["forward", 1_000_000, 500, false],
  ["backward", -5_000, (LAUNCH_AGENT_EXIT_TIMEOUT_SECONDS + 10) * 1_000, true],
] as const)(
  "keeps the monotonic retry budget on a %s clock jump",
  async (_name, wallJumpMs, advanceMs, bootstrapKeepsFailing) => {
    let bootCalls = 0;
    vi.mocked(execLaunchctl).mockImplementation(async (args) => {
      if (args[0] !== "bootstrap") {
        return nativeExit();
      }
      if (bootCalls++ === 0) {
        // The wall clock jumps between the deadline seed and the remaining read.
        vi.setSystemTime(Date.now() + wallJumpMs);
        return nativeExit("", "bootstrap failed: 5", 1);
      }
      return bootstrapKeepsFailing ? nativeExit("", "bootstrap failed: 5", 1) : nativeExit();
    });
    vi.useFakeTimers();

    let settled = false;
    const result = bootstrapLaunchAgentOrThrow({
      domain: "gui/501",
      serviceTarget: target,
      plistPath: "/tmp/ai.openclaw.fixture.plist",
      actionHint: "test",
      retryPendingTeardown: true,
    });
    const markSettled = () => {
      settled = true;
    };
    void result.then(markSettled, markSettled);

    await vi.advanceTimersByTimeAsync(advanceMs);
    await Promise.resolve();
    expect(settled).toBe(true);

    if (wallJumpMs > 0) {
      await expect(result).resolves.toBe("bootstrapped");
    } else {
      await expect(result).rejects.toThrow("launchctl bootstrap failed");
    }
    vi.useRealTimers();
  },
);
