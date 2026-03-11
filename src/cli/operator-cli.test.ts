import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCliRuntimeCapture } from "./test-runtime-capture.js";

const operatorBootstrap = vi.fn();
const operatorPulse = vi.fn();
const operatorStatus = vi.fn();
const operatorStartTicket = vi.fn();
const operatorNextTicket = vi.fn();
const operatorRecommendNext = vi.fn();
const operatorRequestReview = vi.fn();
const operatorSpotCheck = vi.fn();
const operatorPauseAll = vi.fn();
const operatorResumeAll = vi.fn();
const operatorStopAll = vi.fn();

const { runtimeLogs, runtimeErrors, defaultRuntime, resetRuntimeCapture } =
  createCliRuntimeCapture();

vi.mock("../operator-harness/harness.js", () => ({
  operatorBootstrap,
  operatorPulse,
  operatorStatus,
  operatorStartTicket,
  operatorNextTicket,
  operatorRecommendNext,
  operatorRequestReview,
  operatorSpotCheck,
  operatorPauseAll,
  operatorResumeAll,
  operatorStopAll,
}));

vi.mock("../runtime.js", () => ({
  defaultRuntime,
}));

const { registerOperatorCli } = await import("./operator-cli.js");

describe("operator-cli", () => {
  async function runCli(args: string[]) {
    const program = new Command();
    registerOperatorCli(program);
    try {
      await program.parseAsync(args, { from: "user" });
    } catch (err) {
      if (!(err instanceof Error && err.message.startsWith("__exit__:"))) {
        throw err;
      }
    }
  }

  beforeEach(() => {
    vi.clearAllMocks();
    resetRuntimeCapture();
  });

  it("passes parent config to status", async () => {
    await runCli(["operator", "--config", "/tmp/operator.json", "status"]);
    expect(operatorStatus).toHaveBeenCalledWith("/tmp/operator.json", defaultRuntime, false);
  });

  it("supports pulse in json mode", async () => {
    await runCli(["operator", "--json", "pulse"]);
    expect(operatorPulse).toHaveBeenCalledWith(undefined, defaultRuntime, true);
  });

  it("passes ticket args to start-ticket", async () => {
    await runCli(["operator", "start-ticket", "END-9"]);
    expect(operatorStartTicket).toHaveBeenCalledWith(undefined, "END-9", defaultRuntime);
  });

  it("reports runtime errors", async () => {
    operatorPauseAll.mockRejectedValueOnce(new Error("boom"));
    await runCli(["operator", "pause-all"]);
    expect(runtimeErrors[0]).toContain("boom");
  });

  it("supports json status mode", async () => {
    await runCli(["operator", "--json", "status"]);
    expect(operatorStatus).toHaveBeenCalledWith(undefined, defaultRuntime, true);
    expect(runtimeLogs).toEqual([]);
  });

  it("supports recommend-next in json mode", async () => {
    await runCli(["operator", "--json", "recommend-next"]);
    expect(operatorRecommendNext).toHaveBeenCalledWith(undefined, defaultRuntime, true);
  });
});
