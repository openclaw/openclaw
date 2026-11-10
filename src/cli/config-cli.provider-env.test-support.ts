import { expect, it, type Mock } from "vitest";
import type { OpenClawConfig } from "../config/types.js";

type ProviderEnvFixture = {
  runConfigSet: (...args: string[]) => Promise<void>;
  setGatewaySnapshot: () => void;
  createProviderCommand: () => string;
  firstWrittenConfig: () => OpenClawConfig;
  mockReadConfigFileSnapshot: Mock;
  mockWriteConfigFile: Mock;
  mockLog: Mock;
  mockWriteStdout: Mock;
  mockError: Mock;
  expectErrorIncludes: (text: string) => void;
  ExitError: new (code: number, message?: string) => Error;
};

export function registerProviderEnvTests(fixture: () => ProviderEnvFixture) {
  it("preserves normal provider env keys and literal values", async () => {
    const { runConfigSet, setGatewaySnapshot, createProviderCommand, firstWrittenConfig } =
      fixture();
    setGatewaySnapshot();
    const command = createProviderCommand();
    await runConfigSet(
      "secrets.providers.runner",
      "--provider-source",
      "exec",
      "--provider-command",
      command,
      "--provider-env",
      " NORMAL_KEY =one=two",
      "--provider-env",
      "EMPTY=",
    );
    expect(firstWrittenConfig().secrets?.providers?.runner).toEqual({
      source: "exec",
      command,
      env: { NORMAL_KEY: "one=two", EMPTY: "" },
    });
  });

  it.each(["__proto__", "constructor", "prototype"])(
    "rejects reserved provider env key %s without disclosing its value",
    async (key) => {
      const {
        runConfigSet,
        mockReadConfigFileSnapshot,
        mockWriteConfigFile,
        mockError,
        expectErrorIncludes,
        ExitError,
      } = fixture();
      await expect(
        runConfigSet(
          "secrets.providers.runner",
          "--provider-source",
          "exec",
          "--provider-command",
          "/usr/bin/env",
          "--provider-env",
          ` ${key} =SYNTHETIC_SECRET`,
          "--dry-run",
        ),
      ).rejects.toThrow(ExitError);
      expect(mockReadConfigFileSnapshot).not.toHaveBeenCalled();
      expect(mockWriteConfigFile).not.toHaveBeenCalled();
      expectErrorIncludes(`--provider-env key "${key}" is reserved; use a different key name.`);
      expect(JSON.stringify(mockError.mock.calls)).not.toContain("SYNTHETIC_SECRET");
    },
  );

  it.each([
    ["leading equals", "=SYNTHETIC_PROVIDER_ENV_SECRET", "--provider-env entries must use KEY=***"],
    [
      "whitespace key",
      "   =SYNTHETIC_PROVIDER_ENV_SECRET",
      "--provider-env entries must use a non-empty key.",
    ],
  ])("does not disclose provider env values for a %s entry", async (_name, entry, message) => {
    const {
      runConfigSet,
      mockReadConfigFileSnapshot,
      mockWriteConfigFile,
      mockLog,
      mockWriteStdout,
      mockError,
      expectErrorIncludes,
      ExitError,
    } = fixture();
    const secret = "SYNTHETIC_PROVIDER_ENV_SECRET";

    await expect(
      runConfigSet(
        "secrets.providers.runner",
        "--provider-source",
        "exec",
        "--provider-command",
        "/usr/bin/env",
        "--provider-env",
        entry,
        "--dry-run",
      ),
    ).rejects.toThrow(ExitError);

    expect(mockReadConfigFileSnapshot).not.toHaveBeenCalled();
    expect(mockWriteConfigFile).not.toHaveBeenCalled();
    expect(JSON.stringify(mockLog.mock.calls)).not.toContain(secret);
    expect(JSON.stringify(mockWriteStdout.mock.calls)).not.toContain(secret);
    expect(JSON.stringify(mockError.mock.calls)).not.toContain(secret);
    expectErrorIncludes(message);
  });
}
