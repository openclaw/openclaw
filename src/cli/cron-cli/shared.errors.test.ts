import { describe, expect, it, vi } from "vitest";
import { GatewayClientRequestError } from "../../gateway/client.js";
import { defaultRuntime } from "../../runtime.js";
import {
  ExpectedCliError,
  formatCliFailureLines,
  formatCliJsonFailure,
} from "../failure-output.js";
import { CronCliError } from "./cron-cli-error.js";
import { handleCronCliError } from "./shared.js";

describe("handleCronCliError", () => {
  it("renders typed automation lookup misses with the cron list recovery command", () => {
    const error = new GatewayClientRequestError({
      code: "INVALID_REQUEST",
      message: "transport-neutral lookup miss",
      details: { code: "CRON_JOB_NOT_FOUND", jobId: "missing-job" },
    });
    const errorOutput = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
    const exit = vi.spyOn(defaultRuntime, "exit").mockImplementation(((code: number) => {
      throw new Error(`exit ${code}`);
    }) as never);

    expect(() => handleCronCliError(error)).toThrow("exit 1");
    expect(errorOutput).toHaveBeenCalledWith(
      expect.stringContaining(
        "Automation not found: missing-job. Run `openclaw cron list` to see recent automation ids.",
      ),
    );
    errorOutput.mockRestore();
    exit.mockRestore();
  });

  it.each([
    {
      label: "typed lookup miss",
      error: new GatewayClientRequestError({
        code: "INVALID_REQUEST",
        message: "transport-neutral lookup miss",
        details: { code: "CRON_JOB_NOT_FOUND", jobId: "missing-job" },
      }),
      message:
        "Automation not found: missing-job. Run `openclaw cron list` to see recent automation ids.",
    },
    {
      label: "local validation failure",
      error: new CronCliError("Invalid --stagger; use e.g. 30s, 1m, 5m"),
      message: "Invalid --stagger; use e.g. 30s, 1m, 5m",
    },
  ])(
    "hands a $label to the root renderer as an expected machine-output failure",
    ({ error, message }) => {
      const argv = process.argv;
      process.argv = [...argv.slice(0, 2), "cron", "show", "missing-job", "--json"];
      try {
        let thrown: unknown;
        try {
          handleCronCliError(error);
        } catch (caught) {
          thrown = caught;
        }
        expect(thrown).toBeInstanceOf(ExpectedCliError);
        expect(formatCliJsonFailure(thrown)).toEqual({
          ok: false,
          error: { type: "cli_error", message },
        });
        const stderr = formatCliFailureLines({
          title: "Could not start the CLI.",
          error: thrown,
          argv: process.argv,
        }).join("\n");
        expect(stderr).toContain(message);
        expect(stderr).not.toContain("Could not start the CLI.");
        expect(stderr).not.toContain("openclaw doctor");
        expect(stderr).not.toContain("OPENCLAW_DEBUG");
      } finally {
        process.argv = argv;
      }
    },
  );

  // A legacy gateway without cron.get makes `cron edit <id> --exact` wrap the
  // lookup miss; the renderer only reveals such causes on explicit debug intent.
  it.each([
    {
      label: "stays terse without debug intent",
      flags: [] as string[],
      debug: "",
      causeShown: false,
    },
    { label: "keeps causes for --debug", flags: ["--debug"], debug: "", causeShown: true },
    { label: "keeps causes for OPENCLAW_DEBUG", flags: [], debug: "1", causeShown: true },
  ])("machine output for a wrapped cron failure $label", ({ flags, debug, causeShown }) => {
    const wrapped = new CronCliError("unknown automation id: missing-job", {
      cause: new Error("unknown method: cron.get"),
    });
    const argv = process.argv;
    process.argv = [
      ...argv.slice(0, 2),
      "cron",
      "edit",
      "missing-job",
      "--exact",
      "--json",
      ...flags,
    ];
    vi.stubEnv("OPENCLAW_DEBUG", debug);
    try {
      let thrown: unknown;
      try {
        handleCronCliError(wrapped);
      } catch (caught) {
        thrown = caught;
      }
      expect(thrown).toBeInstanceOf(ExpectedCliError);
      const machineMessage = formatCliJsonFailure(thrown).error.message;
      expect(machineMessage).toContain("unknown automation id: missing-job");
      expect(machineMessage.includes("unknown method: cron.get")).toBe(causeShown);
      const stderr = formatCliFailureLines({
        title: "The CLI command failed.",
        error: thrown,
      }).join("\n");
      expect(stderr).toContain("unknown automation id: missing-job");
      expect(stderr.includes("unknown method: cron.get")).toBe(causeShown);
    } finally {
      vi.unstubAllEnvs();
      process.argv = argv;
    }
  });

  it.each([false, true])("preserves unexpected machine-mode errors with debug=%s", (debug) => {
    const error = new Error("Automation runtime failed", {
      cause: new Error("Runtime load failed"),
    });
    const argv = process.argv;
    process.argv = [...argv.slice(0, 2), "automations", "status", "--json"];
    vi.stubEnv("OPENCLAW_DEBUG", debug ? "1" : "");
    try {
      let thrown: unknown;
      try {
        handleCronCliError(error);
      } catch (caught) {
        thrown = caught;
      }
      expect(thrown).toBe(error);
      const stderr = formatCliFailureLines({
        title: "The CLI command failed.",
        error: thrown,
      }).join("\n");
      expect(stderr).toContain("The CLI command failed.");
      expect(stderr).toContain("openclaw doctor");
      expect(stderr.includes("Stack:")).toBe(debug);
      expect(formatCliJsonFailure(thrown).error.message.includes("Runtime load failed")).toBe(
        debug,
      );
    } finally {
      vi.unstubAllEnvs();
      process.argv = argv;
    }
  });
});
