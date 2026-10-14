import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CRON_JOB_SCRATCH_MAX_BYTES } from "../../cron/scratch-contract.js";
import { defaultRuntime } from "../../runtime.js";

const callGatewayFromCli = vi.fn();
vi.mock("../gateway-rpc.js", async () => {
  const actual = await vi.importActual<typeof import("../gateway-rpc.js")>("../gateway-rpc.js");
  return {
    ...actual,
    callGatewayFromCli: (...args: Parameters<typeof actual.callGatewayFromCli>) =>
      callGatewayFromCli(...args),
  };
});
const { registerCronScratchCommand } = await import("./register.cron-scratch.js");
async function run(args: string[]) {
  const program = new Command().exitOverride();
  registerCronScratchCommand(program);
  await program.parseAsync(["scratch", "job-1", ...args], { from: "user" });
}
const result = { ok: true, scratch: null, currentRevision: 3, maxBytes: 1024 };
beforeEach(() => {
  callGatewayFromCli.mockReset().mockImplementation(async (method: string) =>
    method === "cron.scratch.get"
      ? {
          scratch: { content: "note", revision: 2, updatedAtMs: 1 },
          currentRevision: 2,
          maxBytes: 1024,
        }
      : result,
  );
  vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("cron scratch", () => {
  it("uses the read revision for an implicit CAS write and prints JSON", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const json = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
    await run(["--set", "new note"]);
    expect(json).toHaveBeenCalledExactlyOnceWith(result);
    expect(stdout).not.toHaveBeenCalled();
    expect(callGatewayFromCli.mock.calls.map(([method]) => method)).toEqual([
      "cron.scratch.get",
      "cron.scratch.set",
    ]);
    expect(callGatewayFromCli.mock.calls[1]?.[2]).toEqual({
      id: "job-1",
      content: "new note",
      expectedRevision: 2,
    });
  });

  it("rejects non-decimal revisions after reading but before writing", async () => {
    await expect(run(["--set", "x", "--expected-revision", "0x2"])).rejects.toMatchObject({
      name: "ExitError",
      code: 1,
    });
    expect(defaultRuntime.error).toHaveBeenCalledWith(
      expect.stringContaining("--expected-revision must be a non-negative integer"),
    );
    expect(callGatewayFromCli).toHaveBeenCalledExactlyOnceWith(
      "cron.scratch.get",
      expect.anything(),
      { id: "job-1" },
    );
  });

  it.each([
    ["0", ["--set", "x"], "x"],
    ["42", ["--unset", "--json"], null],
  ] as const)("writes at explicit revision %s without a read", async (revision, args, content) => {
    await run([...args, "--expected-revision", revision]);
    expect(callGatewayFromCli).toHaveBeenCalledExactlyOnceWith(
      "cron.scratch.set",
      expect.anything(),
      { id: "job-1", content, expectedRevision: Number(revision) },
    );
  });

  it("reports revision conflicts without rereading or retrying", async () => {
    callGatewayFromCli.mockResolvedValue({
      ok: false,
      reason: "revision-conflict",
      currentRevision: 43,
    });
    await expect(run(["--unset", "--expected-revision", "42"])).rejects.toMatchObject({
      name: "ExitError",
      code: 1,
    });
    expect(defaultRuntime.error).toHaveBeenCalledWith(
      expect.stringContaining("cron scratch changed concurrently (current revision 43)"),
    );
    expect(callGatewayFromCli).toHaveBeenCalledExactlyOnceWith(
      "cron.scratch.set",
      expect.anything(),
      { id: "job-1", content: null, expectedRevision: 42 },
    );
  });

  it.each([
    ["invalid revision", ["--set", "x", "--expected-revision", "invalid"]],
    ["file input", ["--file", "missing-scratch-file", "--expected-revision", "42"]],
    [
      "oversized inline input",
      ["--set", "x".repeat(CRON_JOB_SCRATCH_MAX_BYTES + 1), "--expected-revision", "42"],
    ],
  ])("reports Gateway errors before consuming %s", async (_label, args) => {
    callGatewayFromCli.mockRejectedValue(new Error("Gateway unavailable"));
    await expect(run(args)).rejects.toMatchObject({ name: "ExitError", code: 1 });
    expect(defaultRuntime.error).toHaveBeenCalledWith(
      expect.stringContaining("Gateway unavailable"),
    );
    expect(callGatewayFromCli).toHaveBeenCalledExactlyOnceWith(
      "cron.scratch.get",
      expect.anything(),
      { id: "job-1" },
    );
  });
});
