import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { OpenClawConfig } from "../config/config.js";
import { createCommandResult } from "../test-utils/npm-spec-install-test-helpers.js";
import type { PreparedNodeRuntimeUpdate } from "./auto-update-install.js";
import { startNodeHostAutoUpdate } from "./auto-update.js";
import { useNodeUpdateRuntime } from "./auto-update.test-support.js";

const mocks = vi.hoisted(() => ({
  config: {} as OpenClawConfig,
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
    signal: new AbortController().signal,
  });
  controllers.push(controller);
  const { discover, prepare, compatible, restart } = mocks;
  const { tryPauseForUpdate: pause, resumeAfterUpdate: resume } = runtime;
  const calls = {
    discover,
    prepare,
    compatible,
    restart,
    pause,
    resume,
    accepted: onRestartAccepted,
  };
  return {
    runtime,
    log,
    controller,
    async advance(ms: number, expected: Partial<Record<keyof typeof calls, number>>) {
      await vi.advanceTimersByTimeAsync(ms);
      expect(
        Object.fromEntries(
          Object.entries(calls).map(([name, mock]) => [name, mock.mock.calls.length]),
        ),
      ).toMatchObject(expected);
    },
  };
}

function holdStage(stage: "download" | "preflight" | "idle", host: ReturnType<typeof start>) {
  const pending = hold<void>(undefined);
  if (stage === "download") {
    mocks.prepare.mockImplementationOnce(() => pending.promise.then(() => candidate));
  } else if (stage === "preflight") {
    mocks.compatible.mockImplementationOnce(() => pending.promise);
  } else {
    host.runtime.tryPauseForUpdate.mockImplementationOnce(() => pending.promise.then(() => true));
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
  mocks.readConfig.mockImplementation(async () => ({
    valid: true,
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
    const host = start();
    await host.advance(0, { discover: 1 });
    await host.advance(HOUR - 1, { discover: 1 });
    await host.advance(1, { discover: 2 });
    await host.advance(HOUR, { discover: 3, prepare: 0, restart: 0 });
  });

  it.each([
    ["unmanaged process", false, "package", {}],
    ["source checkout", true, "git", {}],
    ["node setting", true, "package", { nodeHost: { autoUpdate: { enabled: false } } }],
    ["startup check setting", true, "package", { update: { checkOnStart: false } }],
    ["dev channel", true, "package", { update: { channel: "dev" } }],
    ["extended-stable channel", true, "package", { update: { channel: "extended-stable" } }],
  ] satisfies [string, boolean, string, OpenClawConfig][])(
    "does not schedule updates for %s",
    async (_label, launcher, kind, config) => {
      mocks.launcherChild.mockReturnValue(launcher);
      mocks.installKind.mockResolvedValue(kind);
      mocks.config = config;
      await start().advance(24 * HOUR, { discover: 0, prepare: 0 });
    },
  );

  it("uses the committed runtime pointer time and allows activation at exactly twelve hours", async () => {
    mocks.lstat.mockResolvedValue({ mtimeMs: Date.now() - 11 * HOUR });
    const host = start();
    await host.advance(0, { prepare: 0 });
    expect(mocks.lstat).toHaveBeenCalledWith(
      path.join("/synthetic-node-state", "node-runtime", "current"),
    );
    await host.advance(HOUR - 1, { prepare: 0 });
    await host.advance(1, { prepare: 1, accepted: 1 });
    expect(mocks.restart).toHaveBeenCalledWith({
      runtimeRoot: candidate.runtimeRoot,
      version: candidate.version,
    });
  });

  it("stages once while busy and waits for the parent acknowledgment before requesting shutdown", async () => {
    const acknowledgment = hold<void>(undefined);
    mocks.restart.mockImplementation(async () => await acknowledgment.promise);
    const host = start(true);
    await host.advance(0, { prepare: 1, compatible: 0, restart: 0 });
    await host.advance(30_000, { pause: 2, prepare: 1, discover: 1 });
    host.runtime.tryPauseForUpdate.mockResolvedValue(true);
    await host.advance(30_000, { restart: 1, accepted: 0, resume: 0 });
    acknowledgment.resolve();
    await host.advance(0, { accepted: 1 });
    await host.controller.stop();
    expect(host.runtime.resumeAfterUpdate).not.toHaveBeenCalled();
  });

  it.each(["disabled", "channel", "interval"] as const)(
    "rechecks %s changed during preflight before activation",
    async (change) => {
      const host = start();
      const pending = holdStage("preflight", host);
      await host.advance(0, { compatible: 1 });
      if (change === "interval") {
        mocks.lstat.mockResolvedValue({ mtimeMs: Date.now() });
      } else {
        mocks.config =
          change === "disabled"
            ? { nodeHost: { autoUpdate: { enabled: false } } }
            : { update: { channel: "beta" } };
      }
      pending.resolve();
      await host.advance(0, { restart: 0, accepted: 0, resume: 1 });
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
      } else {
        expect(invocation?.[0].signal?.aborted).toBe(false);
      }
      const stopped = vi.fn();
      const stopping = host.controller.stop().then(stopped);
      if (stage !== "idle") {
        expect(invocation?.[0].signal?.aborted).toBe(true);
      }
      await vi.advanceTimersByTimeAsync(0);
      expect(stopped).not.toHaveBeenCalled();
      pending.resolve();
      await stopping;
      if (stage === "idle") {
        expect(mocks.compatible).not.toHaveBeenCalled();
      }
      await host.advance(0, { restart: 0, accepted: 0, resume: stage === "download" ? 0 : 1 });
    },
  );

  it.each(["download", "preflight", "restart"] as const)(
    "keeps the running node available after a $stage failure and retries hourly",
    async (stage) => {
      const error = new Error(`${stage} fixture failure`);
      const failing = {
        download: mocks.prepare,
        preflight: mocks.compatible,
        restart: mocks.restart,
      };
      failing[stage].mockRejectedValueOnce(error);
      const host = start();
      await host.advance(0, { accepted: 0, resume: stage === "download" ? 0 : 1 });
      expect(host.log).toHaveBeenCalledWith(expect.stringContaining(error.message));
      await host.advance(HOUR - 1, { prepare: 1 });
      await host.advance(1, { prepare: 2, accepted: 1 });
    },
  );
});

describe("node auto-update discovery runtime", () => {
  const useRuntime = useNodeUpdateRuntime();

  beforeEach(async () => {
    const actual = await vi.importActual<typeof import("../infra/update-check.js")>(
      "../infra/update-check.js",
    );
    mocks.discover.mockImplementation(actual.resolveNpmChannelTag);
    vi.stubGlobal("fetch", mocks.fetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("stages the candidate discovered by npm", async () => {
    useRuntime("node");
    mocks.exec.mockResolvedValue(
      createCommandResult({ stdout: JSON.stringify({ version: candidate.version }) }),
    );
    await start().advance(0, { prepare: 1 });
    expect(mocks.prepare).toHaveBeenCalledWith(
      expect.objectContaining({ targetVersion: candidate.version }),
    );
  });

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
