import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { OpenClawConfig } from "../config/config.js";
import type { PreparedNodeRuntimeUpdate } from "./auto-update-install.js";
import { startNodeHostAutoUpdate } from "./auto-update.js";

const mocks = vi.hoisted(() => ({
  config: {} as OpenClawConfig,
  configValid: true,
  readConfig: vi.fn(),
  lstat: vi.fn(),
  packageRoot: vi.fn(),
  installKind: vi.fn(),
  discover: vi.fn<typeof import("../infra/update-check.js").resolveNpmChannelTag>(),
  prepare: vi.fn<typeof import("./auto-update-install.js").prepareNodeRuntimeUpdate>(),
  compatible:
    vi.fn<typeof import("./auto-update-compatibility.js").assertNodeRuntimeUpdateCompatible>(),
  launcherChild: vi.fn(() => true),
  restart: vi.fn<typeof import("./launcher-client.js").requestNodeHostLauncherRestart>(),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, default: { ...actual, lstat: mocks.lstat } };
});
vi.mock("../config/io.js", () => ({
  createConfigIO: () => ({ readConfigFileSnapshot: mocks.readConfig }),
}));
vi.mock("../config/paths.js", () => ({ resolveStateDir: () => "/synthetic-node-state" }));
vi.mock("../infra/openclaw-root.js", () => ({
  resolveOpenClawPackageRoot: mocks.packageRoot,
}));
vi.mock("../infra/update-check.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/update-check.js")>()),
  resolveNpmChannelTag: mocks.discover,
  resolveUpdateInstallKind: mocks.installKind,
}));
vi.mock("../version.js", () => ({ VERSION: "2026.9.17" }));
vi.mock("./auto-update-install.js", () => ({ prepareNodeRuntimeUpdate: mocks.prepare }));
vi.mock("./auto-update-compatibility.js", () => ({
  assertNodeRuntimeUpdateCompatible: mocks.compatible,
}));
vi.mock("./launcher-client.js", () => ({
  isNodeHostLauncherChild: mocks.launcherChild,
  requestNodeHostLauncherRestart: mocks.restart,
}));

const HOUR = 60 * 60_000;
const candidate: PreparedNodeRuntimeUpdate = {
  version: "2026.9.18",
  runtimeRoot: "/synthetic-node-state/node-runtime/releases/2026.9.18-integrity",
  packageRoot:
    "/synthetic-node-state/node-runtime/releases/2026.9.18-integrity/lib/node_modules/openclaw",
  integrity: "sha512-synthetic-fixture",
};
const controllers: Array<ReturnType<typeof startNodeHostAutoUpdate>> = [];
const releases: Array<() => void> = [];

function hold<T>(value: T) {
  const deferred = createDeferred<T>();
  releases.push(() => deferred.resolve(value));
  return deferred;
}

function start(busy = false) {
  const abort = new AbortController();
  const runtime = {
    tryPauseForUpdate: vi.fn(() => !busy),
    resumeAfterUpdate: vi.fn(),
  };
  const onRestartAccepted = vi.fn();
  const log = vi.fn();
  const controller = startNodeHostAutoUpdate({
    runtime,
    onRestartAccepted,
    log,
    signal: abort.signal,
  });
  controllers.push(controller);
  return { abort, runtime, onRestartAccepted, log, controller };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-18T12:00:00Z"));
  vi.stubEnv("OPENCLAW_NO_AUTO_UPDATE", "");
  vi.stubEnv("OPENCLAW_NO_RESPAWN", "");
  vi.resetAllMocks();
  mocks.config = {};
  mocks.configValid = true;
  mocks.readConfig.mockImplementation(async () => ({
    valid: mocks.configValid,
    config: mocks.config,
  }));
  mocks.launcherChild.mockReturnValue(true);
  mocks.packageRoot.mockResolvedValue("/synthetic-installed-openclaw");
  mocks.installKind.mockResolvedValue("package");
  mocks.discover.mockResolvedValue({ tag: "latest", version: candidate.version });
  mocks.lstat.mockRejectedValue(
    Object.assign(new Error("no active runtime yet"), { code: "ENOENT" }),
  );
  mocks.prepare.mockResolvedValue(candidate);
  mocks.compatible.mockResolvedValue(undefined);
  mocks.restart.mockResolvedValue(undefined);
});

afterEach(async () => {
  const stopping = controllers.splice(0).map((controller) => controller.stop());
  for (const release of releases.splice(0)) {
    release();
  }
  await Promise.all(stopping);
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("node auto-update controller", () => {
  it.each(["disabled", "channel changed"])(
    "does not install a late discovery after policy is %s",
    async (change) => {
      const discovery = hold({ tag: "latest", version: candidate.version });
      mocks.discover.mockImplementationOnce(async () => await discovery.promise);
      start();
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.discover).toHaveBeenCalledOnce();
      mocks.config =
        change === "disabled"
          ? { nodeHost: { autoUpdate: { enabled: false } } }
          : { update: { channel: "beta" } };
      discovery.resolve({ tag: "latest", version: candidate.version });
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.prepare).not.toHaveBeenCalled();
      expect(mocks.restart).not.toHaveBeenCalled();
    },
  );

  it("checks immediately and hourly without repeatedly staging the installed release", async () => {
    mocks.discover.mockResolvedValue({ tag: "latest", version: "2026.9.17" });
    start();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.discover).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(HOUR - 1);
    expect(mocks.discover).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.discover).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(mocks.discover).toHaveBeenCalledTimes(3);
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.restart).not.toHaveBeenCalled();
  });

  it.each([
    { label: "unmanaged process", launcher: false, kind: "package" },
    { label: "source checkout", launcher: true, kind: "git" },
    { label: "unknown installation", launcher: true, kind: "unknown" },
  ])("does not schedule package updates for $label", async ({ launcher, kind }) => {
    mocks.launcherChild.mockReturnValue(launcher);
    mocks.installKind.mockResolvedValue(kind);
    start();
    await vi.advanceTimersByTimeAsync(24 * HOUR);
    expect(mocks.discover).not.toHaveBeenCalled();
    expect(mocks.prepare).not.toHaveBeenCalled();
  });

  it.each([
    { label: "node setting", config: { nodeHost: { autoUpdate: { enabled: false } } } },
    { label: "startup check setting", config: { update: { checkOnStart: false } } },
    { label: "dev channel", config: { update: { channel: "dev" } } },
    { label: "extended-stable channel", config: { update: { channel: "extended-stable" } } },
  ] satisfies Array<{ label: string; config: OpenClawConfig }>)(
    "honors the disabled $label policy before discovery",
    async ({ config }) => {
      mocks.config = config;
      start();
      await vi.advanceTimersByTimeAsync(HOUR);
      expect(mocks.discover).not.toHaveBeenCalled();
      expect(mocks.prepare).not.toHaveBeenCalled();
    },
  );

  it("uses the committed runtime pointer time and allows activation at exactly twelve hours", async () => {
    mocks.lstat.mockResolvedValue({ mtimeMs: Date.now() - 11 * HOUR });
    const host = start();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.lstat).toHaveBeenCalledWith(
      path.join("/synthetic-node-state", "node-runtime", "current"),
    );
    expect(mocks.prepare).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(HOUR - 1);
    expect(mocks.prepare).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.prepare).toHaveBeenCalledOnce();
    expect(mocks.restart).toHaveBeenCalledWith({
      runtimeRoot: candidate.runtimeRoot,
      version: candidate.version,
    });
    expect(host.onRestartAccepted).toHaveBeenCalledOnce();
  });

  it("stages once while busy and waits for the parent acknowledgment before requesting shutdown", async () => {
    const acknowledgment = hold<void>(undefined);
    mocks.restart.mockImplementation(async () => await acknowledgment.promise);
    const host = start(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.prepare).toHaveBeenCalledOnce();
    expect(mocks.compatible).not.toHaveBeenCalled();
    expect(mocks.restart).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(host.runtime.tryPauseForUpdate).toHaveBeenCalledTimes(2);
    expect(mocks.prepare).toHaveBeenCalledOnce();
    expect(mocks.discover).toHaveBeenCalledOnce();
    expect(
      host.log.mock.calls.filter(([message]) => message.includes("waiting for active work")),
    ).toHaveLength(1);

    host.runtime.tryPauseForUpdate.mockReturnValue(true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(mocks.restart).toHaveBeenCalledOnce();
    expect(host.onRestartAccepted).not.toHaveBeenCalled();
    expect(host.runtime.resumeAfterUpdate).not.toHaveBeenCalled();
    acknowledgment.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(host.onRestartAccepted).toHaveBeenCalledOnce();
    await host.controller.stop();
    expect(host.runtime.resumeAfterUpdate).not.toHaveBeenCalled();
  });

  it.each([
    { stage: "download", change: "disabled" },
    { stage: "download", change: "channel" },
    { stage: "preflight", change: "disabled" },
    { stage: "preflight", change: "channel" },
  ] as const)(
    "rechecks a $change policy changed during $stage before activation",
    async ({ stage, change }) => {
      const downloaded = hold(candidate);
      const preflight = hold<void>(undefined);
      if (stage === "download") {
        mocks.prepare.mockImplementationOnce(async () => await downloaded.promise);
      } else {
        mocks.compatible.mockImplementationOnce(async () => await preflight.promise);
      }
      const host = start();
      await vi.advanceTimersByTimeAsync(0);
      expect(stage === "download" ? mocks.prepare : mocks.compatible).toHaveBeenCalledOnce();
      mocks.config =
        change === "disabled"
          ? { nodeHost: { autoUpdate: { enabled: false } } }
          : { update: { channel: "beta" } };
      downloaded.resolve(candidate);
      preflight.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.restart).not.toHaveBeenCalled();
      expect(host.onRestartAccepted).not.toHaveBeenCalled();
      expect(host.runtime.resumeAfterUpdate).toHaveBeenCalledTimes(stage === "preflight" ? 1 : 0);
    },
  );

  it("rechecks the activation interval after compatibility work", async () => {
    const preflight = hold<void>(undefined);
    mocks.compatible.mockImplementationOnce(async () => await preflight.promise);
    const host = start();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.compatible).toHaveBeenCalledOnce();
    mocks.lstat.mockResolvedValue({ mtimeMs: Date.now() });
    preflight.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.restart).not.toHaveBeenCalled();
    expect(host.runtime.resumeAfterUpdate).toHaveBeenCalledOnce();
  });

  it.each(["download", "preflight"] as const)(
    "cancels and joins pending $stage cleanup before stop resolves",
    async (stage) => {
      const downloaded = hold(candidate);
      const preflight = hold<void>(undefined);
      if (stage === "download") {
        mocks.prepare.mockImplementationOnce(async () => await downloaded.promise);
      } else {
        mocks.compatible.mockImplementationOnce(async () => await preflight.promise);
      }
      const host = start();
      await vi.advanceTimersByTimeAsync(0);
      const invocation =
        stage === "download" ? mocks.prepare.mock.calls[0] : mocks.compatible.mock.calls[0];
      expect(invocation?.[0].signal?.aborted).toBe(false);
      let stopped = false;
      const stopping = host.controller.stop().then(() => {
        stopped = true;
      });
      expect(invocation?.[0].signal?.aborted).toBe(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(stopped).toBe(false);
      downloaded.resolve(candidate);
      preflight.resolve();
      await stopping;
      expect(stopped).toBe(true);
      expect(mocks.restart).not.toHaveBeenCalled();
      expect(host.onRestartAccepted).not.toHaveBeenCalled();
      expect(host.runtime.resumeAfterUpdate).toHaveBeenCalledTimes(stage === "preflight" ? 1 : 0);
    },
  );

  it.each(["download", "preflight", "restart"] as const)(
    "keeps the running node available after a $stage failure and retries hourly",
    async (stage) => {
      const error = new Error(`${stage} fixture failure`);
      if (stage === "download") {
        mocks.prepare.mockRejectedValueOnce(error);
      } else if (stage === "preflight") {
        mocks.compatible.mockRejectedValueOnce(error);
      } else {
        mocks.restart.mockRejectedValueOnce(error);
      }
      const host = start();
      await vi.advanceTimersByTimeAsync(0);
      expect(host.log).toHaveBeenCalledWith(expect.stringContaining(error.message));
      expect(host.onRestartAccepted).not.toHaveBeenCalled();
      expect(host.runtime.resumeAfterUpdate).toHaveBeenCalledTimes(stage === "download" ? 0 : 1);
      await vi.advanceTimersByTimeAsync(HOUR - 1);
      expect(mocks.prepare).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      expect(mocks.prepare).toHaveBeenCalledTimes(2);
      expect(host.onRestartAccepted).toHaveBeenCalledOnce();
    },
  );
});
