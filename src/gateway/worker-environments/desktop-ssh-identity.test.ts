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
type Closure = "stop" | "replace-observe" | "replace-launch" | "timeout";

// Only the SSH process boundary is synthetic: service, SQLite lease ownership,
// provider invocation, desktop registry, identity preparation, and files are real.
async function fixture(cooperating: boolean) {
  const entered = createDeferredCore<WorkerSshIdentityRequest>();
  const release = createDeferredCore();
  const providerSettled = createDeferredCore();
  const marker = path.join(support.testState.root, "provider-effect");
  const provider = support.createProvider({
    resolveSshIdentity: async (request) => {
      entered.resolve(request);
      try {
        await release.promise;
        if (cooperating) {
          if (!request.assertCurrent) {
            throw new Error("missing identity assertion");
          }
          request.assertCurrent();
          await fs.writeFile(marker, "synthetic provider effect");
        }
        return { kind: "material", contents: MATERIAL };
      } finally {
        providerSettled.resolve();
      }
    },
  });
  const fake = fakeRunner(() => success());
  const start = fake.runner.start.bind(fake.runner);
  fake.runner.start = (argv, options) => {
    const child = start(argv, options);
    fake.starts.at(-1)!.process.becomeReady();
    return child;
  };
  const manager = createWorkerTunnelManager({ runner: fake.runner });
  const service = support.createService(provider, {
    tunnelManager: manager,
    // Longer than the actual desktop deadline; provider timeout cannot prove this fence.
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
  const startOperation = (operation: Operation) =>
    operation === "observe"
      ? service.observeDesktop({ environmentId: environment.environmentId, control: false })
      : service.launchDesktopApp({ environmentId: environment.environmentId, app: "browser" });
  const assertLeaseUnchanged = () => {
    expect(support.testState.store.get(environment.environmentId)).toEqual(environment);
    expect(support.testState.store.getCredential(environment.environmentId)).toEqual(credential);
  };
  return {
    entered,
    release,
    providerSettled,
    marker,
    fake,
    manager,
    service,
    environment,
    writes,
    removals,
    preparedRemoved,
    startOperation,
    assertLeaseUnchanged,
  };
}

function observeOutcome(operation: Promise<unknown>) {
  return operation.then(
    (value) => ({ status: "fulfilled" as const, value }),
    (error: unknown) => ({ status: "rejected" as const, error }),
  );
}

const revokedCases: Array<{ operation: Operation; closure: Closure }> = [
  { operation: "observe", closure: "stop" },
  { operation: "observe", closure: "replace-observe" },
  { operation: "observe", closure: "replace-launch" },
  { operation: "launch", closure: "stop" },
  { operation: "launch", closure: "replace-observe" },
  { operation: "launch", closure: "replace-launch" },
  { operation: "launch", closure: "timeout" },
];

describe.skipIf(process.platform === "win32")("desktop SSH identity caller lifetime", () => {
  support.setupWorkerEnvironmentServiceSuite();
  afterEach(() => vi.restoreAllMocks());

  describe.each([true, false])("cooperating provider: %s", (cooperating) => {
    it.each(revokedCases)(
      "fences $operation on $closure before provider/key effects",
      async ({ operation, closure }) => {
        if (closure === "timeout") {
          vi.useFakeTimers();
        }
        const f = await fixture(cooperating);
        const pending = observeOutcome(f.startOperation(operation));
        let closing: Promise<unknown> | undefined;
        try {
          const request = await f.entered.promise;
          expect(request.assertCurrent).toBeTypeOf("function");
          expect(() => request.assertCurrent!()).not.toThrow();
          f.assertLeaseUnchanged();
          if (closure === "stop") {
            closing = observeOutcome(
              f.manager.desktop.stop(f.environment.environmentId, f.environment.ownerEpoch),
            );
          } else if (closure === "timeout") {
            await vi.advanceTimersByTimeAsync(29_999);
            expect(() => request.assertCurrent!()).not.toThrow();
            await vi.advanceTimersByTimeAsync(1);
            expect(await pending).toMatchObject({
              status: "rejected",
              error: { code: "launcher_failure" },
            });
          } else {
            // Advance the real desktop owner without changing the provider's SQLite lease.
            // Check synchronously: a cross-operation claimant fences even before async teardown.
            const replacement = {
              environmentId: f.environment.environmentId,
              ownerEpoch: f.environment.ownerEpoch + 1,
              ssh: support.SSH_ENDPOINT,
              resolveIdentity: async () => ({
                kind: "material" as const,
                contents: "replacement-identity",
              }),
            };
            closing = observeOutcome(
              closure === "replace-observe"
                ? f.manager.desktop.acquire({
                    ...replacement,
                    desktop: { protocol: "rfb", port: 5900 },
                  })
                : f.manager.desktop.launchApp({ ...replacement, app: support.DESKTOP.apps![0]! }),
            );
          }
          f.assertLeaseUnchanged();
          expect(() => request.assertCurrent!()).toThrow();
          // The original preparation is disposed before replacement startup. Its unique
          // directory identifies late writes without confusing valid replacement files.
          f.release.resolve();
          await f.providerSettled.promise;
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
          await expect(fs.access(f.marker)).rejects.toMatchObject({ code: "ENOENT" });
          await expect(fs.access(removedDirectory)).rejects.toMatchObject({ code: "ENOENT" });
          await closing;
          f.assertLeaseUnchanged();
        } finally {
          // Joined cleanup must never wait on a provider gate owned by this test.
          f.release.resolve();
          await f.providerSettled.promise;
          await pending;
          await closing;
          await f.manager.stopAll();
          vi.useRealTimers();
        }
      },
    );

    it.each(["observe", "launch"] as const)(
      "allows %s and disposes private files independently",
      async (operation) => {
        const f = await fixture(cooperating);
        const pending = observeOutcome(f.startOperation(operation));
        const commandEntered = createDeferredCore<string[]>();
        const commandRelease = createDeferredCore();
        if (operation === "launch") {
          f.fake.runner.run = async (argv) => {
            commandEntered.resolve(argv);
            await commandRelease.promise;
            return success();
          };
        }
        try {
          const request = await f.entered.promise;
          expect(() => request.assertCurrent!()).not.toThrow();
          f.release.resolve();
          let argv: string[];
          if (operation === "launch") {
            argv = await commandEntered.promise;
          } else {
            expect(await pending).toMatchObject({
              status: "fulfilled",
              value: { transport: "rfb" },
            });
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
          if (cooperating) {
            expect(await fs.readFile(f.marker, "utf8")).toBe("synthetic provider effect");
          }
          // Provider authority closes on resolution; disposal must not reuse that guard.
          expect(() => request.assertCurrent!()).toThrow("identity invocation is closed");
          commandRelease.resolve();
          expect(await pending).toMatchObject({ status: "fulfilled" });
          await f.manager.desktop.stop(f.environment.environmentId, f.environment.ownerEpoch);
          await expect(fs.access(directory)).rejects.toMatchObject({ code: "ENOENT" });
          f.assertLeaseUnchanged();
        } finally {
          f.release.resolve();
          commandRelease.resolve();
          await pending;
          await f.manager.stopAll();
        }
      },
    );
  });
});
