import { Command } from "commander";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CRON_JOB_SCRATCH_MAX_BYTES } from "../../cron/scratch-contract.js";
import { defaultRuntime } from "../../runtime.js";

const rpc = vi.hoisted(() => vi.fn());
vi.mock("../gateway-rpc.js", async () => {
  const actual = await vi.importActual<typeof import("../gateway-rpc.js")>("../gateway-rpc.js");
  return { ...actual, callGatewayFromCli: rpc };
});
const { registerCronScratchCommand } = await import("./register.cron-scratch.js");
async function run(args: string[]) {
  const program = new Command().exitOverride();
  registerCronScratchCommand(program);
  await program.parseAsync(["scratch", "job-1", ...args], { from: "user" });
}
const result = { ok: true, scratch: null, currentRevision: 3, maxBytes: 1024 };
const current = { ...result, currentRevision: 2 };
beforeEach(() => {
  rpc
    .mockReset()
    .mockImplementation(async (method: string) =>
      method === "cron.scratch.get" ? current : result,
    );
  vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

function expectRpc(...calls: ["get" | "set", Record<string, unknown>][]) {
  expect(rpc.mock.calls).toEqual(
    calls.map(([method, params]) => [
      `cron.scratch.${method}`,
      expect.anything(),
      { id: "job-1", ...params },
    ]),
  );
}

async function expectFailure(args: string[], message: string) {
  await expect(run(args)).rejects.toMatchObject({ name: "ExitError", code: 1 });
  expect(defaultRuntime.error).toHaveBeenCalledWith(expect.stringContaining(message));
}

it("uses the read revision for an implicit CAS write and prints JSON", async () => {
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const json = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
  await run(["--set", "new note"]);
  expect(json).toHaveBeenCalledExactlyOnceWith(result);
  expect(stdout).not.toHaveBeenCalled();
  expectRpc(["get", {}], ["set", { content: "new note", expectedRevision: 2 }]);
});

it("rejects non-decimal revisions after reading but before writing", async () => {
  await expectFailure(
    ["--set", "x", "--expected-revision", "0x2"],
    "--expected-revision must be a non-negative integer",
  );
  expectRpc(["get", {}]);
});

it.each([
  ["0", ["--set", "x"], "x"],
  ["42", ["--unset", "--json"], null],
] as const)("writes at explicit revision %s without a read", async (revision, args, content) => {
  await run([...args, "--expected-revision", revision]);
  expectRpc(["set", { content, expectedRevision: Number(revision) }]);
});

it("reports revision conflicts without rereading or retrying", async () => {
  rpc.mockResolvedValue({ ok: false, currentRevision: 43 });
  await expectFailure(
    ["--unset", "--expected-revision", "42"],
    "cron scratch changed concurrently (current revision 43)",
  );
  expectRpc(["set", { content: null, expectedRevision: 42 }]);
});

it.each([
  ["invalid revision", ["--set", "x", "--expected-revision", "invalid"]],
  ["file input", ["--file", "missing-scratch-file", "--expected-revision", "42"]],
  [
    "oversized inline input",
    ["--set", "x".repeat(CRON_JOB_SCRATCH_MAX_BYTES + 1), "--expected-revision", "42"],
  ],
])("reports Gateway errors before consuming %s", async (_label, args) => {
  rpc.mockRejectedValue(new Error("Gateway unavailable"));
  await expectFailure(args, "Gateway unavailable");
  expectRpc(["get", {}]);
});
