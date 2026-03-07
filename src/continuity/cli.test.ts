import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultRuntime } from "../runtime.js";
import { registerContinuityCli } from "./cli.js";
import type { ContinuityService } from "./service.js";

function makeProgram(service: Partial<ContinuityService>) {
  const program = new Command();
  program.exitOverride();
  registerContinuityCli({
    program,
    ensureService: () => service as ContinuityService,
  });
  return program;
}

describe("registerContinuityCli", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prints string status payloads without forcing json formatting", async () => {
    const logSpy = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    const service = {
      status: vi.fn().mockResolvedValue("ready"),
    };
    const program = makeProgram(service);

    await program.parseAsync(["continuity", "status"], { from: "user" });

    expect(service.status).toHaveBeenCalledWith(undefined);
    expect(logSpy).toHaveBeenCalledWith("ready");
  });

  it("passes parsed review filters through and prints json when requested", async () => {
    const logSpy = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    const records = [{ id: "cont_1", reviewState: "approved" }];
    const service = {
      list: vi.fn().mockResolvedValue(records),
    };
    const program = makeProgram(service);

    await program.parseAsync(
      [
        "continuity",
        "review",
        "--agent",
        "alpha",
        "--state",
        "approved",
        "--kind",
        "decision",
        "--source",
        "paired_direct",
        "--limit",
        "7",
        "--json",
      ],
      { from: "user" },
    );

    expect(service.list).toHaveBeenCalledWith({
      agentId: "alpha",
      filters: {
        state: "approved",
        kind: "decision",
        sourceClass: "paired_direct",
        limit: 7,
      },
    });
    expect(logSpy).toHaveBeenCalledWith(JSON.stringify(records, null, 2));
  });

  it("falls back to the default review limit when the CLI receives an invalid number", async () => {
    const service = {
      list: vi.fn().mockResolvedValue([]),
    };
    const program = makeProgram(service);

    await program.parseAsync(["continuity", "review", "--limit", "not-a-number", "--json"], {
      from: "user",
    });

    expect(service.list).toHaveBeenCalledWith({
      agentId: undefined,
      filters: {
        state: "pending",
        kind: "all",
        sourceClass: "all",
        limit: 50,
      },
    });
  });

  it.each([
    ["approve", "approve"],
    ["reject", "reject"],
    ["rm", "remove"],
  ])("invokes %s with the expected patch action", async (commandName, action) => {
    const logSpy = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    const service = {
      patch: vi.fn().mockResolvedValue({ ok: true, removedId: "cont_1" }),
    };
    const program = makeProgram(service);

    await program.parseAsync(["continuity", commandName, "cont_1", "--agent", "alpha"], {
      from: "user",
    });

    expect(service.patch).toHaveBeenCalledWith({
      agentId: "alpha",
      id: "cont_1",
      action,
    });
    expect(logSpy).toHaveBeenCalledWith(JSON.stringify({ ok: true, removedId: "cont_1" }, null, 2));
  });
});
