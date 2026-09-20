import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi, type Mock } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";

export function registerDoctorBootstrapRecoveryTests(
  read: () => {
    runCli: typeof import("./run-main.js").runCli;
    tryRouteCliMock: Mock;
    readSourceConfigBestEffortMock: Mock;
    loadConfigMock: Mock;
    startProxyMock: Mock;
    outputPrecomputedSubcommandHelpTextMock: Mock;
    buildProgramMock: Mock;
    prepareDoctorUpdateRecoveryMock: Mock;
    withDoctorUpdateRecoveryMock: Mock;
    guardUpdateDoctorSchemaUpgradeMock: Mock;
    initializeDebugProxyCaptureMock: Mock;
    isCurrentRuntimeSupportedMock: Mock;
  },
) {
  it.each([
    ["root command", ["node", "openclaw", "update", "--dry-run", "--json"]],
    ["root shorthand", ["node", "openclaw", "--update", "--dry-run", "--json"]],
  ])("reads source-only proxy config for the update dry-run %s", async (_name, argv) => {
    read().tryRouteCliMock.mockResolvedValueOnce(true);
    read().readSourceConfigBestEffortMock.mockResolvedValueOnce({ proxy: { selected: "dry-run" } });

    await read().runCli(argv);

    expect(read().readSourceConfigBestEffortMock).toHaveBeenCalledOnce();
    expect(read().loadConfigMock).not.toHaveBeenCalled();
    expect(read().startProxyMock).toHaveBeenCalledWith({ selected: "dry-run" });
  });

  it("reads source-only proxy config for mutable updates", async () => {
    read().tryRouteCliMock.mockResolvedValueOnce(true);

    await read().runCli(["node", "openclaw", "update"]);

    expect(read().readSourceConfigBestEffortMock).toHaveBeenCalledOnce();
    expect(read().loadConfigMock).not.toHaveBeenCalled();
    expect(read().startProxyMock).toHaveBeenCalledWith(undefined);
  });

  it.each([
    ["lint", ["--lint", "--json"]],
    ["repair", ["--fix", "--non-interactive"]],
    ["diagnosis", []],
  ])("reads source-only proxy config before Doctor %s owns state access", async (_mode, args) => {
    read().tryRouteCliMock.mockResolvedValueOnce(true);
    read().readSourceConfigBestEffortMock.mockResolvedValueOnce({ proxy: { selected: "doctor" } });
    read().loadConfigMock.mockImplementation(() => {
      throw new Error("Shared state requires Doctor repair");
    });

    await read().runCli(["node", "openclaw", "doctor", ...args]);

    expect(read().readSourceConfigBestEffortMock).toHaveBeenCalledOnce();
    expect(read().loadConfigMock).not.toHaveBeenCalled();
    expect(read().startProxyMock).toHaveBeenCalledWith({ selected: "doctor" });
  });

  it.each([
    ["explicit lint", ["--lint", "--json"]],
    ["bare JSON", ["--json"]],
    ["rejected JSON fix", ["--fix", "--json"]],
    ["rejected JSON repair", ["--repair", "--json"]],
    ["rejected JSON yes", ["--yes", "--json"]],
    ["post-upgrade probes", ["--post-upgrade", "--json"]],
    ["session inspection", ["--session-sqlite", "inspect", "--json"]],
    ["session validation", ["--session-sqlite", "validate", "--json"]],
    ["session dry run", ["--session-sqlite=dry-run", "--json"]],
    ["help", ["--help"]],
    ["version", ["--version"]],
  ])("does not acquire update state ownership for read-only Doctor %s", async (_name, args) => {
    if (_name === "help") {
      read().outputPrecomputedSubcommandHelpTextMock.mockReturnValueOnce(true);
    } else if (_name === "version") {
      read().buildProgramMock.mockReturnValueOnce({
        commands: [{ name: () => "doctor", aliases: () => [] }],
        parseAsync: vi.fn(async () => {}),
      });
    } else {
      read().tryRouteCliMock.mockResolvedValueOnce(true);
    }
    await withEnvAsync(
      { OPENCLAW_UPDATE_IN_PROGRESS: "1", OPENCLAW_DEBUG_PROXY_ENABLED: "1" },
      () => read().runCli(["node", "openclaw", "doctor", ...args]),
    );
    expect(read().prepareDoctorUpdateRecoveryMock).not.toHaveBeenCalled();
    expect(read().withDoctorUpdateRecoveryMock).not.toHaveBeenCalled();
    expect(read().guardUpdateDoctorSchemaUpgradeMock).not.toHaveBeenCalled();
    expect(read().initializeDebugProxyCaptureMock).not.toHaveBeenCalled();
    expect(read().loadConfigMock).not.toHaveBeenCalled();
  });

  it("does not acquire update state ownership when unsupported Node routes Doctor to lint", async () => {
    read().isCurrentRuntimeSupportedMock.mockResolvedValue(false);
    read().tryRouteCliMock.mockResolvedValueOnce(true);
    await withEnvAsync(
      { OPENCLAW_UPDATE_IN_PROGRESS: "1", OPENCLAW_DEBUG_PROXY_ENABLED: "1" },
      () => read().runCli(["node", "openclaw", "doctor"]),
    );
    expect(read().prepareDoctorUpdateRecoveryMock).not.toHaveBeenCalled();
    expect(read().withDoctorUpdateRecoveryMock).not.toHaveBeenCalled();
    expect(read().guardUpdateDoctorSchemaUpgradeMock).not.toHaveBeenCalled();
    expect(read().initializeDebugProxyCaptureMock).not.toHaveBeenCalled();
    expect(read().loadConfigMock).not.toHaveBeenCalled();
  });

  it("passes the driver's recovery reference before Doctor bootstrap writes", async () => {
    read().tryRouteCliMock.mockResolvedValueOnce(true);
    const reference = JSON.stringify({
      directory: "/var/tmp/openclaw-fixture/backup",
      manifestPath: "/var/tmp/openclaw-fixture/backup/manifest.json",
      manifestSha256: "a".repeat(64),
    });
    await withEnvAsync({ OPENCLAW_UPDATE_IN_PROGRESS: "1" }, () =>
      read().runCli([
        "node",
        "openclaw",
        "doctor",
        "--fix",
        "--update-recovery-owner=driver",
        `--update-recovery-backup=${reference}`,
      ]),
    );
    expect(read().prepareDoctorUpdateRecoveryMock).toHaveBeenCalledWith(
      expect.objectContaining({ updateRecoveryOwner: "driver", updateRecoveryBackup: reference }),
    );
  });

  it.each([
    ["repair", ["--fix", "--non-interactive"]],
    ["state compaction", ["--state-sqlite=compact", "--json"]],
    ["session import", ["--session-sqlite", "import", "--json"]],
  ])("prepares state recovery before an updating Doctor %s", async (_name, args) => {
    read().tryRouteCliMock.mockResolvedValueOnce(true);
    await withEnvAsync(
      { OPENCLAW_UPDATE_IN_PROGRESS: "1", OPENCLAW_DEBUG_PROXY_ENABLED: "1" },
      () => read().runCli(["node", "openclaw", "doctor", ...args]),
    );
    expect(read().prepareDoctorUpdateRecoveryMock).toHaveBeenCalledOnce();
    expect(read().withDoctorUpdateRecoveryMock).toHaveBeenCalledOnce();
    expect(read().guardUpdateDoctorSchemaUpgradeMock).toHaveBeenCalledOnce();
    expect(read().initializeDebugProxyCaptureMock).toHaveBeenCalledOnce();
    expect(read().prepareDoctorUpdateRecoveryMock.mock.invocationCallOrder[0]).toBeLessThan(
      expectDefined(
        read().guardUpdateDoctorSchemaUpgradeMock.mock.invocationCallOrder[0],
        "Doctor schema guard invocation",
      ),
    );
  });
}
