import { describe, expect, it, type Mock } from "vitest";
import type {
  ConfigCliSnapshotReader,
  ConfigCliWriter,
} from "./config-cli.snapshot.test-support.js";

type JsonOutputFixture = {
  runConfigCommand: (args: string[]) => Promise<void>;
  mockReadConfigFileSnapshot: Mock<ConfigCliSnapshotReader>;
  mockWriteConfigFile: Mock<ConfigCliWriter>;
  mockLog: Mock;
  parseLastLogPayload: () => unknown;
  expectErrorIncludes: (text: string) => void;
  ExitError: new (code: number, message?: string) => Error;
};

export function registerConfigJsonOutputTests(fixture: () => JsonOutputFixture) {
  describe("config JSON output", () => {
    it("keeps --json as a strict parsing alias", async () => {
      const {
        runConfigCommand,
        mockReadConfigFileSnapshot,
        mockWriteConfigFile,
        mockLog,
        expectErrorIncludes,
        ExitError,
      } = fixture();

      await expect(
        runConfigCommand(["config", "set", "gateway.auth.mode", "{bad", "--json"]),
      ).rejects.toThrow(ExitError);

      expect(mockWriteConfigFile).not.toHaveBeenCalled();
      expect(mockReadConfigFileSnapshot).not.toHaveBeenCalled();
      expect(mockLog).not.toHaveBeenCalled();
      expectErrorIncludes('Could not parse "{bad" as JSON for --strict-json.');
    });

    it.each([
      {
        name: "config patch --json without dry-run",
        args: ["config", "patch", "--stdin", "--json"],
        message: "config patch mode error: --json requires --dry-run.",
      },
      {
        name: "config unset --json without --dry-run",
        args: ["config", "unset", "browser.enabled", "--json"],
        message: "--json can only be used with --dry-run.",
      },
    ])("rejects $name", async ({ args, message }) => {
      const {
        runConfigCommand,
        mockReadConfigFileSnapshot,
        mockWriteConfigFile,
        mockLog,
        parseLastLogPayload,
        expectErrorIncludes,
        ExitError,
      } = fixture();

      await expect(runConfigCommand(args)).rejects.toThrow(ExitError);

      expect(mockReadConfigFileSnapshot).not.toHaveBeenCalled();
      expect(mockWriteConfigFile).not.toHaveBeenCalled();
      expectErrorIncludes(message);
      expect(mockLog).toHaveBeenCalledTimes(1);
      expect(parseLastLogPayload()).toEqual({
        ok: false,
        error: { type: "cli_error", message },
      });
    });
  });
}
