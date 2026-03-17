import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCliRuntimeCapture } from "./test-runtime-capture.js";

const loadConfig = vi.fn(() => ({ gateway: {} }));
const runSecurityAudit = vi.fn(async () => ({
  summary: { critical: 0, warn: 1, info: 2 },
  findings: [],
}));
const fixSecurityFootguns = vi.fn(async () => ({
  changes: [],
  actions: [],
  errors: [],
}));
const routeLogsToStderr = vi.fn();

const { defaultRuntime } = createCliRuntimeCapture();

vi.mock("../config/config.js", () => ({
  loadConfig: () => loadConfig(),
}));

vi.mock("../logging/console.js", () => ({
  routeLogsToStderr: () => routeLogsToStderr(),
}));

vi.mock("../runtime.js", () => ({
  defaultRuntime,
}));

vi.mock("../security/audit.js", () => ({
  runSecurityAudit: (opts: unknown) => runSecurityAudit(opts),
}));

vi.mock("../security/fix.js", () => ({
  fixSecurityFootguns: () => fixSecurityFootguns(),
}));

const { registerSecurityCli } = await import("./security-cli.js");

let program: Command;

function createProgram() {
  const next = new Command();
  next.exitOverride();
  registerSecurityCli(next);
  return next;
}

describe("security-cli --json", () => {
  beforeEach(() => {
    program = createProgram();
    loadConfig.mockClear();
    runSecurityAudit.mockClear();
    fixSecurityFootguns.mockClear();
    routeLogsToStderr.mockClear();
  });

  it("routes incidental logs to stderr and writes clean JSON to stdout", async () => {
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await program.parseAsync(["security", "audit", "--json"], { from: "user" });

    expect(routeLogsToStderr).toHaveBeenCalledTimes(1);
    expect(loadConfig).toHaveBeenCalledTimes(1);
    expect(runSecurityAudit).toHaveBeenCalledTimes(1);
    expect(stdoutWrite).toHaveBeenCalledTimes(1);
    const payload = String(stdoutWrite.mock.calls[0]?.[0] ?? "");
    expect(() => JSON.parse(payload)).not.toThrow();
    expect(JSON.parse(payload)).toEqual({
      summary: { critical: 0, warn: 1, info: 2 },
      findings: [],
    });

    stdoutWrite.mockRestore();
  });
});
