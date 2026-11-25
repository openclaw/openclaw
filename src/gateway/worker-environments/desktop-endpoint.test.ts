import { describe, expect, it } from "vitest";
import type { WorkerDesktopEndpoint } from "../../plugins/types.js";
import { normalizeWorkerDesktopEndpoint } from "./desktop-endpoint.js";

const normalize = (overrides: Record<string, unknown>) =>
  normalizeWorkerDesktopEndpoint({ protocol: "rfb", port: 5900, ...overrides });

describe("worker desktop endpoint", () => {
  const terminal = { id: "terminal", executablePath: "/usr/bin/xfce4-terminal" };
  const browser = {
    id: "browser",
    executablePath: "/usr/local/bin/openclaw-worker-browser",
    cdpPort: 9222,
  };

  it.each([
    ["browser", "desktop apps must be an array"],
    [Array.from({ length: 9 }, () => terminal), "desktop apps cannot exceed 8"],
    [
      [{ id: "editor", executablePath: "/usr/bin/editor" }],
      'desktop app id must be "browser" or "terminal"',
    ],
    [
      [terminal, { ...terminal, executablePath: "/usr/local/bin/openclaw-worker-terminal" }],
      "desktop app id terminal must be unique",
    ],
    [
      [{ ...terminal, executablePath: "bin/xfce4-terminal" }],
      "desktop app executable path must be absolute",
    ],
    [[{ ...browser, cdpPort: 65_536 }], "browser CDP port must be an integer"],
    [[{ ...browser, shell: true }], "browser desktop app contains unknown fields"],
    [[{ ...terminal, env: { DISPLAY: ":99" } }], "terminal desktop app contains unknown fields"],
  ])("rejects %j: %s", (apps, error) => {
    expect(() => normalize({ apps })).toThrow(error);
  });

  it.each(["/opt/openclaw", "C:\\ProgramData\\OpenClaw"])(
    "admits provider-owned desktop paths and args for %s",
    (root) => {
      const desktop: WorkerDesktopEndpoint = {
        protocol: "rfb",
        port: 5900,
        passwordFilePath: `${root}/password`,
        username: "worker",
        allowsResize: false,
        apps: [
          {
            id: "terminal",
            executablePath: `${root}/launcher`,
            args: ["arg with spaces", "literal;$(text)"],
          },
        ],
      };
      expect(normalizeWorkerDesktopEndpoint(desktop)).toEqual(desktop);
      const reject = (overrides: Record<string, unknown>, error: string) =>
        expect(() => normalize({ ...desktop, ...overrides })).toThrow(error);
      for (const args of [
        ["nul\0"],
        Array(33).fill("a"),
        ["x".repeat(4097)],
        Array(3).fill("x".repeat(4096)),
      ]) {
        reject({ apps: [{ ...desktop.apps![0]!, args }] }, "args must be bounded");
      }
      reject({ username: "x".repeat(64) }, "desktop username");
      reject({ passwordFilePath: undefined }, "desktop username");
      reject({ allowsResize: "false" }, "allowsResize must be a boolean");
    },
  );
});
