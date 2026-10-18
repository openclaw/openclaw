/** Base Vitest mocks for Windows schtasks daemon tests. */
import fs from "node:fs/promises";
import { vi } from "vitest";
import {
  gatewayServiceProbeHostsMock,
  inspectPortUsageMock,
  killProcessTreeMock,
  schtasksCalls,
  schtasksResponses,
  schtasksRegistration,
} from "./schtasks-fixtures.js";

// mock-isolation: Keep Task Scheduler subprocesses outside the native registration fixture.
vi.mock("../schtasks-exec.js", () => ({
  execSchtasks: async (argv: string[]) => {
    schtasksCalls.push(argv);
    const registration = schtasksRegistration.response;
    if (argv[0] === "/Query" && argv.includes("/XML") && registration) {
      return registration;
    }
    const response = schtasksResponses.shift() ?? { code: 0, stdout: "", stderr: "" };
    if (registration && response.code === 0) {
      if (argv[0] === "/Create") {
        const xmlPath = argv[argv.indexOf("/XML") + 1];
        if (!argv.includes("/XML") || !xmlPath) {
          throw new Error("Scheduled Task fixture requires a registration XML path.");
        }
        const raw = await fs.readFile(xmlPath);
        schtasksRegistration.response = {
          ...response,
          stdout: raw.subarray(2).toString("utf16le"),
        };
      } else if (argv[0] === "/Delete") {
        schtasksRegistration.response = { code: 1, stdout: "", stderr: "Task not found" };
      } else if (argv[0] === "/Change" && argv.includes("/DISABLE")) {
        schtasksRegistration.response = {
          ...registration,
          stdout: registration.stdout.replace(
            "<Enabled>true</Enabled>",
            "<Enabled>false</Enabled>",
          ),
        };
      }
    }
    schtasksRegistration.onCommand?.(argv, response);
    return argv[0] === "/Query" && argv.includes("/XML") && response.code === 0 && !response.stdout
      ? {
          ...response,
          stdout:
            "<Task><Settings><Enabled>true</Enabled></Settings><Actions><Exec><Command>gateway.cmd</Command></Exec></Actions></Task>",
        }
      : response;
  },
}));

vi.mock("../../infra/ports-inspect.js", () => ({
  inspectPortUsage: (port: number, options?: { probeHosts?: readonly string[] }) =>
    inspectPortUsageMock(port, options),
}));

vi.mock("../gateway-service-probe-hosts.js", () => ({
  resolveGatewayServiceProbeHosts: () => gatewayServiceProbeHostsMock(),
}));

vi.mock("../../process/kill-tree.js", () => ({
  killProcessTree: (pid: number, opts?: { graceMs?: number }) => killProcessTreeMock(pid, opts),
}));

// Launcher encode/decode must not depend on the dev or CI machine's code page;
// unpinned, a non-UTF-8-locale Windows host would OEM-encode fixture launcher files.
vi.mock("../../infra/windows-encoding.js", async () => {
  const actual = await vi.importActual<typeof import("../../infra/windows-encoding.js")>(
    "../../infra/windows-encoding.js",
  );
  return {
    ...actual,
    resolveWindowsOemCodePage: () => 437,
    resolveWindowsOemEncoding: () => "cp437",
  };
});
