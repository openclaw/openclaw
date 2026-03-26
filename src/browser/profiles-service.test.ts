import fs from "node:fs";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveOpenClawUserDataDir } from "../../extensions/browser/src/browser/chrome.js";
import type {
  BrowserRouteContext,
  BrowserServerState,
} from "../../extensions/browser/src/browser/server-context.js";
import { movePathToTrash } from "../../extensions/browser/src/browser/trash.js";
import { loadConfig, writeConfigFile } from "../../extensions/browser/src/config/config.js";

vi.mock("../../extensions/browser/src/config/config.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../extensions/browser/src/config/config.js")>();
  return {
    ...actual,
    loadConfig: vi.fn(),
    writeConfigFile: vi.fn(async () => {}),
  };
});

vi.mock("../../extensions/browser/src/browser/trash.js", () => ({
  movePathToTrash: vi.fn(async (targetPath: string) => targetPath),
}));

vi.mock("../../extensions/browser/src/browser/chrome.js", () => ({
  resolveOpenClawUserDataDir: vi.fn(() => "/tmp/openclaw-test/openclaw/user-data"),
}));

let resolveBrowserConfig: typeof import("../../extensions/browser/src/browser/config.js").resolveBrowserConfig;
let createBrowserProfilesService: typeof import("../../extensions/browser/src/browser/profiles-service.js").createBrowserProfilesService;

function createCtx(resolved: BrowserServerState["resolved"]) {
  const state: BrowserServerState = {
    server: null as unknown as BrowserServerState["server"],
    port: 0,
    resolved,
    profiles: new Map(),
  };

  const ctx = {
    state: () => state,
    listProfiles: vi.fn(async () => []),
    forProfile: vi.fn(() => ({
      stopRunningBrowser: vi.fn(async () => ({ stopped: true })),
    })),
  } as unknown as BrowserRouteContext;

  return { state, ctx };
}

async function createWorkProfileWithConfig(params: {
  resolved: BrowserServerState["resolved"];
  browserConfig: Record<string, unknown>;
}) {
  const { ctx, state } = createCtx(params.resolved);
  vi.mocked(loadConfig).mockReturnValue({ browser: params.browserConfig });
  const service = createBrowserProfilesService(ctx);
  const result = await service.createProfile({ name: "work" });
  return { result, state };
}

describe("BrowserProfilesService", () => {
  beforeAll(async () => {
    vi.resetModules();
    ({ resolveBrowserConfig } = await import("../../extensions/browser/src/browser/config.js"));
    ({ createBrowserProfilesService } =
      await import("../../extensions/browser/src/browser/profiles-service.js"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("allocates next local port for new profiles", async () => {
    const { result, state } = await createWorkProfileWithConfig({
      resolved: resolveBrowserConfig({}),
      browserConfig: { profiles: {} },
    });

    expect(result.cdpPort).toBe(18801);
    expect(result.isRemote).toBe(false);
    expect(state.resolved.profiles.work?.cdpPort).toBe(18801);
    expect(writeConfigFile).toHaveBeenCalled();
  });

  it("falls back to derived CDP range when resolved CDP range is missing", async () => {
    const base = resolveBrowserConfig({});
    const baseWithoutRange = { ...base } as {
      [key: string]: unknown;
      cdpPortRangeStart?: unknown;
      cdpPortRangeEnd?: unknown;
    };
    delete baseWithoutRange.cdpPortRangeStart;
    delete baseWithoutRange.cdpPortRangeEnd;
    const resolved = {
      ...baseWithoutRange,
      controlPort: 30000,
    } as BrowserServerState["resolved"];
    const { result, state } = await createWorkProfileWithConfig({
      resolved,
      browserConfig: { profiles: {} },
    });

    expect(result.cdpPort).toBe(30009);
    expect(state.resolved.profiles.work?.cdpPort).toBe(30009);
    expect(writeConfigFile).toHaveBeenCalled();
  });

  it("allocates from configured cdpPortRangeStart for new local profiles", async () => {
    const { result, state } = await createWorkProfileWithConfig({
      resolved: resolveBrowserConfig({ cdpPortRangeStart: 19000 }),
      browserConfig: { cdpPortRangeStart: 19000, profiles: {} },
    });

    expect(result.cdpPort).toBe(19001);
    expect(result.isRemote).toBe(false);
    expect(state.resolved.profiles.work?.cdpPort).toBe(19001);
    expect(writeConfigFile).toHaveBeenCalled();
  });

  it("accepts per-profile cdpUrl for remote Chrome", async () => {
    const resolved = resolveBrowserConfig({});
    const { ctx } = createCtx(resolved);

    vi.mocked(loadConfig).mockReturnValue({ browser: { profiles: {} } });

    const service = createBrowserProfilesService(ctx);
    const result = await service.createProfile({
      name: "remote",
      cdpUrl: "http://10.0.0.42:9222",
    });

    expect(result.cdpUrl).toBe("http://10.0.0.42:9222");
    expect(result.cdpPort).toBe(9222);
    expect(result.isRemote).toBe(true);
    expect(writeConfigFile).toHaveBeenCalledWith(
      expect.objectContaining({
        browser: expect.objectContaining({
          profiles: expect.objectContaining({
            remote: expect.objectContaining({
              cdpUrl: "http://10.0.0.42:9222",
            }),
          }),
        }),
      }),
    );
  });

  it("creates existing-session profiles as attach-only local entries", async () => {
    const resolved = resolveBrowserConfig({});
    const { ctx, state } = createCtx(resolved);
    vi.mocked(loadConfig).mockReturnValue({ browser: { profiles: {} } });

    const service = createBrowserProfilesService(ctx);
    const result = await service.createProfile({
      name: "chrome-live",
      driver: "existing-session",
    });

    expect(result.transport).toBe("chrome-mcp");
    expect(result.cdpPort).toBeNull();
    expect(result.cdpUrl).toBeNull();
    expect(result.userDataDir).toBeNull();
    expect(result.isRemote).toBe(false);
    expect(state.resolved.profiles["chrome-live"]).toEqual({
      driver: "existing-session",
      attachOnly: true,
      color: expect.any(String),
    });
    expect(writeConfigFile).toHaveBeenCalledWith(
      expect.objectContaining({
        browser: expect.objectContaining({
          profiles: expect.objectContaining({
            "chrome-live": expect.objectContaining({
              driver: "existing-session",
              attachOnly: true,
            }),
          }),
        }),
      }),
    );
  });

  it("rejects driver=existing-session when cdpUrl is provided", async () => {
    const resolved = resolveBrowserConfig({});
    const { ctx } = createCtx(resolved);
    vi.mocked(loadConfig).mockReturnValue({ browser: { profiles: {} } });

    const service = createBrowserProfilesService(ctx);

    await expect(
      service.createProfile({
        name: "chrome-live",
        driver: "existing-session",
        cdpUrl: "http://127.0.0.1:9222",
      }),
    ).rejects.toThrow(/does not accept cdpUrl/i);
  });

  it("creates existing-session profiles with an explicit userDataDir", async () => {
    const resolved = resolveBrowserConfig({});
    const { ctx, state } = createCtx(resolved);
    vi.mocked(loadConfig).mockReturnValue({ browser: { profiles: {} } });

    const tempDir = fs.mkdtempSync(path.join("/tmp", "openclaw-profile-"));
    const userDataDir = path.join(tempDir, "BraveSoftware", "Brave-Browser");
    fs.mkdirSync(userDataDir, { recursive: true });

    const service = createBrowserProfilesService(ctx);
    const result = await service.createProfile({
      name: "brave-live",
      driver: "existing-session",
      userDataDir,
    });

    expect(result.transport).toBe("chrome-mcp");
    expect(result.userDataDir).toBe(userDataDir);
    expect(state.resolved.profiles["brave-live"]).toEqual({
      driver: "existing-session",
      attachOnly: true,
      userDataDir,
      color: expect.any(String),
    });
  });

  it("rejects userDataDir for non-existing-session profiles", async () => {
    const resolved = resolveBrowserConfig({});
    const { ctx } = createCtx(resolved);
    vi.mocked(loadConfig).mockReturnValue({ browser: { profiles: {} } });

    const tempDir = fs.mkdtempSync(path.join("/tmp", "openclaw-profile-"));
    const userDataDir = path.join(tempDir, "BraveSoftware", "Brave-Browser");
    fs.mkdirSync(userDataDir, { recursive: true });

    const service = createBrowserProfilesService(ctx);

    await expect(
      service.createProfile({
        name: "brave-live",
        userDataDir,
      }),
    ).rejects.toThrow(/driver=existing-session is required/i);
  });

  it("deletes remote profiles without stopping or removing local data", async () => {
    const resolved = resolveBrowserConfig({
      profiles: {
        remote: { cdpUrl: "http://10.0.0.42:9222", color: "#0066CC" },
      },
    });
    const { ctx } = createCtx(resolved);

    vi.mocked(loadConfig).mockReturnValue({
      browser: {
        defaultProfile: "openclaw",
        profiles: {
          openclaw: { cdpPort: 18800, color: "#FF4500" },
          remote: { cdpUrl: "http://10.0.0.42:9222", color: "#0066CC" },
        },
      },
    });

    const service = createBrowserProfilesService(ctx);
    const result = await service.deleteProfile("remote");

    expect(result.deleted).toBe(false);
    expect(ctx.forProfile).not.toHaveBeenCalled();
    expect(movePathToTrash).not.toHaveBeenCalled();
  });

  it("deletes local profiles and moves data to Trash", async () => {
    const resolved = resolveBrowserConfig({
      profiles: {
        work: { cdpPort: 18801, color: "#0066CC" },
      },
    });
    const { ctx } = createCtx(resolved);

    vi.mocked(loadConfig).mockReturnValue({
      browser: {
        defaultProfile: "openclaw",
        profiles: {
          openclaw: { cdpPort: 18800, color: "#FF4500" },
          work: { cdpPort: 18801, color: "#0066CC" },
        },
      },
    });

    const tempDir = fs.mkdtempSync(path.join("/tmp", "openclaw-profile-"));
    const userDataDir = path.join(tempDir, "work", "user-data");
    fs.mkdirSync(path.dirname(userDataDir), { recursive: true });
    vi.mocked(resolveOpenClawUserDataDir).mockReturnValue(userDataDir);

    const service = createBrowserProfilesService(ctx);
    const result = await service.deleteProfile("work");

    expect(result.deleted).toBe(true);
    expect(movePathToTrash).toHaveBeenCalledWith(path.dirname(userDataDir));
  });

  it("deletes existing-session profiles without touching local browser data", async () => {
    const resolved = resolveBrowserConfig({
      profiles: {
        "chrome-live": {
          cdpPort: 18801,
          color: "#0066CC",
          driver: "existing-session",
          attachOnly: true,
        },
      },
    });
    const { ctx } = createCtx(resolved);

    vi.mocked(loadConfig).mockReturnValue({
      browser: {
        defaultProfile: "openclaw",
        profiles: {
          openclaw: { cdpPort: 18800, color: "#FF4500" },
          "chrome-live": {
            cdpPort: 18801,
            color: "#0066CC",
            driver: "existing-session",
            attachOnly: true,
          },
        },
      },
    });

    const service = createBrowserProfilesService(ctx);
    const result = await service.deleteProfile("chrome-live");

    expect(result.deleted).toBe(false);
    expect(ctx.forProfile).not.toHaveBeenCalled();
    expect(movePathToTrash).not.toHaveBeenCalled();
  });
});
