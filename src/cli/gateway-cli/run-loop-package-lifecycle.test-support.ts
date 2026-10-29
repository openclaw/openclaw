import { randomUUID } from "node:crypto";
import { once } from "node:events";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import {
  openFixtureReceiptChannel,
  type FixtureReceiptChannel,
} from "../../../test/helpers/fixture-receipts.js";
import { withinTest } from "../../../test/helpers/promise.js";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { withTimeout } from "../../infra/fs-safe.js";
import type { GatewayRestartIntent } from "../../infra/restart-intent.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { resolveTestNodeExecPath } from "../../test-utils/node-process.js";
import { withRunLoopCleanup } from "./run-loop-cleanup.test-support.js";
import {
  gateFixtureHandoffPublication,
  observeFixtureHelper,
  startPackageLifecycleStopFixture,
  writePackageLifecycleFixture,
} from "./run-loop-package-helper.test-support.js";
import { expectUncalled, type UpdateRespawnFixtures } from "./run-loop.test-support.js";

/** Real package staging, helper IPC and run-loop Stop share one held script. */
export function registerPackageLifecycleStopTests(fixtures: UpdateRespawnFixtures): void {
  let receipts: FixtureReceiptChannel;
  beforeAll(async () => {
    receipts = await openFixtureReceiptChannel();
  });
  afterAll(async () => {
    await receipts?.close();
  });
  it.runIf(fixtures.originalPlatformDescriptor?.value !== "win32").for([
    { signal: "SIGINT", uncertain: false, closeFailure: false, phase: "staging" },
    { signal: "SIGTERM", uncertain: true, closeFailure: false, phase: "staging" },
    { signal: "SIGINT", uncertain: false, closeFailure: true, phase: "staging" },
    { signal: "SIGINT", uncertain: false, closeFailure: false, phase: "completion" },
    { signal: "SIGINT", uncertain: false, closeFailure: false, phase: "preparing" },
    { signal: "SIGTERM", uncertain: false, closeFailure: false, phase: "pre-transfer" },
    { signal: "hosted Gateway stop", uncertain: false, closeFailure: false, phase: "staging" },
  ] as const)(
    "joins pre-park package lifecycle before $signal (phase=$phase, uncertain=$uncertain, closeFailure=$closeFailure)",
    { timeout: 60000 },
    async ({ signal, uncertain, closeFailure, phase }, context) => {
      const hosted = signal === "hosted Gateway stop";
      fixtures.setPlatform(fixtures.originalPlatformDescriptor!.value);
      const dirs = createTempDirTracker();
      // The runner removes its TMPDIR after failure; unresolved ownership evidence
      // must survive that outer cleanup until its test owner can inspect it.
      const evidenceRoot = path.resolve(".artifacts", "run-loop-package-lifecycle");
      await fs.mkdir(evidenceRoot, { recursive: true });
      const home = dirs.make("case-", await fs.realpath(evidenceRoot));
      let preserveArtifacts = false;
      const root = path.join(home, "prefix", "lib", "node_modules", "openclaw");
      const control = path.join(home, "control");
      const readControl = (name: string) => fs.readFile(path.join(control, name), "utf8");
      const controlExists = (name: string) => fsSync.existsSync(path.join(control, name));
      const configPath = path.join(home, "openclaw.json");
      const releasePath = path.join(control, "release-script");
      await fs.mkdir(path.join(root, "dist", "cli"), { recursive: true });
      await fs.mkdir(control);
      await fs.writeFile(configPath, "{}");
      await fs.writeFile(
        path.join(root, "package.json"),
        JSON.stringify({ name: "openclaw", version: "1.0.0", type: "module" }),
      );
      await fs.writeFile(path.join(root, "dist", "index.js"), "export {};\n");
      const entrypoint = await writePackageLifecycleFixture(root, control, receipts.endpoint);
      try {
        context.signal.throwIfAborted();
        const work = withEnvAsync(
          {
            HOME: home,
            OPENCLAW_HOME: undefined,
            OPENCLAW_STATE_DIR: home,
            OPENCLAW_CONFIG_PATH: configPath,
            TSX_TSCONFIG_PATH: path.resolve("tsconfig.json"),
          },
          async () => {
            const sockets = new Set<Socket>();
            const server = createServer((socket) => {
              sockets.add(socket);
              socket.once("close", () => sockets.delete(socket));
              socket.end("serving");
            });
            const closeServer = async () => {
              if (server.listening) {
                await new Promise<void>((resolve) => {
                  server.close(() => resolve());
                  // Synthetic health probes own no request work after the fixture response.
                  for (const socket of sockets) {
                    socket.destroy();
                  }
                });
              }
            };
            server.listen(0, "127.0.0.1");
            await once(server, "listening");
            const address = server.address();
            if (!address || typeof address === "string") {
              throw new Error("missing fixture port");
            }
            const actualLock = await vi.importActual<typeof import("../../infra/gateway-lock.js")>(
              "../../infra/gateway-lock.js",
            );
            const gatewayLock: {
              current?: NonNullable<Awaited<ReturnType<typeof actualLock.acquireGatewayLock>>>;
            } = {};
            fixtures.acquireGatewayLock.mockImplementationOnce(async () => {
              const lock = await actualLock.acquireGatewayLock({
                allowInTests: true,
                port: address.port,
                listenerMode: "foreground",
                supervisor: null,
              });
              if (!lock) {
                throw new Error("missing fixture Gateway lock");
              }
              gatewayLock.current = lock;
              return { release: vi.fn(() => lock.release()) };
            });
            try {
              await fixtures.withIsolatedSignals(async ({ captureSignal }) => {
                const close = vi.fn(async () => {
                  await closeServer();
                  if (closeFailure) {
                    throw new Error("fixture Gateway close failed");
                  }
                });
                let released = false;
                const stop = await startPackageLifecycleStopFixture({
                  fixtures,
                  control,
                  signal,
                  close,
                  lockPort: address.port,
                  isReleased: () => released,
                  isServing: () => server.listening,
                  captureSignal,
                });
                const { runtime, exited, requestStop } = stop;
                const temporary = await import("../../infra/tmp-openclaw-dir.js");
                const temporarySpy = vi
                  .spyOn(temporary, "resolvePreferredOpenClawTmpDir")
                  .mockReturnValue(control);
                const handoff = await vi.importActual<
                  typeof import("../../infra/update-managed-service-handoff.js")
                >("../../infra/update-managed-service-handoff.js");
                const admission = await vi.importActual<
                  typeof import("../../process/gateway-work-admission.js")
                >("../../process/gateway-work-admission.js");
                const commandQueue = await import("../../process/command-queue.js");
                const drain = vi
                  .spyOn(commandQueue, "markGatewayDraining")
                  .mockImplementation(admission.markGatewayRestartDraining);
                fixtures.claimManagedServiceUpdateHandoff.mockImplementation(
                  handoff.claimManagedServiceUpdateHandoff,
                );
                fixtures.isForegroundUpdateHandoff.mockImplementation(
                  handoff.isForegroundUpdateHandoff,
                );
                fixtures.requestManagedServiceUpdateHandoffPark.mockImplementation(
                  handoff.requestManagedServiceUpdateHandoffPark,
                );
                fixtures.completeForegroundUpdateHandoffAfterClose.mockImplementation(
                  handoff.completeForegroundUpdateHandoffAfterClose,
                );
                if (phase === "completion") {
                  const emptyCoordinator = path.join(home, "different-empty-coordinator");
                  await fs.mkdir(emptyCoordinator);
                  fixtures.completeForegroundUpdateHandoffAfterClose.mockImplementationOnce(
                    (identity) => {
                      expect(close).toHaveBeenCalledOnce();
                      expect(server.listening).toBe(false);
                      temporarySpy.mockReturnValue(emptyCoordinator);
                      return handoff.completeForegroundUpdateHandoffAfterClose(identity);
                    },
                  );
                }
                fixtures.captureForegroundUpdateHandoffStop.mockImplementation(
                  handoff.captureForegroundUpdateHandoffStop,
                );
                fixtures.cancelManagedServiceUpdateHandoff.mockImplementation(
                  handoff.cancelManagedServiceUpdateHandoff,
                );
                const { readGatewayOwnerLease } =
                  await import("../../infra/gateway-owner-lease.js");
                const { resolvePathViaExistingAncestorSync } =
                  await import("../../infra/boundary-path.js");
                const { resolveOpenClawStateSqlitePath } =
                  await import("../../state/openclaw-state-db.paths.js");
                const ledger = await import("../../infra/update-run-ledger.js");
                const { createManagedHandoffLeaseStore } =
                  await import("../../infra/update-managed-service-handoff-lease.js");
                const owner = readGatewayOwnerLease({ current: true });
                if (!owner || owner.startedAt === null) {
                  throw new Error("missing foreground owner");
                }
                const ownerStartedAt = owner.startedAt;
                const run = ledger.createUpdateRun({ trigger: "api" });
                const store = createManagedHandoffLeaseStore();
                const identity: NonNullable<GatewayRestartIntent["successorOwner"]> = {
                  kind: "managed-update-handoff",
                  handoffId: randomUUID(),
                  installRoot: root,
                };
                const helper = await observeFixtureHelper(
                  root,
                  identity.handoffId,
                  fixtures.spawnProcess,
                );
                const preparing =
                  phase === "preparing"
                    ? await gateFixtureHandoffPublication(root, identity.handoffId)
                    : undefined;
                let abortRelease: Promise<void> | undefined;
                const abort = () => {
                  released = true;
                  preparing?.release();
                  abortRelease ??= fs.writeFile(releasePath, "fixture cancellation");
                  void abortRelease.catch(() => {});
                };
                context.signal.addEventListener("abort", abort, { once: true });
                if (context.signal.aborted) {
                  abort();
                }
                let starting:
                  | ReturnType<typeof handoff.startManagedServiceUpdateHandoff>
                  | undefined;
                let lifecycleScriptPid: number | undefined;
                const cleanupErrors: unknown[] = [];
                const join = (pending: Promise<unknown> | undefined) =>
                  pending && withTimeout(pending, 15000);
                const settle = async (operation: () => unknown) => {
                  try {
                    await operation();
                  } catch (error) {
                    cleanupErrors.push(error);
                  }
                };
                const runScenario = async () => {
                  context.signal.throwIfAborted();
                  const handoffParams: Parameters<
                    typeof handoff.startManagedServiceUpdateHandoff
                  >[0] = {
                    root,
                    handoffId: identity.handoffId,
                    runId: run.runId,
                    execPath: resolveTestNodeExecPath(),
                    argv1: entrypoint,
                    restartDrainTimeoutMs: 30000,
                    timeoutMs: 30000,
                    supervisor: null,
                    meta: { runId: run.runId, completionOwner: "gateway-restart" },
                    foregroundOrigin: {
                      owner: owner.owner,
                      pid: owner.pid,
                      host: owner.host,
                      startedAt: ownerStartedAt,
                      port: address.port,
                      stateDatabasePath: resolvePathViaExistingAncestorSync(
                        resolveOpenClawStateSqlitePath(process.env),
                      ),
                      configPath: resolvePathViaExistingAncestorSync(configPath),
                    },
                    beforePark: async () => {
                      expect(handoff.claimManagedServiceUpdateHandoff(identity)).toBe(true);
                      expect(ledger.getUpdateRun(run.runId)?.status).toBe("running");
                      if (!admission.isGatewayRestartDraining()) {
                        fixtures.consumeGatewayRestartIntent.mockReturnValueOnce({
                          reason: "update.run",
                          successorOwner: identity,
                        });
                        captureSignal("SIGUSR2")();
                      }
                    },
                  };
                  const spawnedBeforeStart = fixtures.spawnProcess.mock.calls.length;
                  starting = handoff.startManagedServiceUpdateHandoff(handoffParams);
                  if (preparing) {
                    const startOutcome = starting.then(
                      (value) => ({ value }),
                      (error: unknown) => ({ error }),
                    );
                    await withTimeout(preparing.entered, 15000);
                    context.signal.throwIfAborted();
                    await requestStop();
                    expect(
                      stop.earlyExit,
                      "Stop exited while its helper preparation remained pending",
                    ).toBe(false);
                    expect(admission.isGatewayRestartDraining()).toBe(true);
                    expect(admission.isGatewayWorkAdmissionClosed()).toBe(true);
                    expect(fixtures.spawnProcess).toHaveBeenCalledTimes(spawnedBeforeStart);
                    released = true;
                    preparing.release();
                    await expect(startOutcome).resolves.toMatchObject({
                      error: { name: "GatewayDrainingError" },
                    });
                    expect(await withTimeout(exited, 15000)).toBe(0);
                    expect(fixtures.spawnProcess).toHaveBeenCalledTimes(spawnedBeforeStart);
                    expect(store.read(root).kind).toBe("absent");
                    expect(fixtures.respawnGatewayProcessForUpdate).not.toHaveBeenCalled();
                    expect(controlExists("script-entered")).toBe(false);
                    return;
                  }
                  const prepared = await starting;
                  context.signal.throwIfAborted();
                  if (prepared.status !== "started" || !prepared.handoffId) {
                    throw new Error("helper did not start");
                  }
                  expect(prepared.handoffId).toBe(identity.handoffId);
                  if (hosted) {
                    stop.observeHelper(prepared.pid);
                  }
                  if (phase === "pre-transfer") {
                    await requestStop();
                    expect(stop.earlyExit, "Stop exited before its ready helper settled").toBe(
                      false,
                    );
                    expect(admission.isGatewayRestartDraining()).toBe(true);
                    expect(await handoff.transferManagedServiceUpdateHandoff(identity)).toBe(false);
                    expect(runtime.exit).not.toHaveBeenCalled();
                    expect(store.read(root).kind).toBe("current");
                    released = true;
                    // The RPC caller already cancels when its transfer is refused.
                    // Process closure and lease absence establish the joined result.
                    await handoff.cancelManagedServiceUpdateHandoff(identity);
                    await withinTest(helper.waitForClose(), context.signal);
                    expect(await withTimeout(exited, 15000)).toBe(0);
                    expect(store.read(root).kind).toBe("absent");
                    expect(fixtures.respawnGatewayProcessForUpdate).not.toHaveBeenCalled();
                    expect(controlExists("script-entered")).toBe(false);
                    return;
                  }
                  expect(await handoff.transferManagedServiceUpdateHandoff(identity)).toBe(true);
                  // The script writes the marker before reporting on its separate receipt
                  // socket; helper close can overtake that socket's final delivery.
                  await withinTest(
                    Promise.race([
                      receipts.waitFor(control, "script-entered"),
                      helper.waitForClose().then(() => {
                        expect(controlExists("script-entered")).toBe(true);
                      }),
                    ]),
                    context.signal,
                  );
                  lifecycleScriptPid = Number(await readControl("script-entered"));
                  expect(controlExists("before-activate")).toBe(false);
                  const stage = JSON.parse(await readControl("stage.json")) as {
                    prefix: string;
                    packageRoot: string;
                  };
                  const pendingPath = path.join(stage.packageRoot, ".openclaw-lifecycle-pending");
                  const lockPath = path.join(stage.packageRoot, ".openclaw-lifecycle-lock");
                  context.signal.throwIfAborted();
                  expect(await fs.readFile(pendingPath, "utf8")).toBe(
                    "pending candidate lifecycle\n",
                  );
                  expect(handoff.claimManagedServiceUpdateHandoff(identity)).toBe(true);
                  // Observe the real Stop owner's wait or the regression's premature exit.
                  await requestStop();
                  expect(
                    stop.earlyExit,
                    `Stop exited before the held package lifecycle and helper settled. Helper log:\n${await fs.readFile(prepared.logPath, "utf8")}`,
                  ).toBe(false);
                  expect(admission.isGatewayRestartDraining()).toBe(true);
                  expect(admission.isGatewayWorkAdmissionClosed()).toBe(true);
                  if (hosted) {
                    await stop.expectHostedPending();
                  } else if (!uncertain && !closeFailure && phase !== "completion") {
                    const persistedReads =
                      fixtures.consumeGatewayRestartIntentPayload.mock.calls.length;
                    fixtures.consumeGatewayRestartIntentPayload.mockResolvedValueOnce({
                      reason: "update.run",
                    });
                    captureSignal("SIGTERM")();
                    await fixtures.waitForLoopCondition(
                      () =>
                        fixtures.consumeGatewayRestartIntentPayload.mock.calls.length ===
                        persistedReads + 1,
                      "persisted SIGTERM restart was not consumed",
                    );
                    await setImmediate();
                    expectUncalled(close, runtime.exit);
                    const localReads = fixtures.consumeGatewayRestartIntent.mock.calls.length;
                    fixtures.consumeGatewayRestartIntent.mockReturnValueOnce({
                      reason: "update.run",
                      successorOwner: identity,
                    });
                    captureSignal("SIGUSR2")();
                    await fixtures.waitForLoopCondition(
                      () =>
                        fixtures.consumeGatewayRestartIntent.mock.calls.length === localReads + 1,
                      "same-owner SIGUSR2 restart was not consumed",
                    );
                    await setImmediate();
                    expectUncalled(close, runtime.exit);
                    expect(server.listening).toBe(true);
                    expect(handoff.claimManagedServiceUpdateHandoff(identity)).toBe(true);
                    expect(
                      fixtures.completeForegroundUpdateHandoffAfterClose,
                    ).not.toHaveBeenCalled();
                  }
                  const secondRoot = path.join(home, "second-install");
                  await fs.mkdir(secondRoot);
                  const spawnedBeforeRefusal = fixtures.spawnProcess.mock.calls.length;
                  await expect(
                    handoff.startManagedServiceUpdateHandoff({
                      ...handoffParams,
                      root: secondRoot,
                      handoffId: randomUUID(),
                    }),
                  ).rejects.toMatchObject({ name: "GatewayDrainingError" });
                  expect(fixtures.spawnProcess).toHaveBeenCalledTimes(spawnedBeforeRefusal);
                  expect(store.read(root).kind).toBe("current");
                  expect(fsSync.existsSync(stage.packageRoot)).toBe(true);
                  expect(controlExists("script-settled")).toBe(false);
                  if (uncertain) {
                    await fs.writeFile(lockPath, "replacement ownership evidence\n");
                  }
                  released = true;
                  await fs.writeFile(releasePath, "finish writer");
                  if (closeFailure) {
                    await expect
                      .poll(() => fixtures.cancelManagedServiceUpdateHandoff.mock.calls, {
                        timeout: 15000,
                      })
                      .toEqual([[identity]]);
                    expect(controlExists("before-activate")).toBe(true);
                    await withinTest(helper.waitForClose(), context.signal);
                  } else {
                    await withTimeout(exited, handoffParams.timeoutMs!);
                    expect(controlExists("outcome.json")).toBe(true);
                  }
                  await expect.poll(() => store.read(root).kind, { timeout: 15000 }).toBe("absent");
                  const { isPidAlive } = await import("../../shared/pid-alive.js");
                  await withinTest(helper.waitForClose(), context.signal);
                  expect(prepared.pid !== undefined && isPidAlive(prepared.pid)).toBe(false);
                  expect(isPidAlive(lifecycleScriptPid)).toBe(false);
                  expect(controlExists("script-settled")).toBe(true);
                  expect(await readControl("script-calls")).toBe(
                    uncertain ? "preinstall\n" : "preinstall\npostinstall\n",
                  );
                  expect(fixtures.respawnGatewayProcessForUpdate).not.toHaveBeenCalled();
                  if (uncertain) {
                    const outcome = JSON.parse(await readControl("outcome.json"));
                    expect(outcome.failedStep?.stderrTail).toContain("ownership is uncertain");
                    expect(await fs.readFile(lockPath, "utf8")).toBe(
                      "replacement ownership evidence\n",
                    );
                    expect(fsSync.existsSync(pendingPath)).toBe(true);
                    expect(ledger.getUpdateRun(run.runId)?.status).toBe("failed");
                  }
                  await expect
                    .poll(() => runtime.exit.mock.calls, { timeout: 15000 })
                    .toEqual([[closeFailure ? 1 : 0]]);
                  if (phase === "completion") {
                    const outcome = JSON.parse(await readControl("outcome.json"));
                    expect(outcome).toMatchObject({ failedStep: null, afterVersion: "2.0.0" });
                  }
                  expect(close).toHaveBeenCalledOnce();
                  if (hosted) {
                    stop.expectHostedCompleted();
                  }
                };
                await withRunLoopCleanup(
                  runScenario,
                  async () => {
                    context.signal.removeEventListener("abort", abort);
                    released = true;
                    preparing?.release();
                    await settle(() => abortRelease);
                    await settle(() => fs.writeFile(releasePath, "fixture cleanup"));
                    await settle(() => join(starting?.catch(() => undefined)));
                    await settle(async () => {
                      if (lifecycleScriptPid === undefined) {
                        return;
                      }
                      const { isPidAlive } = await import("../../shared/pid-alive.js");
                      await expect
                        .poll(() => isPidAlive(lifecycleScriptPid!), { timeout: 15000 })
                        .toBe(false);
                    });
                    // Cancellation alone is not settlement: join the captured child and lease below.
                    await settle(() => handoff.cancelManagedServiceUpdateHandoff(identity));
                    await settle(() => helper.close());
                    await settle(() => {
                      const remaining = store.read(root);
                      if (remaining.kind !== "absent") {
                        throw new Error(
                          `Fixture handoff ${identity.handoffId} remains ${remaining.kind}; preserve ${home}`,
                        );
                      }
                    });
                    await settle(closeServer);
                    await settle(() => gatewayLock.current?.release());
                    await settle(async () => {
                      const { closeOpenClawStateDatabaseForTest } =
                        await import("../../state/openclaw-state-db.js");
                      closeOpenClawStateDatabaseForTest();
                    });
                    helper.restore();
                    preparing?.restore();
                    drain.mockRestore();
                    admission.resetGatewayWorkAdmission();
                    temporarySpy.mockRestore();
                    fixtures.gatewayLog.info.mockReset();
                    if (cleanupErrors.length) {
                      throw new AggregateError(
                        cleanupErrors,
                        `Fixture cleanup remains uncertain; preserved ${home}`,
                      );
                    }
                  },
                  `Fixture failed; preserved ${home}`,
                );
              });
            } finally {
              await closeServer();
              await gatewayLock.current?.release();
            }
          },
        );
        // Retain this body and its cleanup after Vitest cancels its timeout wrapper.
        context.onTestFinished(() => work.catch(() => {}));
        await work;
      } catch (error) {
        preserveArtifacts = true;
        throw error;
      } finally {
        if (!preserveArtifacts) {
          dirs.cleanup();
        }
      }
    },
  );
}
