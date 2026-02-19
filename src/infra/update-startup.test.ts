import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdateCheckResult } from "./update-check.js";

vi.mock("./openclaw-root.js", () => ({
  resolveOpenClawPackageRoot: vi.fn(),
}));

vi.mock("./update-check.js", async () => {
  const parse = (value: string) => value.split(".").map((part) => Number.parseInt(part, 10));
  const compareSemverStrings = (a: string, b: string) => {
    const left = parse(a);
    const right = parse(b);
    for (let idx = 0; idx < 3; idx += 1) {
      const l = left[idx] ?? 0;
      const r = right[idx] ?? 0;
      if (l !== r) {
        return l < r ? -1 : 1;
      }
    }
    return 0;
  };

  return {
    checkUpdateStatus: vi.fn(),
    compareSemverStrings,
    resolveNpmChannelTag: vi.fn(),
  };
});

vi.mock("../version.js", () => ({
  VERSION: "1.0.0",
}));

describe("update-startup", () => {
  let suiteRoot = "";
  let suiteCase = 0;
  let tempDir: string;
  let prevStateDir: string | undefined;
  let prevNodeEnv: string | undefined;
  let prevVitest: string | undefined;
  let hadStateDir = false;
  let hadNodeEnv = false;
  let hadVitest = false;

  let resolveOpenClawPackageRoot: (typeof import("./openclaw-root.js"))["resolveOpenClawPackageRoot"];
  let checkUpdateStatus: (typeof import("./update-check.js"))["checkUpdateStatus"];
  let resolveNpmChannelTag: (typeof import("./update-check.js"))["resolveNpmChannelTag"];
  let runGatewayUpdateCheck: (typeof import("./update-startup.js"))["runGatewayUpdateCheck"];
  let getUpdateAvailable: (typeof import("./update-startup.js"))["getUpdateAvailable"];
  let resetUpdateAvailableStateForTest: (typeof import("./update-startup.js"))["resetUpdateAvailableStateForTest"];
  let loaded = false;

  beforeAll(async () => {
    suiteRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-update-check-suite-"));
  });

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-17T10:00:00Z"));
    tempDir = path.join(suiteRoot, `case-${++suiteCase}`);
    await fs.mkdir(tempDir);
    hadStateDir = Object.prototype.hasOwnProperty.call(process.env, "OPENCLAW_STATE_DIR");
    prevStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = tempDir;

    hadNodeEnv = Object.prototype.hasOwnProperty.call(process.env, "NODE_ENV");
    prevNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "test";

    // Ensure update checks don't short-circuit in test mode.
    hadVitest = Object.prototype.hasOwnProperty.call(process.env, "VITEST");
    prevVitest = process.env.VITEST;
    delete process.env.VITEST;

    // Perf: load mocked modules once (after timers/env are set up).
    if (!loaded) {
      ({ resolveOpenClawPackageRoot } = await import("./openclaw-root.js"));
      ({ checkUpdateStatus, resolveNpmChannelTag } = await import("./update-check.js"));
      ({ runGatewayUpdateCheck, getUpdateAvailable, resetUpdateAvailableStateForTest } =
        await import("./update-startup.js"));
      loaded = true;
    }
    vi.mocked(resolveOpenClawPackageRoot).mockReset();
    vi.mocked(checkUpdateStatus).mockReset();
    vi.mocked(resolveNpmChannelTag).mockReset();
    resetUpdateAvailableStateForTest();
  });

  afterEach(async () => {
    vi.useRealTimers();
    if (hadStateDir) {
      process.env.OPENCLAW_STATE_DIR = prevStateDir;
    } else {
      delete process.env.OPENCLAW_STATE_DIR;
    }
    if (hadNodeEnv) {
      process.env.NODE_ENV = prevNodeEnv;
    } else {
      delete process.env.NODE_ENV;
    }
    if (hadVitest) {
      process.env.VITEST = prevVitest;
    } else {
      delete process.env.VITEST;
    }
    resetUpdateAvailableStateForTest();
  });

  afterAll(async () => {
    if (suiteRoot) {
      await fs.rm(suiteRoot, { recursive: true, force: true });
    }
    suiteRoot = "";
    suiteCase = 0;
  });

  async function runUpdateCheckAndReadState(channel: "stable" | "beta") {
    vi.mocked(resolveOpenClawPackageRoot).mockResolvedValue("/opt/openclaw");
    vi.mocked(checkUpdateStatus).mockResolvedValue({
      root: "/opt/openclaw",
      installKind: "package",
      packageManager: "npm",
    } satisfies UpdateCheckResult);
    vi.mocked(resolveNpmChannelTag).mockResolvedValue({
      tag: "latest",
      version: "2.0.0",
    });

    const log = { info: vi.fn() };
    await runGatewayUpdateCheck({
      cfg: { update: { channel } },
      log,
      isNixMode: false,
      allowInTests: true,
    });

    const statePath = path.join(tempDir, "update-check.json");
    const parsed = JSON.parse(await fs.readFile(statePath, "utf-8")) as {
      lastNotifiedVersion?: string;
      lastNotifiedTag?: string;
      lastAvailableVersion?: string;
      lastAvailableTag?: string;
    };
    return { log, parsed };
  }

  it("logs update hint for npm installs when newer tag exists", async () => {
    const { log, parsed } = await runUpdateCheckAndReadState("stable");

    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining("update available (latest): v2.0.0"),
    );
    expect(parsed.lastNotifiedVersion).toBe("2.0.0");
    expect(parsed.lastAvailableVersion).toBe("2.0.0");
  });

  it("uses latest when beta tag is older than release", async () => {
    const { log, parsed } = await runUpdateCheckAndReadState("beta");

    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining("update available (latest): v2.0.0"),
    );
    expect(parsed.lastNotifiedTag).toBe("latest");
  });

  it("hydrates cached update from persisted state during throttle window", async () => {
    const statePath = path.join(tempDir, "update-check.json");
    await fs.writeFile(
      statePath,
      JSON.stringify(
        {
          lastCheckedAt: new Date(Date.now()).toISOString(),
          lastAvailableVersion: "2.0.0",
          lastAvailableTag: "latest",
        },
        null,
        2,
      ),
      "utf-8",
    );

    const onUpdateAvailableChange = vi.fn();
    await runGatewayUpdateCheck({
      cfg: { update: { channel: "stable" } },
      log: { info: vi.fn() },
      isNixMode: false,
      allowInTests: true,
      onUpdateAvailableChange,
    });

    expect(vi.mocked(checkUpdateStatus)).not.toHaveBeenCalled();
    expect(onUpdateAvailableChange).toHaveBeenCalledWith({
      currentVersion: "1.0.0",
      latestVersion: "2.0.0",
      channel: "latest",
    });
    expect(getUpdateAvailable()).toEqual({
      currentVersion: "1.0.0",
      latestVersion: "2.0.0",
      channel: "latest",
    });
  });

  it("emits update change callback when update state clears", async () => {
    vi.mocked(resolveOpenClawPackageRoot).mockResolvedValue("/opt/openclaw");
    vi.mocked(checkUpdateStatus).mockResolvedValue({
      root: "/opt/openclaw",
      installKind: "package",
      packageManager: "npm",
    } satisfies UpdateCheckResult);
    vi.mocked(resolveNpmChannelTag)
      .mockResolvedValueOnce({
        tag: "latest",
        version: "2.0.0",
      })
      .mockResolvedValueOnce({
        tag: "latest",
        version: "1.0.0",
      });

    const onUpdateAvailableChange = vi.fn();
    await runGatewayUpdateCheck({
      cfg: { update: { channel: "stable" } },
      log: { info: vi.fn() },
      isNixMode: false,
      allowInTests: true,
      onUpdateAvailableChange,
    });
    vi.setSystemTime(new Date("2026-01-18T11:00:00Z"));
    await runGatewayUpdateCheck({
      cfg: { update: { channel: "stable" } },
      log: { info: vi.fn() },
      isNixMode: false,
      allowInTests: true,
      onUpdateAvailableChange,
    });

    expect(onUpdateAvailableChange).toHaveBeenNthCalledWith(1, {
      currentVersion: "1.0.0",
      latestVersion: "2.0.0",
      channel: "latest",
    });
    expect(onUpdateAvailableChange).toHaveBeenNthCalledWith(2, null);
    expect(getUpdateAvailable()).toBeNull();
  });

  it("skips update check when disabled in config", async () => {
    const log = { info: vi.fn() };

    await runGatewayUpdateCheck({
      cfg: { update: { checkOnStart: false } },
      log,
      isNixMode: false,
      allowInTests: true,
    });

    expect(log.info).not.toHaveBeenCalled();
    await expect(fs.stat(path.join(tempDir, "update-check.json"))).rejects.toThrow();
  });
});
