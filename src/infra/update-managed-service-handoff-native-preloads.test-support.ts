import type { ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect } from "vitest";
import type { FixtureReceiptChannel } from "../../test/helpers/fixture-receipts.js";
import { withinTest } from "../../test/helpers/promise.js";
import type { ManagedServiceBoundaryOptions } from "./update-managed-service-handoff-boundary-contract.test-support.js";
import { waitForHandoffResponse } from "./update-managed-service-handoff-command.test-support.js";
import {
  createManagedHandoffLeaseStore,
  type ManagedHandoffLeaseStoreOptions,
} from "./update-managed-service-handoff-lease.js";
import {
  createManagedServiceCancellationPreload,
  createManagedServiceLaunchdClockPreload,
} from "./update-managed-service-handoff-lifecycle.test-support.js";
import { MANAGED_HANDOFF_RUNTIME_ENTRY } from "./update-managed-service-handoff-runtime-assets.js";
import { pathExists } from "./update-managed-service-native.test-support.js";

export async function prepareManagedServiceNativePreloads(params: {
  root: string;
  scriptPath: string;
  parentPid: number;
  receiptClientPath: string;
  childEnv: NodeJS.ProcessEnv;
  env: NodeJS.ProcessEnv;
  options?: ManagedServiceBoundaryOptions;
  commandTimingsPath: string;
  recoveryCommandArgv: string[];
  validationStartedPath: string;
  updaterPidPath: string;
  activationGatePath: string;
  activationReleasePath: string;
  mutationPath: string;
}): Promise<NodeJS.ProcessEnv> {
  const {
    root,
    scriptPath,
    parentPid,
    receiptClientPath,
    childEnv,
    options,
    commandTimingsPath,
    recoveryCommandArgv,
    validationStartedPath,
    updaterPidPath,
    activationGatePath,
    activationReleasePath,
    mutationPath,
  } = params;
  let helperEnv = params.env;
  if (options?.replaceLaunchdLeaseAfterInspection) {
    const preloadPath = path.join(root, "lease-generation-preload.cjs");
    await fs.writeFile(
      preloadPath,
      `if (process.argv[1] === ${JSON.stringify(scriptPath)}) {
          const children = require("node:child_process");
          const spawn = children.spawn;
          let inspected = false;
          children.spawn = (command, args, options) => {
            const child = spawn(command, args, options);
            if (inspected || command !== "launchctl" ||
                JSON.stringify(args) !== '["print","gui/501/ai.openclaw.gateway"]') return child;
            inspected = true;
            let stdout = "";
            child.stdout.on("data", chunk => { stdout += chunk; });
            const emit = child.emit.bind(child);
            child.emit = (event, ...values) => {
              if (event !== "close") return emit(event, ...values);
              // Hold only the real inspection's close; the captured helper lease stays untouched.
              void (async () => {
                const assert = require("node:assert/strict");
                const runtime = require(${JSON.stringify(path.join(path.dirname(scriptPath), "runtime", MANAGED_HANDOFF_RUNTIME_ENTRY))});
                assert.equal(values[0], 0);
                assert.equal(values[1], null);
                assert.equal(runtime.parseLaunchctlJob(stdout, args[1]).runtime.pid, ${parentPid});
                const { sendReceipt, awaitRelease } = await import(${JSON.stringify(pathToFileURL(receiptClientPath).href)});
                sendReceipt(${JSON.stringify(root)}, "inspection-complete");
                await awaitRelease(${JSON.stringify(root)}, "replace-lease");
                const params = JSON.parse(require("node:fs").readFileSync(process.argv[2], "utf8"));
                const store = runtime.createManagedHandoffLeaseStore({
                  databasePath: params.updateLeaseDatabasePath,
                  existingIdentity: params.updateLeaseDatabaseIdentity,
                  serviceManagerEnv: process.env,
                });
                const current = store.read(params.updateLeaseKey);
                assert.equal(current.kind, "current");
                const replacement = store.bind(current.lease, process.pid);
                assert.ok(replacement);
                assert.ok(replacement.updatedAt > current.lease.updatedAt);
                assert.equal(store.current(current.lease), false);
                assert.equal(store.owns(replacement), true);
                sendReceipt(${JSON.stringify(root)}, "lease-generation-replaced");
                await awaitRelease(${JSON.stringify(root)}, "resume-inspection");
                emit(event, ...values);
              })().catch(error => { console.error(error); process.exit(18); });
              return true;
            };
            return child;
          };
        }`,
    );
    helperEnv = {
      ...helperEnv,
      NODE_OPTIONS: `${helperEnv.NODE_OPTIONS ?? ""} --require ${preloadPath}`.trim(),
    };
  }
  if (options?.launchdTeardown?.clockEachCommandMs || options?.recoveryClockAdvanceMs) {
    const preloadPath = path.join(root, "launchd-clock-preload.cjs");
    await fs.writeFile(
      preloadPath,
      createManagedServiceLaunchdClockPreload({
        commandTimingsPath,
        clockEachCommandMs: options.launchdTeardown?.clockEachCommandMs ?? 0,
        recoveryClockAdvanceMs: options.recoveryClockAdvanceMs,
        recoveryCommandArgv,
      }),
    );
    helperEnv = { ...childEnv, NODE_OPTIONS: `--require ${preloadPath}` };
  }
  if (options?.runnerFallback) {
    const preloadPath = path.join(root, "spawn-fallback-preload.cjs");
    await fs.writeFile(preloadPath, "process.execve = undefined;\n");
    helperEnv = { ...helperEnv, NODE_OPTIONS: `--require ${preloadPath}` };
  }
  if (options?.validationClockAdvanceMs) {
    const preloadPath = path.join(root, "validation-clock-preload.cjs");
    await fs.writeFile(
      preloadPath,
      `const fs = require("node:fs"); const now = Date.now;
          Date.now = () => now() + (fs.existsSync(${JSON.stringify(validationStartedPath)}) ? ${options.validationClockAdvanceMs} : 0);`,
    );
    helperEnv = {
      ...helperEnv,
      NODE_OPTIONS: `${helperEnv.NODE_OPTIONS ?? ""} --require ${preloadPath}`.trim(),
    };
  }
  if (options?.cancelAtActivation) {
    const preloadPath = path.join(root, "cancel-activation-preload.cjs");
    await fs.writeFile(
      preloadPath,
      createManagedServiceCancellationPreload({
        scriptPath,
        updaterPidPath,
        activationGatePath,
        activationReleasePath,
        mutationPath,
        gateInspection: options.cancelAtActivation === "inspection",
      }),
    );
    helperEnv = { ...helperEnv, NODE_OPTIONS: `--require ${preloadPath}` };
  }
  return helperEnv;
}

export async function rejectManagedServiceInspectionWithStaleLease(params: {
  databasePath: string;
  generated: Record<string, unknown>;
  env: NodeJS.ProcessEnv;
  root: string;
  runningHelper: ChildProcess;
  parent: ChildProcess;
  completion: Promise<number | null>;
  stderr: () => string;
  receipts: FixtureReceiptChannel;
  signal: AbortSignal;
  updaterPath: string;
}): Promise<void> {
  const {
    databasePath,
    generated,
    env,
    root,
    runningHelper,
    parent,
    completion,
    receipts,
    signal,
    updaterPath,
  } = params;
  const store = createManagedHandoffLeaseStore({
    databasePath,
    existingIdentity:
      generated.updateLeaseDatabaseIdentity as ManagedHandoffLeaseStoreOptions["existingIdentity"],
    serviceManagerEnv: env,
  });
  const original = store.read(root);
  expect(original.kind).toBe("current");
  if (original.kind !== "current") {
    throw new Error("missing helper lease");
  }
  const cancelled = waitForHandoffResponse(runningHelper.stdout, "cancelled");
  runningHelper.stdin?.write("park\n");
  await withinTest(receipts.waitFor(root, "inspection-complete"), signal);
  expect(store.current(original.lease)).toBe(true);
  receipts.release(root, "replace-lease");
  await withinTest(receipts.waitFor(root, "lease-generation-replaced"), signal);
  const replacement = store.read(root);
  expect(replacement.kind).toBe("current");
  if (replacement.kind !== "current") {
    throw new Error("missing replacement lease");
  }
  expect(replacement.lease.updatedAt).toBeGreaterThan(original.lease.updatedAt);
  expect(store.current(original.lease)).toBe(false);
  receipts.release(root, "resume-inspection");
  await cancelled;
  expect(await completion, params.stderr()).toBe(0);
  expect(parent).toMatchObject({ exitCode: null, signalCode: null });
  await expect(pathExists(updaterPath)).resolves.toBe(false);
  expect(store.current(replacement.lease)).toBe(true);
  // The stale helper cannot release its successor. Reclaim only after its actual close.
  expect(store.release(replacement.lease)).toBe(true);
}
