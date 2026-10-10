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
  exec: vi.fn<typeof import("../process/exec.js").runCommandWithTimeout>(),
  fetch: vi.fn<typeof fetch>(),
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
vi.mock("../process/exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../process/exec.js")>()),
  runCommandWithTimeout: mocks.exec,
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
    tryPauseForUpdate: vi.fn(async () => !busy),
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

function holdStage(
  stage: "discovery" | "download" | "preflight" | "idle",
  host: ReturnType<typeof start>,
) {
  const pending = hold<void>(undefined);
  if (stage === "discovery") {
    mocks.discover.mockImplementationOnce(async () => {
      await pending.promise;
      return { tag: "latest", version: candidate.version };
    });
  } else if (stage === "download") {
    mocks.prepare.mockImplementationOnce(async () => {
      await pending.promise;
      return candidate;
    });
  } else if (stage === "preflight") {
    mocks.compatible.mockImplementationOnce(async () => await pending.promise);
  } else {
    host.runtime.tryPauseForUpdate.mockImplementationOnce(async () => {
      await pending.promise;
      return true;
    });
  }
  return pending;
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
    { label: "host-owned installation", launcher: true, kind: "host" },
    { label: "node setting", config: { nodeHost: { autoUpdate: { enabled: false } } } },
    { label: "startup check setting", config: { update: { checkOnStart: false } } },
    { label: "dev channel", config: { update: { channel: "dev" } } },
    { label: "extended-stable channel", config: { update: { channel: "extended-stable" } } },
  ] satisfies Array<{
    label: string;
    launcher?: boolean;
    kind?: string;
    config?: OpenClawConfig;
  }>)(
    "does not schedule updates for $label",
    async ({ launcher = true, kind = "package", config = {} }) => {
      mocks.launcherChild.mockReturnValue(launcher);
      mocks.installKind.mockResolvedValue(kind);
      mocks.config = config;
      start();
      await vi.advanceTimersByTimeAsync(24 * HOUR);
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

    host.runtime.tryPauseForUpdate.mockResolvedValue(true);
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
    { stage: "discovery", change: "disabled" },
    { stage: "discovery", change: "channel" },
    { stage: "download", change: "disabled" },
    { stage: "download", change: "channel" },
    { stage: "preflight", change: "disabled" },
    { stage: "preflight", change: "channel" },
    { stage: "preflight", change: "interval" },
  ] as const)(
    "rechecks $change changed during $stage before activation",
    async ({ stage, change }) => {
      const host = start();
      const pending = holdStage(stage, host);
      await vi.advanceTimersByTimeAsync(0);
      expect(
        { discovery: mocks.discover, download: mocks.prepare, preflight: mocks.compatible }[stage],
      ).toHaveBeenCalledOnce();
      if (change === "interval") {
        mocks.lstat.mockResolvedValue({ mtimeMs: Date.now() });
      } else {
        mocks.config =
          change === "disabled"
            ? { nodeHost: { autoUpdate: { enabled: false } } }
            : { update: { channel: "beta" } };
      }
      pending.resolve();
      await vi.advanceTimersByTimeAsync(0);
      if (stage === "discovery") {
        expect(mocks.prepare).not.toHaveBeenCalled();
      }
      expect(mocks.restart).not.toHaveBeenCalled();
      expect(host.onRestartAccepted).not.toHaveBeenCalled();
      expect(host.runtime.resumeAfterUpdate).toHaveBeenCalledTimes(stage === "preflight" ? 1 : 0);
    },
  );

  it.each(["download", "preflight", "idle"] as const)(
    "cancels and joins pending $stage cleanup before stop resolves",
    async (stage) => {
      const host = start();
      const pending = holdStage(stage, host);
      await vi.advanceTimersByTimeAsync(0);
      const invocation =
        stage === "download" ? mocks.prepare.mock.calls[0] : mocks.compatible.mock.calls[0];
      if (stage === "idle") {
        expect(host.runtime.tryPauseForUpdate).toHaveBeenCalledOnce();
        expect(mocks.compatible).not.toHaveBeenCalled();
        expect(mocks.restart).not.toHaveBeenCalled();
      } else {
        expect(invocation?.[0].signal?.aborted).toBe(false);
      }
      let stopped = false;
      const stopping = host.controller.stop().then(() => {
        stopped = true;
      });
      if (stage !== "idle") {
        expect(invocation?.[0].signal?.aborted).toBe(true);
      }
      await vi.advanceTimersByTimeAsync(0);
      expect(stopped).toBe(false);
      pending.resolve();
      await stopping;
      expect(stopped).toBe(true);
      if (stage === "idle") {
        expect(mocks.compatible).not.toHaveBeenCalled();
      }
      expect(mocks.restart).not.toHaveBeenCalled();
      expect(host.onRestartAccepted).not.toHaveBeenCalled();
      expect(host.runtime.resumeAfterUpdate).toHaveBeenCalledTimes(stage === "download" ? 0 : 1);
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

describe("node auto-update discovery runtime", () => {
  const bunVersion = Object.getOwnPropertyDescriptor(process.versions, "bun");
  const useRuntime = (runtime: "bun" | "node") => {
    if (runtime === "bun") {
      Object.defineProperty(process.versions, "bun", { value: "1.4.3", configurable: true });
    } else {
      Reflect.deleteProperty(process.versions, "bun");
    }
  };

  beforeEach(async () => {
    const actual = await vi.importActual<typeof import("../infra/update-check.js")>(
      "../infra/update-check.js",
    );
    mocks.discover.mockImplementation(actual.resolveNpmChannelTag);
    vi.stubGlobal("fetch", mocks.fetch);
  });

  afterEach(() => {
    if (bunVersion) {
      Object.defineProperty(process.versions, "bun", bunVersion);
    } else {
      Reflect.deleteProperty(process.versions, "bun");
    }
    vi.unstubAllGlobals();
  });

  it.each(["bun", "node"] as const)(
    "uses the %s registry transport to discover a candidate",
    async (runtime) => {
      useRuntime(runtime);
      const registryUrl = "http://127.0.0.1:4873/";
      const stdout = JSON.stringify({ version: candidate.version });
      if (runtime === "bun") {
        vi.stubEnv("OPENCLAW_UPDATE_PACKAGE_SPEC", "openclaw");
        vi.stubEnv("NPM_CONFIG_REGISTRY", registryUrl);
        mocks.fetch.mockResolvedValue(new Response(stdout));
      } else {
        mocks.exec.mockResolvedValue({
          stdout,
          stderr: "",
          code: 0,
          signal: null,
          killed: false,
          termination: "exit",
        });
      }
      start();
      await vi.advanceTimersByTimeAsync(0);
      if (runtime === "bun") {
        expect(mocks.exec).not.toHaveBeenCalled();
        expect(mocks.fetch).toHaveBeenCalledWith(
          `${registryUrl}openclaw/latest`,
          expect.objectContaining({ signal: expect.any(AbortSignal) }),
        );
      } else {
        expect(mocks.fetch).not.toHaveBeenCalled();
        expect(mocks.exec).toHaveBeenCalledWith(
          [
            "npm",
            "view",
            "openclaw@latest",
            "version",
            "engines.node",
            "openclaw.schemaVersions",
            "--json",
            "--global",
          ],
          expect.objectContaining({ signal: expect.any(AbortSignal) }),
        );
      }
      expect(mocks.prepare).toHaveBeenCalledWith(
        expect.objectContaining({ targetVersion: candidate.version }),
      );
    },
  );

  it("cancels an in-flight Bun registry read when the node stops", async () => {
    useRuntime("bun");
    mocks.fetch.mockImplementation(
      async (_url, init) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("registry aborted")), {
            once: true,
          });
        }),
    );
    const host = start();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.fetch).toHaveBeenCalledOnce();
    await host.controller.stop();
    expect(mocks.prepare).not.toHaveBeenCalled();
  });
});
