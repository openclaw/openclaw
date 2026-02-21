import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCliRuntimeCapture } from "./test-runtime-capture.js";

const callGatewayFromCli = vi.fn();
const runSecretsMigration = vi.fn();
const rollbackSecretsMigration = vi.fn();

const { defaultRuntime, runtimeLogs, runtimeErrors, resetRuntimeCapture } =
  createCliRuntimeCapture();

vi.mock("./gateway-rpc.js", () => ({
  addGatewayClientOptions: (cmd: Command) => cmd,
  callGatewayFromCli: (method: string, opts: unknown, params?: unknown, extra?: unknown) =>
    callGatewayFromCli(method, opts, params, extra),
}));

vi.mock("../runtime.js", () => ({
  defaultRuntime,
}));

vi.mock("../secrets/migrate.js", () => ({
  runSecretsMigration: (options: unknown) => runSecretsMigration(options),
  rollbackSecretsMigration: (options: unknown) => rollbackSecretsMigration(options),
}));

const { registerSecretsCli } = await import("./secrets-cli.js");

describe("secrets CLI", () => {
  const createProgram = () => {
    const program = new Command();
    program.exitOverride();
    registerSecretsCli(program);
    return program;
  };

  beforeEach(() => {
    resetRuntimeCapture();
    callGatewayFromCli.mockReset();
    runSecretsMigration.mockReset();
    rollbackSecretsMigration.mockReset();
  });

  it("calls secrets.reload and prints human output", async () => {
    callGatewayFromCli.mockResolvedValue({ ok: true, warningCount: 1 });
    await createProgram().parseAsync(["secrets", "reload"], { from: "user" });
    expect(callGatewayFromCli).toHaveBeenCalledWith(
      "secrets.reload",
      expect.anything(),
      undefined,
      expect.objectContaining({ expectFinal: false }),
    );
    expect(runtimeLogs.at(-1)).toBe("Secrets reloaded with 1 warning(s).");
    expect(runtimeErrors).toHaveLength(0);
  });

  it("prints JSON when requested", async () => {
    callGatewayFromCli.mockResolvedValue({ ok: true, warningCount: 0 });
    await createProgram().parseAsync(["secrets", "reload", "--json"], { from: "user" });
    expect(runtimeLogs.at(-1)).toContain('"ok": true');
  });

  it("runs secrets migrate as dry-run by default", async () => {
    runSecretsMigration.mockResolvedValue({
      mode: "dry-run",
      changed: true,
      secretsFilePath: "/tmp/secrets.enc.json",
      counters: { secretsWritten: 3 },
      changedFiles: ["/tmp/openclaw.json"],
    });

    await createProgram().parseAsync(["secrets", "migrate"], { from: "user" });

    expect(runSecretsMigration).toHaveBeenCalledWith(
      expect.objectContaining({ write: false, scrubEnv: true }),
    );
    expect(runtimeLogs.at(-1)).toContain("dry run");
  });

  it("runs rollback when --rollback is provided", async () => {
    rollbackSecretsMigration.mockResolvedValue({
      backupId: "20260221T010203Z",
      restoredFiles: 2,
      deletedFiles: 1,
    });

    await createProgram().parseAsync(["secrets", "migrate", "--rollback", "20260221T010203Z"], {
      from: "user",
    });

    expect(rollbackSecretsMigration).toHaveBeenCalledWith({
      backupId: "20260221T010203Z",
    });
    expect(runtimeLogs.at(-1)).toContain("rollback complete");
  });
});
