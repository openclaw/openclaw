import os from "node:os";
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import { VERSION as runtimeVersion } from "../version.js";

vi.unmock("../version.js");

const spawnSyncMock = vi.hoisted(() => vi.fn());
const spawnResult = (stdout = "") => ({
  stdout,
  stderr: "",
  pid: 1,
  output: [],
  status: 0,
  signal: null,
});

vi.mock("node:child_process", async () => {
  const { mockNodeChildProcessSpawnSync } = await import("openclaw/plugin-sdk/test-node-mocks");
  return mockNodeChildProcessSpawnSync(spawnSyncMock, () =>
    vi.importActual<typeof import("node:child_process")>("node:child_process"),
  );
});

async function readSelfPresence(
  env: Record<string, string | undefined>,
  scope = JSON.stringify(env),
) {
  return withEnvAsync(
    {
      OPENCLAW_VERSION: undefined,
      npm_package_version: undefined,
      ...env,
    },
    async () => {
      const { listSystemPresence } = await importFreshModule<typeof import("./system-presence.js")>(
        import.meta.url,
        `./system-presence.js?scope=${scope}`,
      );
      return listSystemPresence().find((entry) => entry.reason === "self");
    },
  );
}

describe("system-presence version fallback", () => {
  beforeEach(() => {
    vi.resetModules();
    spawnSyncMock.mockReturnValue(spawnResult());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    spawnSyncMock.mockReset();
  });

  it.each([
    ["OPENCLAW_SERVICE_VERSION", "2.4.6-service", runtimeVersion],
    ["OPENCLAW_VERSION", "9.9.9-cli", "9.9.9-cli"],
    ["OPENCLAW_VERSION", " ", runtimeVersion],
  ])("resolves presence version with %s=%j", async (key, value, expected) => {
    const self = await readSelfPresence({ [key]: value, npm_package_version: "1.0.0-package" });
    expect(self?.version).toBe(expected);
  });

  it("falls back to hostname when self-presence LAN discovery throws", async () => {
    vi.spyOn(os, "hostname").mockReturnValue("test-host");
    vi.spyOn(os, "networkInterfaces").mockImplementation(() => {
      throw new Error("uv_interface_addresses failed");
    });
    expect(await readSelfPresence({}, "hostname-fallback")).toMatchObject({
      host: "test-host",
      ip: "test-host",
    });
  });

  it("bounds macOS self-presence metadata probes", async () => {
    vi.spyOn(os, "platform").mockReturnValue("darwin");
    vi.spyOn(os, "release").mockReturnValue("25.0.0");
    vi.spyOn(os, "arch").mockReturnValue("arm64");
    vi.spyOn(os, "hostname").mockReturnValue("test-mac");
    vi.spyOn(os, "networkInterfaces").mockReturnValue({});
    spawnSyncMock.mockImplementation((command: string) =>
      spawnResult(command === "sysctl" ? "Mac16,1\n" : "26.0\n"),
    );

    expect(await readSelfPresence({})).toMatchObject({
      modelIdentifier: "Mac16,1",
      platform: "macos 26.0",
    });

    const options = { encoding: "utf-8", timeout: 5_000, killSignal: "SIGKILL" };
    expect(spawnSyncMock).toHaveBeenCalledWith("sysctl", ["-n", "hw.model"], options);
    expect(spawnSyncMock).toHaveBeenCalledWith("sw_vers", ["-productVersion"], options);
  });
});
