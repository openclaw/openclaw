import { afterEach, expect, it, vi } from "vitest";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";

const { members } = vi.hoisted(() => ({ members: vi.fn() }));
// Supply admitted census observations without invoking host process inspection.
vi.mock("../process/supervisor/service-child-group-ownership.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../process/supervisor/service-child-group-ownership.js")
  >()),
  readProcessGroupMembers: members,
}));
vi.mock("./container-environment.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./container-environment.js")>()),
  isContainerEnvironment: () => false,
}));
vi.mock("./gateway-process-argv.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./gateway-process-argv.js")>()),
  readProcessWorkingDirectories: () => new Map(),
}));
import { inspectOtherOpenClawProcesses } from "./openclaw-process-census.js";

afterEach(() => vi.restoreAllMocks());

it("retains a PID with no command and continues to later holders", () => {
  mockProcessPlatform("linux");
  const missing = process.pid + 1;
  const holder = process.pid + 2;
  members.mockReturnValue([
    { pid: process.pid, state: "S", command: { ppid: 0, argv: ["openclaw-doctor"] } },
    { pid: missing, state: "S" },
    { pid: holder, state: "S", command: { ppid: 0, argv: ["openclaw-gateway"] } },
  ]);
  expect(inspectOtherOpenClawProcesses("/tmp/openclaw-update-runtime-Held01")).toEqual({
    pids: [missing, holder],
    warnings: [expect.stringContaining(`PID ${missing}: process command is unavailable`)],
  });
});
