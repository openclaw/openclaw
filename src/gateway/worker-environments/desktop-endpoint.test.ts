import { describe, expect, it } from "vitest";
import type { WorkerDesktopEndpoint } from "../../plugins/types.js";
import { normalizeWorkerDesktopEndpoint } from "./desktop-endpoint.js";

describe("worker desktop endpoint", () => {
  it.each([
    ["a non-array app list", "browser", "desktop apps must be an array"],
    [
      "more than eight apps",
      Array.from({ length: 9 }, () => ({
        id: "terminal",
        executablePath: "/usr/bin/xfce4-terminal",
      })),
      "desktop apps cannot exceed 8",
    ],
    [
      "an unknown app id",
      [{ id: "editor", executablePath: "/usr/bin/editor" }],
      'desktop app id must be "browser" or "terminal"',
    ],
    [
      "duplicate app ids",
      [
        { id: "terminal", executablePath: "/usr/bin/xfce4-terminal" },
        { id: "terminal", executablePath: "/usr/local/bin/openclaw-worker-terminal" },
      ],
      "desktop app id terminal must be unique",
    ],
    [
      "a relative executable path",
      [{ id: "terminal", executablePath: "bin/xfce4-terminal" }],
      "desktop app executable path must be absolute",
    ],
    [
      "an invalid browser CDP port",
      [
        {
          id: "browser",
          executablePath: "/usr/local/bin/openclaw-worker-browser",
          cdpPort: 65_536,
        },
      ],
      "browser CDP port must be an integer",
    ],
    [
      "an unknown browser field",
      [
        {
          id: "browser",
          executablePath: "/usr/local/bin/openclaw-worker-browser",
          cdpPort: 9222,
          shell: true,
        },
      ],
      "browser desktop app contains unknown fields",
    ],
    [
      "an unknown terminal field",
      [
        {
          id: "terminal",
          executablePath: "/usr/local/bin/openclaw-worker-terminal",
          env: { DISPLAY: ":99" },
        },
      ],
      "terminal desktop app contains unknown fields",
    ],
  ])("rejects %s", (_name, apps, error) => {
    expect(() =>
      normalizeWorkerDesktopEndpoint({
        protocol: "rfb",
        port: 5900,
        apps,
      }),
    ).toThrow(error);
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
      for (const args of [
        ["nul\0"],
        Array(33).fill("a"),
        ["x".repeat(4097)],
        Array(3).fill("x".repeat(4096)),
      ]) {
        expect(() =>
          normalizeWorkerDesktopEndpoint({ ...desktop, apps: [{ ...desktop.apps![0]!, args }] }),
        ).toThrow("args must be bounded");
      }
      expect(() =>
        normalizeWorkerDesktopEndpoint({ ...desktop, username: "x".repeat(64) }),
      ).toThrow("desktop username");
      expect(() =>
        normalizeWorkerDesktopEndpoint({ ...desktop, passwordFilePath: undefined }),
      ).toThrow("desktop username");
      expect(() =>
        normalizeWorkerDesktopEndpoint({
          ...desktop,
          allowsResize: "false",
        }),
      ).toThrow("allowsResize must be a boolean");
    },
  );
});
