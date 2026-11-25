import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSystemAgentTool,
  resolveSystemAgentProposalTransition,
  type SystemAgentToolOptions,
} from "./system-agent-tool.js";

const mocks = vi.hoisted(() => ({
  executeSystemAgentOperation: vi.fn(
    async (_op: unknown, runtime: { log: (m: string) => void }) => {
      runtime.log("op-output");
      return { applied: false };
    },
  ),
}));

vi.mock("../../system-agent/operations.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../system-agent/operations.js")>()),
  executeSystemAgentOperation: mocks.executeSystemAgentOperation,
}));

afterEach(() => {
  vi.clearAllMocks();
});

function toolText(result: unknown): string {
  const content = (result as { content: Array<{ type: string; text?: string }> }).content;
  return content
    .map((block) => block.text ?? "")
    .filter(Boolean)
    .join("\n");
}

function runFixture(options: Partial<SystemAgentToolOptions> = {}) {
  const proposalRef: NonNullable<SystemAgentToolOptions["proposalRef"]> = {};
  const directiveRef: NonNullable<SystemAgentToolOptions["directiveRef"]> = {};
  const staged = createSystemAgentTool({ surface: "cli", ...options, proposalRef, directiveRef });
  const armed = createSystemAgentTool({
    surface: "cli",
    ...options,
    proposalRef,
    directiveRef,
    approvalArmed: true,
  });
  const call = async (args: Record<string, unknown>, isArmed = false) =>
    toolText(await (isArmed ? armed : staged).execute("call", args));
  return { proposalRef, directiveRef, tool: staged, call };
}

const run = (argv: string[], extra: Record<string, unknown> = {}) => ({
  action: "run",
  argv,
  ...extra,
});

describe("openclaw tool run action", () => {
  it("runs a read immediately with no proposal", async () => {
    const { call, proposalRef, directiveRef } = runFixture();
    expect(await call(run(["status"]))).toBe("op-output");
    expect(mocks.executeSystemAgentOperation).toHaveBeenCalledWith(
      { kind: "run", argv: ["status"] },
      expect.anything(),
      expect.objectContaining({
        approved: false,
        deps: expect.objectContaining({ setupSurface: "cli" }),
      }),
    );
    expect(proposalRef.current).toBeUndefined();
    expect(directiveRef.current).toBeUndefined();
  });

  it("does not consume an armed proposal when run is called with approved=true", async () => {
    const { call, proposalRef, directiveRef } = runFixture();
    proposalRef.current = "a".repeat(64);
    expect(await call(run(["status"], { approved: true }), true)).toBe("op-output");
    expect(proposalRef.current).toBe("a".repeat(64));
    expect(directiveRef.current).toBeUndefined();
  });

  it("does not mirror a refused or read run as a staged proposal for out-of-process hosts", () => {
    expect(
      resolveSystemAgentProposalTransition({
        args: run(["status"]),
        resultText: "op-output",
      }),
    ).toBeNull();
    expect(
      resolveSystemAgentProposalTransition({
        args: run(["doctor", "--fix"]),
        resultText: "Run `openclaw setup` in a terminal",
      }),
    ).toBeNull();
  });

  it.each([
    [{ action: "run" }],
    [{ action: "run", argv: [] }],
    [{ action: "run", argv: ["status", 3] }],
    [{ action: "run", argv: ["status\0"] }],
    [{ action: "run", argv: "status" }],
  ])("rejects malformed run input %j", async (args) => {
    const { tool } = runFixture();
    await expect(tool.execute("call", args)).rejects.toThrow("run requires argv");
  });
});
