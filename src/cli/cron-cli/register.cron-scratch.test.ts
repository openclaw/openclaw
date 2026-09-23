// Cron scratch register tests cover cron scratch command option validation.
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

function createCronProgram(): Command {
  const program = new Command();
  program.exitOverride();
  registerCronScratchCommand(program);
  return program;
}

describe("cron scratch command", () => {
  beforeEach(() => {
    callGatewayFromCli.mockReset();
    callGatewayFromCli.mockImplementation(async (method: string) => {
      if (method === "cron.scratch.get") {
        return {
          scratch: { content: "note", revision: 2, updatedAtMs: 1 },
          currentRevision: 2,
          maxBytes: 1024,
        };
      }
      return { ok: true, scratch: null, currentRevision: 3, maxBytes: 1024 };
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ["without --json", ["--set", "new note"]],
    ["with --json", ["--unset", "--json"]],
  ])("prints the write result as JSON %s", async (_label, args) => {
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const writeJson = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});

    await createCronProgram().parseAsync(["scratch", "job-1", ...args], { from: "user" });

    expect(writeJson).toHaveBeenCalledWith({
      ok: true,
      scratch: null,
      currentRevision: 3,
      maxBytes: 1024,
    });
    expect(stdoutWrite).not.toHaveBeenCalled();
    expect(callGatewayFromCli.mock.calls.map(([method]) => method)).toEqual([
      "cron.scratch.get",
      "cron.scratch.set",
    ]);
    expect(callGatewayFromCli.mock.calls[1]?.[2]).toMatchObject({ expectedRevision: 2 });
  });

  it("documents the read/write JSON split", () => {
    const scratch = createCronProgram().commands.find((command) => command.name() === "scratch");
    const jsonOption = scratch?.options.find((option) => option.long === "--json");

    expect(jsonOption?.description).toBe(
      "Output scratch plus revision metadata as JSON; writes return JSON by default",
    );
    expect(jsonOption?.defaultValue).toBeUndefined();
  });

  it.each(["0x2", "1e2", "2.5", "-1", "2a"])(
    "rejects non-decimal --expected-revision %j",
    async (revision) => {
      const errorSpy = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});

      try {
        await expect(
          createCronProgram().parseAsync(
            ["scratch", "job-1", "--set", "x", "--expected-revision", revision],
            { from: "user" },
          ),
        ).rejects.toMatchObject({ name: "ExitError", code: 1 });

        expect(errorSpy).toHaveBeenCalledWith(
          expect.stringContaining("--expected-revision must be a non-negative integer"),
        );
        const setCalls = callGatewayFromCli.mock.calls.filter(
          ([method]) => method === "cron.scratch.set",
        );
        expect(setCalls).toHaveLength(0);
        expect(callGatewayFromCli).toHaveBeenCalledExactlyOnceWith(
          "cron.scratch.get",
          expect.anything(),
          { id: "job-1" },
        );
      } finally {
        errorSpy.mockRestore();
      }
    },
  );

  it.each([
    ["0", 0, ["--set", "x"], "x"],
    ["42", 42, ["--set", "x"], "x"],
    ["0", 0, ["--unset"], null],
    ["42", 42, ["--unset"], null],
  ])(
    "writes at explicit revision %j (%i) with %j without reading scratch",
    async (revision, expectedRevision, args, content) => {
      vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      await createCronProgram().parseAsync(
        ["scratch", "job-1", ...args, "--expected-revision", revision],
        { from: "user" },
      );

      expect(callGatewayFromCli).toHaveBeenCalledExactlyOnceWith(
        "cron.scratch.set",
        expect.anything(),
        { id: "job-1", content, expectedRevision },
      );
    },
  );

  it("reports an explicit revision conflict without rereading or retrying", async () => {
    callGatewayFromCli.mockResolvedValue({
      ok: false,
      reason: "revision-conflict",
      currentRevision: 43,
    });
    const errorSpy = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});

    await expect(
      createCronProgram().parseAsync(["scratch", "job-1", "--unset", "--expected-revision", "42"], {
        from: "user",
      }),
    ).rejects.toMatchObject({ name: "ExitError", code: 1 });

    expect(errorSpy).toHaveBeenCalledWith(
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
    ["stdin", ["--file", "-", "--expected-revision", "42"]],
    [
      "oversized inline input",
      ["--set", "x".repeat(CRON_JOB_SCRATCH_MAX_BYTES + 1), "--expected-revision", "42"],
    ],
  ])("reports Gateway errors before consuming %s", async (_label, args) => {
    callGatewayFromCli.mockRejectedValue(new Error("Gateway unavailable"));
    const errorSpy = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});

    await expect(
      createCronProgram().parseAsync(["scratch", "job-1", ...args], { from: "user" }),
    ).rejects.toMatchObject({ name: "ExitError", code: 1 });

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Gateway unavailable"));
    expect(callGatewayFromCli).toHaveBeenCalledExactlyOnceWith(
      "cron.scratch.get",
      expect.anything(),
      { id: "job-1" },
    );
  });
});
