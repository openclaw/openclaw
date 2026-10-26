import { describe, expect, it, type Mock } from "vitest";
import type { ConfigFileSnapshot, OpenClawConfig } from "../config/types.js";
import { expectNoCalls } from "../test-utils/mock-call-assertions.js";
import type {
  ConfigCliSnapshotReader,
  ConfigCliWriter,
} from "./config-cli.snapshot.test-support.js";
import { getMockCallOutput } from "./test-runtime-capture.js";

type JsonOutputFixture = {
  buildSnapshot: (params: {
    resolved: OpenClawConfig;
    config: OpenClawConfig;
  }) => ConfigFileSnapshot;
  mockError: Mock;
  mockExit: Mock;
  resetRuntimeCapture: () => void;
  runConfigCommand: (args: string[]) => Promise<void>;
  mockReadConfigFileSnapshot: Mock<ConfigCliSnapshotReader>;
  mockWriteConfigFile: Mock<ConfigCliWriter>;
  mockLog: Mock;
  parseLastLogPayload: () => unknown;
  expectErrorIncludes: (text: string) => void;
  ExitError: new (code: number, message?: string) => Error;
};

export function registerConfigJsonOutputTests(fixture: () => JsonOutputFixture) {
  describe("config validation output", () => {
    it.each([
      { state: "valid", exists: true, valid: true, heading: "Config valid:" },
      { state: "missing", exists: false, valid: false, heading: "Config file not found:" },
      { state: "invalid", exists: true, valid: false, heading: "Config needs correction:" },
    ])("escapes $state report paths while preserving JSON paths", async (row) => {
      const {
        buildSnapshot,
        runConfigCommand,
        mockReadConfigFileSnapshot,
        mockWriteConfigFile,
        mockLog,
        mockError,
        resetRuntimeCapture,
        parseLastLogPayload,
        ExitError,
      } = fixture();
      const configPath = "/tmp/café\u001b[31m\noperator-forged\tend\rrow\u0007.json";
      mockReadConfigFileSnapshot.mockResolvedValue({
        ...buildSnapshot({ resolved: {}, config: {} }),
        path: configPath,
        exists: row.exists,
        valid: row.valid,
      });
      const run = (json: boolean) =>
        runConfigCommand(["config", "validate", ...(json ? ["--json"] : [])]);

      if (row.valid) {
        await run(false);
      } else {
        await expect(run(false)).rejects.toThrow(ExitError);
      }
      const output = getMockCallOutput(row.valid ? mockLog : mockError);
      expect(output).toContain(`${row.heading} /tmp/café\\noperator-forged\\tend\\rrow.json`);
      expect(output.replaceAll("\n", "")).not.toMatch(/\p{Cc}/u);
      resetRuntimeCapture();
      if (row.valid) {
        await run(true);
      } else {
        await expect(run(true)).rejects.toThrow(ExitError);
      }
      expect(parseLastLogPayload()).toMatchObject({ path: configPath, valid: row.valid });
      expect(mockWriteConfigFile).not.toHaveBeenCalled();
      if (row.state === "invalid") {
        resetRuntimeCapture();
        await expect(runConfigCommand(["config", "get", "gateway.mode"])).rejects.toThrow(
          ExitError,
        );
        expect(getMockCallOutput(mockError)).toContain(
          "/tmp/café\\noperator-forged\\tend\\rrow.json",
        );
        expect(getMockCallOutput(mockError).replaceAll("\n", "")).not.toMatch(/\p{Cc}/u);
      }
    });

    it("prints warnings while still reporting a valid config", async () => {
      const {
        buildSnapshot,
        runConfigCommand,
        mockReadConfigFileSnapshot,
        mockLog,
        mockError,
        mockExit,
      } = fixture();
      mockReadConfigFileSnapshot.mockResolvedValueOnce({
        ...buildSnapshot({ resolved: {}, config: {} }),
        warnings: [
          {
            path: "channels.mattermost.allowFrom",
            message:
              'channels.mattermost.dmPolicy="open" but channels.mattermost.allowFrom does not include "*"; all DMs will be dropped.',
          },
        ],
      });

      await runConfigCommand(["config", "validate"]);

      expectNoCalls(mockExit, mockError);
      expect(getMockCallOutput(mockLog)).toContain("Config valid:");
      expect(getMockCallOutput(mockLog)).toContain("channels.mattermost.allowFrom");
      expect(getMockCallOutput(mockLog)).toContain("all DMs will be dropped");
    });
  });

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
