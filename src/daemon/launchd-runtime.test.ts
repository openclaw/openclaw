import { expect, it, vi } from "vitest";
import { execLaunchctl } from "./launchd-exec.js";
import { probeLaunchAgentState } from "./launchd-runtime.js";

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
