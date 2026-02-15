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
      ({ runGatewayUpdateCheck } = await import("./update-startup.js"));
      loaded = true;
    }
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
  });

  afterAll(async () => {
    if (suiteRoot) {
      await fs.rm(suiteRoot, { recursive: true, force: true });
    }
    suiteRoot = "";
    suiteCase = 0;
  });

  it("logs update hint for npm installs when newer tag exists", async () => {
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
      cfg: { update: { channel: "stable" } },
      log,
      isNixMode: false,
      allowInTests: true,
    });

    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining("update available (latest): v2.0.0"),
    );

    const statePath = path.join(tempDir, "update-check.json");
    const raw = await fs.readFile(statePath, "utf-8");
    const parsed = JSON.parse(raw) as { lastNotifiedVersion?: string };
    expect(parsed.lastNotifiedVersion).toBe("2.0.0");
  });

  it("uses latest when beta tag is older than release", async () => {
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
      cfg: { update: { channel: "beta" } },
      log,
      isNixMode: false,
      allowInTests: true,
    });

    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining("update available (latest): v2.0.0"),
    );

    const statePath = path.join(tempDir, "update-check.json");
    const raw = await fs.readFile(statePath, "utf-8");
    const parsed = JSON.parse(raw) as { lastNotifiedTag?: string };
    expect(parsed.lastNotifiedTag).toBe("latest");
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
