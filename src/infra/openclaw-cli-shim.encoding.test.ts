import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withTempDir } from "../test-utils/temp-dir.js";
import {
  clearGatewayAgentCliShim,
  mergeGatewayAgentCliPath,
  prepareGatewayAgentCliShim,
} from "./openclaw-cli-shim.js";
import { decodeWindowsLauncherScript } from "./windows-launcher-encoding.js";

const resolveWindowsOemEncodingMock = vi.hoisted(() => vi.fn(() => "gbk"));
const resolveWindowsOemCodePageForEncodingMock = vi.hoisted(() => vi.fn(() => 936));

vi.mock("./windows-encoding.js", async () => {
  const actual =
    await vi.importActual<typeof import("./windows-encoding.js")>("./windows-encoding.js");
  return {
    ...actual,
    resolveWindowsOemEncoding: resolveWindowsOemEncodingMock,
    resolveWindowsOemCodePageForEncoding: resolveWindowsOemCodePageForEncodingMock,
  };
});

afterEach(() => {
  clearGatewayAgentCliShim();
});

describe("Gateway agent CLI Windows launcher encoding", () => {
  it("writes non-ASCII invocation paths through the OEM encoder", async () => {
    await withTempDir("openclaw-agent-cli-encoding-", async (root) => {
      const invocation = {
        command: "C:\\Program Files\\nodejs\\node.exe",
        args: ["C:\\Users\\苗振\\AppData\\Roaming\\npm\\node_modules\\openclaw\\openclaw.mjs"],
        cwd: "C:\\OpenClaw",
        env: {},
      };
      await prepareGatewayAgentCliShim({ platform: "win32", invocation, stateDir: root });

      const executablePath = path.join(root, "tmp", "agent-cli", "openclaw.cmd");
      const bytes = await fs.readFile(executablePath);
      const decoded = decodeWindowsLauncherScript({ buffer: bytes });

      expect(bytes.equals(Buffer.from(decoded, "utf8"))).toBe(false);
      expect(bytes.subarray(0, "@chcp 936 >nul\r\n".length).toString("ascii")).toBe(
        "@chcp 936 >nul\r\n",
      );
      expect(decoded).toBe(
        [
          "@echo off",
          "setlocal DisableDelayedExpansion",
          '"C:\\Program Files\\nodejs\\node.exe" C:\\Users\\苗振\\AppData\\Roaming\\npm\\node_modules\\openclaw\\openclaw.mjs %*',
          "",
        ].join("\r\n"),
      );
    });
  });

  it("keeps an unsupported launcher encoding from rejecting Gateway startup", async () => {
    await withTempDir("openclaw-agent-cli-encoding-failure-", async (root) => {
      resolveWindowsOemEncodingMock.mockReturnValue("cp857");
      resolveWindowsOemCodePageForEncodingMock.mockReturnValue(857);
      const onUnavailable = vi.fn();
      const invocation = {
        command: "C:\\Program Files\\nodejs\\node.exe",
        args: ["C:\\Users\\苗振\\AppData\\Roaming\\npm\\node_modules\\openclaw\\openclaw.mjs"],
        cwd: "C:\\OpenClaw",
        env: {},
      };

      await expect(
        prepareGatewayAgentCliShim({
          onUnavailable,
          platform: "win32",
          invocation,
          stateDir: root,
        }),
      ).resolves.toBeUndefined();

      expect(onUnavailable).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining("cannot be represented"),
        }),
      );
      await expect(
        fs.access(path.join(root, "tmp", "agent-cli", "openclaw.cmd")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(mergeGatewayAgentCliPath()).toBeUndefined();
    });
  });
});
