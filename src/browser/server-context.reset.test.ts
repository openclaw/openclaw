import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProfileResetOps } from "./server-context.reset.js";

const relayMocks = vi.hoisted(() => ({
  stopChromeExtensionRelayServer: vi.fn(async () => true),
}));

const trashMocks = vi.hoisted(() => ({
  movePathToTrash: vi.fn(async (from: string) => `${from}.trashed`),
}));

const pwAiMocks = vi.hoisted(() => ({
  closePlaywrightBrowserConnection: vi.fn(async () => {}),
}));

vi.mock("./extension-relay.js", () => relayMocks);
vi.mock("./trash.js", () => trashMocks);
vi.mock("./pw-ai.js", () => pwAiMocks);

afterEach(() => {
  vi.clearAllMocks();
});

describe("createProfileResetOps", () => {
  it("stops extension relay for extension profiles", async () => {
    const ops = createProfileResetOps({
      profile: {
        name: "chrome",
        cdpUrl: "http://127.0.0.1:18800",
        cdpHost: "127.0.0.1",
        cdpIsLoopback: true,
        cdpPort: 18800,
        color: "#f60",
        driver: "extension",
        attachOnly: false,
      },
      getProfileState: () => ({ profile: {} as never, running: null }),
      stopRunningBrowser: vi.fn(async () => ({ stopped: false })),
      isHttpReachable: vi.fn(async () => false),
      resolveOpenClawUserDataDir: (name: string) => `/tmp/${name}`,
    });

    await expect(ops.resetProfile()).resolves.toEqual({
      moved: false,
      from: "http://127.0.0.1:18800",
    });
    expect(relayMocks.stopChromeExtensionRelayServer).toHaveBeenCalledWith({
      cdpUrl: "http://127.0.0.1:18800",
    });
    expect(trashMocks.movePathToTrash).not.toHaveBeenCalled();
  });

  it("rejects remote non-extension profiles", async () => {
    const ops = createProfileResetOps({
      profile: {
        name: "remote",
        cdpUrl: "https://browserless.example/chrome",
        cdpHost: "browserless.example",
        cdpIsLoopback: false,
        cdpPort: 443,
        color: "#0f0",
        driver: "openclaw",
        attachOnly: false,
      },
      getProfileState: () => ({ profile: {} as never, running: null }),
      stopRunningBrowser: vi.fn(async () => ({ stopped: false })),
      isHttpReachable: vi.fn(async () => false),
      resolveOpenClawUserDataDir: (name: string) => `/tmp/${name}`,
    });

    await expect(ops.resetProfile()).rejects.toThrow(/only supported for local profiles/i);
  });

  it("stops local browser, closes playwright connection, and trashes profile dir", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-reset-"));
    const profileDir = path.join(tempRoot, "openclaw");
    fs.mkdirSync(profileDir, { recursive: true });

    const stopRunningBrowser = vi.fn(async () => ({ stopped: true }));
    const isHttpReachable = vi.fn(async () => true);
    const getProfileState = vi.fn(() => ({
      profile: {} as never,
      running: { pid: 1 } as never,
    }));

    const ops = createProfileResetOps({
      profile: {
        name: "openclaw",
        cdpUrl: "http://127.0.0.1:18800",
        cdpHost: "127.0.0.1",
        cdpIsLoopback: true,
        cdpPort: 18800,
        color: "#f60",
        driver: "openclaw",
        attachOnly: false,
      },
      getProfileState,
      stopRunningBrowser,
      isHttpReachable,
      resolveOpenClawUserDataDir: () => profileDir,
    });

    const result = await ops.resetProfile();
    expect(result).toEqual({
      moved: true,
      from: profileDir,
      to: `${profileDir}.trashed`,
    });
    expect(isHttpReachable).toHaveBeenCalledWith(300);
    expect(stopRunningBrowser).toHaveBeenCalledTimes(1);
    expect(pwAiMocks.closePlaywrightBrowserConnection).toHaveBeenCalledTimes(1);
    expect(trashMocks.movePathToTrash).toHaveBeenCalledWith(profileDir);
  });

  it("forces playwright disconnect when loopback cdp is occupied by non-owned process", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-reset-no-own-"));
    const profileDir = path.join(tempRoot, "openclaw");
    fs.mkdirSync(profileDir, { recursive: true });

    const stopRunningBrowser = vi.fn(async () => ({ stopped: false }));
    const ops = createProfileResetOps({
      profile: {
        name: "openclaw",
        cdpUrl: "http://127.0.0.1:18800",
        cdpHost: "127.0.0.1",
        cdpIsLoopback: true,
        cdpPort: 18800,
        color: "#f60",
        driver: "openclaw",
        attachOnly: false,
      },
      getProfileState: () => ({ profile: {} as never, running: null }),
      stopRunningBrowser,
      isHttpReachable: vi.fn(async () => true),
      resolveOpenClawUserDataDir: () => profileDir,
    });

    await ops.resetProfile();
    expect(stopRunningBrowser).not.toHaveBeenCalled();
    expect(pwAiMocks.closePlaywrightBrowserConnection).toHaveBeenCalledTimes(2);
  });
});
