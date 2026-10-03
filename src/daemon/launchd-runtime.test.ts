import { expect, it, vi } from "vitest";
import { execLaunchctl } from "./launchd-exec.js";
import { probeLaunchAgentState } from "./launchd-runtime.js";

vi.mock("./launchd-exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./launchd-exec.js")>()),
  execLaunchctl: vi.fn(),
}));

const target = "gui/501/ai.openclaw.fixture";

it("reports the selected job state instead of its native coalition states", async () => {
  vi.mocked(execLaunchctl).mockResolvedValue({
    code: 0,
    termination: "exit",
    stderr: "",
    stdout: [
      `${target} = {`,
      "\tstate =  running \t",
      "\tpid = 4242",
      "\tlast exit status = 1",
      "\tlast exit reason =  exited \t",
      "\tresource coalition = {",
      "\t\tstate = active",
      "\t}",
      "\tjetsam coalition = {",
      "\t\tstate = active",
      "\t}",
      "}",
    ].join("\n"),
  });

  await expect(probeLaunchAgentState(target)).resolves.toEqual({
    state: "running",
    runtime: { state: "running", pid: 4242, lastExitStatus: 1, lastExitReason: "exited" },
  });
});

it("rejects pid and exit status values with junk suffixes", async () => {
  vi.mocked(execLaunchctl).mockResolvedValue({
    code: 0,
    termination: "exit",
    stderr: "",
    stdout: [
      `${target} = {`,
      "\tstate = waiting",
      "\tpid = 123abc",
      "\tlast exit status = 7ms",
      "\tlast exit reason = exited",
      "}",
    ].join("\n"),
  });

  await expect(probeLaunchAgentState(target)).resolves.toEqual({
    state: "stopped",
    runtime: { state: "waiting", lastExitReason: "exited" },
  });
});

it.each([
  "gui/501/ai.openclaw.other = {\n\tstate = running\n\tpid = 4242\n}",
  `${target} = {\n\tstate = running\n\tstate = waiting\n}`,
])("keeps unrecognized native job output unknown", async (stdout) => {
  vi.mocked(execLaunchctl).mockResolvedValue({ code: 0, termination: "exit", stderr: "", stdout });

  await expect(probeLaunchAgentState(target)).resolves.toMatchObject({
    state: "unknown",
    detail: expect.any(String),
  });
});
