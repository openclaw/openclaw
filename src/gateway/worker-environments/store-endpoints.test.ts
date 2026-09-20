import { describe, expect, it } from "vitest";
import type {
  WorkerDesktopEndpoint,
  WorkerSshEndpoint as WorkerEnvironmentSshEndpoint,
} from "../../plugins/types.js";
import { normalizeWorkerDesktopEndpoint, normalizeWorkerSshEndpoint } from "./store.js";

const HOST_KEY = ["ssh-ed25519", "AAAA"].join(" ");
const SSH_ENDPOINT: WorkerEnvironmentSshEndpoint = {
  host: "worker.example.test",
  port: 2222,
  fallbackPorts: [22, 2200],
  user: "openclaw",
  hostKey: HOST_KEY,
  keyRef: {
    source: "file",
    provider: "worker-keys",
    id: "/static-development-key",
  },
};

describe("worker endpoint normalization", () => {
  it("normalizes provider-advertised SSH fallback ports at the durable boundary", () => {
    expect(
      normalizeWorkerSshEndpoint({
        ...SSH_ENDPOINT,
        fallbackPorts: [22, 2200, 22, 2222],
      }),
    ).toEqual(SSH_ENDPOINT);
  });

  it.each([
    ["non-array", "22"],
    ["non-integer", [22.5]],
    ["below range", [0]],
    ["above range", [65_536]],
    ["more than ten", Array.from({ length: 11 }, (_, index) => 2300 + index)],
  ])("rejects %s SSH fallback ports", (_name, fallbackPorts) => {
    expect(() =>
      normalizeWorkerSshEndpoint({
        ...SSH_ENDPOINT,
        fallbackPorts,
      } as unknown as WorkerEnvironmentSshEndpoint),
    ).toThrow("SSH fallback ports");
  });

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
          args: ["--headless"],
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
      } as unknown as WorkerDesktopEndpoint),
    ).toThrow(error);
  });
  it.each([
    {
      passwordFilePath: "/var/db/crabbox/vnc.password",
      username: "desktop-user",
      allowsResize: false,
    },
    {
      passwordFilePath: "C:\\ProgramData\\crabbox\\vnc.password",
      apps: [{ id: "terminal" as const, executablePath: "C:\\Windows\\System32\\cmd.exe" }],
      allowsResize: false,
    },
  ])("accepts native desktop credentials and remote paths: %j", (native) => {
    expect(normalizeWorkerDesktopEndpoint({ protocol: "rfb", port: 5900, ...native })).toEqual({
      protocol: "rfb",
      port: 5900,
      ...native,
    });
  });
});
