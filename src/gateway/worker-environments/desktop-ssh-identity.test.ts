import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkerSshIdentityRequest } from "../../plugins/types.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { resolveWorkerSshIdentity } from "./identity.js";
import * as support from "./service.test-support.js";
import { createWorkerTunnelManager } from "./tunnel.js";
import { fakeRunner, success } from "./tunnel.test-support.js";

const MATERIAL = "synthetic-desktop-identity";
type Operation = "observe" | "launch";
async function fixture(operation: Operation) {
  const entered = createDeferredCore<WorkerSshIdentityRequest>();
  const release = createDeferredCore();
  const providerSettled = release.promise.then(() => ({
    kind: "material" as const,
    contents: MATERIAL,
  }));
  const provider = support.createProvider({
    resolveSshIdentity: (request) => {
      entered.resolve(request);
      return providerSettled;
    },
  });
  const fake = fakeRunner();
  const start = fake.runner.start.bind(fake.runner);
  fake.runner.start = (argv, options) => {
    const child = start(argv, options);
    fake.starts.at(-1)!.process.becomeReady();
    return child;
  };
  const manager = createWorkerTunnelManager({ runner: fake.runner });
  const service = support.createService(provider, {
    tunnelManager: manager,
    // Exceed the desktop deadline so only the caller-lifetime fence can win.
    providerCallTimeoutMs: 120_000,
    resolveSshIdentity: (request) =>
      resolveWorkerSshIdentity({
        ...request,
        resolveGeneric: async () => {
          throw new Error("unexpected generic identity lookup");
        },
      }),
  });
  const environment = await support.seedReadyDesktop("desktop-identity", {
    ...support.DESKTOP,
    passwordFilePath: undefined,
  });
  const credential = support.testState.store.getCredential(environment.environmentId);
  const writes = vi.spyOn(fs, "writeFile"); // Pass-through: detects even transient writes.
  const remove = fs.rm.bind(fs);
  const removals = vi.spyOn(fs, "rm");
  const preparedRemoved = createDeferredCore();
  removals.mockImplementation(async (...args) => {
    await remove(...args);
    if (String(args[0]).includes("openclaw-worker-desktop")) {
      preparedRemoved.resolve();
    }
  });
  const pending = observeOutcome(
    operation === "observe"
      ? service.observeDesktop({ environmentId: environment.environmentId, control: false })
      : service.launchDesktopApp({ environmentId: environment.environmentId, app: "browser" }),
  );
  const commandRelease = createDeferredCore();
  let closing: Promise<unknown> | undefined;
  const assertLeaseUnchanged = () => {
    expect(support.testState.store.get(environment.environmentId)).toEqual(environment);
    expect(support.testState.store.getCredential(environment.environmentId)).toEqual(credential);
  };
  return {
    release,
    fake,
    writes,
    removals,
    preparedRemoved,
    pending,
    commandRelease,
    request: entered.promise,
    assertLeaseUnchanged,
    async resolve() {
      release.resolve();
      await providerSettled;
    },
    stop: () => manager.desktop.stop(environment.environmentId, environment.ownerEpoch),
    close(closure: "stop" | "replace-observe" | "replace-launch") {
      const replacement = {
        environmentId: environment.environmentId,
        ownerEpoch: environment.ownerEpoch + 1,
        ssh: support.SSH_ENDPOINT,
        resolveIdentity: async () => ({
          kind: "material" as const,
          contents: "replacement-identity",
        }),
      };
      closing = observeOutcome(
        closure === "stop"
          ? manager.desktop.stop(environment.environmentId, environment.ownerEpoch)
          : closure === "replace-observe"
            ? manager.desktop.acquire({ ...replacement, desktop: { protocol: "rfb", port: 5900 } })
            : manager.desktop.launchApp({ ...replacement, app: support.DESKTOP.apps![0]! }),
      );
    },
    async [Symbol.asyncDispose]() {
      // Release gates before joining teardown; neither owner may wait on the test.
      release.resolve();
      commandRelease.resolve();
      await providerSettled;
      await pending;
      await closing;
      await manager.stopAll();
      vi.useRealTimers();
      assertLeaseUnchanged();
    },
  };
}

function observeOutcome(operation: Promise<unknown>) {
  return operation.then(
    (value) => ({ status: "fulfilled" as const, value }),
    (error: unknown) => ({ status: "rejected" as const, error }),
  );
}

describe.skipIf(process.platform === "win32")("desktop SSH identity caller lifetime", () => {
  support.setupWorkerEnvironmentServiceSuite();
  afterEach(() => vi.restoreAllMocks());

  it.each([
    ["observe", "stop"],
    ["observe", "replace-observe"],
    ["observe", "replace-launch"],
    ["launch", "stop"],
    ["launch", "replace-observe"],
    ["launch", "replace-launch"],
    ["launch", "timeout"],
  ] as const)("fences %s on %s before late key writes", async (operation, closure) => {
    if (closure === "timeout") {
      vi.useFakeTimers();
    }
    await using f = await fixture(operation);
    const { pending } = f;
    const request = await f.request;
    expect(request.assertCurrent).toBeTypeOf("function");
    expect(() => request.assertCurrent!()).not.toThrow();
    f.assertLeaseUnchanged();
    if (closure === "timeout") {
      await vi.advanceTimersByTimeAsync(29_999);
      expect(() => request.assertCurrent!()).not.toThrow();
      await vi.advanceTimersByTimeAsync(1);
      expect(await pending).toMatchObject({
        status: "rejected",
        error: { code: "launcher_failure" },
      });
    } else {
      f.close(closure);
    }
    f.assertLeaseUnchanged();
    expect(() => request.assertCurrent!()).toThrow();
    // Identify the old directory without confusing valid replacement writes.
    await f.resolve();
    await f.preparedRemoved.promise;
    expect(await pending).toMatchObject({ status: "rejected" });
    const removedDirectory = String(
      f.removals.mock.calls.find(([target]) =>
        String(target).includes("openclaw-worker-desktop"),
      )![0],
    );
    expect(
      f.writes.mock.calls.filter(
        ([target]) => typeof target === "string" && path.dirname(target) === removedDirectory,
      ),
    ).toEqual([]);
    await expect(fs.access(removedDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    f.assertLeaseUnchanged();
  });

  it.each(["observe", "launch"] as const)(
    "allows %s and disposes private files independently",
    async (operation) => {
      await using f = await fixture(operation);
      const { pending, commandRelease } = f;
      const request = await f.request;
      const commandEntered = createDeferredCore<string[]>();
      if (operation === "launch") {
        f.fake.runner.run = async (argv) => {
          commandEntered.resolve(argv);
          await commandRelease.promise;
          return success();
        };
      }
      expect(() => request.assertCurrent!()).not.toThrow();
      f.release.resolve();
      let argv: string[];
      if (operation === "launch") {
        argv = await commandEntered.promise;
      } else {
        expect(await pending).toMatchObject({ status: "fulfilled", value: { transport: "rfb" } });
        argv = f.fake.starts[0]!.argv;
      }
      const identityPath = argv[argv.indexOf("-i") + 1]!;
      const directory = path.dirname(identityPath);
      expect(await fs.readFile(identityPath, "utf8")).toBe(MATERIAL + "\n");
      expect((await fs.stat(directory)).mode & 0o777).toBe(0o700);
      for (const file of ["identity", "known_hosts"]) {
        expect((await fs.stat(path.join(directory, file))).mode & 0o777).toBe(0o600);
      }
      expect(await fs.readFile(path.join(directory, "known_hosts"), "utf8")).toContain(
        support.SSH_ENDPOINT.hostKey,
      );
      // Provider authority closes on resolution; disposal must not reuse that guard.
      expect(() => request.assertCurrent!()).toThrow("identity invocation is closed");
      commandRelease.resolve();
      expect(await pending).toMatchObject({ status: "fulfilled" });
      await f.stop();
      await expect(fs.access(directory)).rejects.toMatchObject({ code: "ENOENT" });
      f.assertLeaseUnchanged();
    },
  );
});
