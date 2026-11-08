import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { withRuntimePublicationExclusion } from "../infra/runtime-publication-exclusion.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type * as Service from "./service-types.js";
import { resolveGatewayService } from "./service.js";
import { seedCompletedRuntimePinMigration } from "./test-helpers/service-audit-runtime-pin.js";

const native = vi.hoisted(() => ({
  command: null as Service.GatewayServiceCommandConfig | null,
  install: vi.fn(),
  stage: vi.fn(),
  uninstall: vi.fn(),
  loaded: vi.fn(),
  runtime: vi.fn(),
  stop: vi.fn(),
  start: vi.fn(),
}));

/** Signals the exact moment a waiter attempts a runtime-publication lock. */
const exclusionAdmission = vi.hoisted(() => ({
  notify: null as ((lockPath: string) => void) | null,
}));

vi.mock("./launchd.js", async (original) => ({
  ...(await original<typeof import("./launchd.js")>()),
  installLaunchAgent: native.install,
  stageLaunchAgent: native.stage,
  uninstallLaunchAgent: native.uninstall,
  readLaunchAgentProgramArguments: vi.fn(async () => native.command),
  isLaunchAgentEnabled: vi.fn(),
  isLaunchAgentLoaded: native.loaded,
  readLaunchAgentRuntime: native.runtime,
  restartLaunchAgent: vi.fn(),
  startLaunchAgent: native.start,
  stopLaunchAgent: native.stop,
}));
vi.mock("./future-config-guard.js", async (original) => ({
  ...(await original<typeof import("./future-config-guard.js")>()),
  assertFutureConfigActionAllowed: vi.fn(async () => {}),
}));
vi.mock("../infra/gateway-supervision.js", async (original) => ({
  ...(await original<typeof import("../infra/gateway-supervision.js")>()),
  assertGatewayServiceMutationAllowed: vi.fn(),
}));
// Pass-through wrapper: real lock semantics, plus an observable admission
// boundary so tests synchronize on the lock attempt instead of sleeping.
vi.mock("../infra/file-lock.js", async (original) => {
  const mod = await original<typeof import("../infra/file-lock.js")>();
  return {
    ...mod,
    withFileLock: <T>(
      filePath: string,
      options: Parameters<typeof mod.withFileLock>[1],
      fn: () => Promise<T>,
    ): Promise<T> => {
      if (filePath.includes("runtime-publication-")) {
        exclusionAdmission.notify?.(filePath);
      }
      return mod.withFileLock(filePath, options, fn);
    },
  };
});

beforeEach(() => {
  native.command = null;
  native.loaded.mockReset().mockResolvedValue(true);
  native.runtime.mockReset().mockResolvedValue({ status: "stopped" });
  native.install.mockReset();
  native.stage.mockReset();
  native.start.mockReset();
  native.stop.mockReset().mockResolvedValue(undefined);
  exclusionAdmission.notify = null;
});
afterEach(() => vi.restoreAllMocks());

/** A checkout whose runtime artifacts a publication may still be writing. */
async function writePublishingCheckout(stateRoot: string, name = "checkout"): Promise<string> {
  const checkout = path.join(stateRoot, name);
  await fs.mkdir(path.join(checkout, "dist"), { recursive: true });
  await fs.mkdir(path.join(checkout, "dist-runtime"), { recursive: true });
  await fs.writeFile(path.join(checkout, "package.json"), JSON.stringify({ name: "openclaw" }));
  await fs.writeFile(path.join(checkout, "dist", "entry.js"), "export {};\n");
  return checkout;
}

/** Publication holding the checkout's exclusion until the returned control releases it. */
async function startHeldPublication(
  checkout: string,
  events: string[],
): Promise<{ settled: Promise<void>; release: () => void }> {
  const writing = createDeferredCore();
  const finished = createDeferredCore();
  const publication = withRuntimePublicationExclusion(checkout, async () => {
    events.push("publication-started");
    writing.resolve();
    await finished.promise;
    events.push("publication-finished");
  });
  publication.catch(() => undefined);
  await writing.promise;
  return { settled: publication.then(() => undefined), release: () => finished.resolve() };
}

/** Resolves when a service mutation reaches its publication-exclusion lock attempt. */
function armExclusionAdmission(): Promise<void> {
  const admitted = createDeferredCore();
  exclusionAdmission.notify = () => admitted.resolve();
  return admitted.promise;
}

async function withDarwinService<T>(run: () => Promise<T>): Promise<T> {
  const platform = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
  try {
    return await run();
  } finally {
    platform.mockRestore();
  }
}

/** Retarget the service at `servedEntry`'s checkout and prove the writer interval excludes it. */
async function expectRetargetQueuedBehindPublication(params: {
  state: { env: NodeJS.ProcessEnv; root: string };
  publishingRoot: string;
  servedEntry: string;
  events: string[];
}): Promise<void> {
  const service = resolveGatewayService();
  const retargeted = createDeferredCore();
  native.install.mockImplementation(async (args: Service.GatewayServiceInstallArgs) => {
    native.command = {
      programArguments: args.programArguments,
      workingDirectory: args.workingDirectory,
    };
    params.events.push("service-retargeted");
    retargeted.resolve();
  });
  const held = await startHeldPublication(params.publishingRoot, params.events);
  const admitted = armExclusionAdmission();
  const install = service.install({
    env: params.state.env,
    stdout: process.stdout,
    programArguments: [process.execPath, params.servedEntry, "gateway"],
  });
  install.catch(() => undefined);
  // Synchronize on the waiter's lock-attempt boundary: a guard that never
  // consults the exclusion leaves this pending until the Vitest timeout, and a
  // guard that consults it but fails to block is caught by the order below.
  await admitted;
  expect(params.events).toEqual(["publication-started"]);
  held.release();
  await expect(held.settled).resolves.toBeUndefined();
  await expect(install).resolves.toBeUndefined();
  expect(params.events).toEqual([
    "publication-started",
    "publication-finished",
    "service-retargeted",
  ]);
}

it("queues a service retarget behind the served checkout's runtime publication", () =>
  withOpenClawTestState({ label: "publication-exclusion-install" }, async (state) => {
    // Complete the real migration under real storage custody before platform stubs.
    await seedCompletedRuntimePinMigration(state.env);
    await withDarwinService(async () => {
      const checkout = await writePublishingCheckout(state.root);
      const events: string[] = [];
      await expectRetargetQueuedBehindPublication({
        state,
        publishingRoot: checkout,
        servedEntry: path.join(checkout, "dist", "entry.js"),
        events,
      });
    });
  }));

it("queues a service start behind the served checkout's runtime publication", () =>
  withOpenClawTestState({ label: "publication-exclusion-start" }, async (state) => {
    await seedCompletedRuntimePinMigration(state.env);
    await withDarwinService(async () => {
      const checkout = await writePublishingCheckout(state.root);
      const service = resolveGatewayService();
      const events: string[] = [];
      const started = createDeferredCore();
      native.start.mockImplementation(async () => {
        events.push("service-started");
        started.resolve();
      });
      native.command = {
        programArguments: [process.execPath, path.join(checkout, "dist", "entry.js"), "gateway"],
      };
      const held = await startHeldPublication(checkout, events);
      const admitted = armExclusionAdmission();
      const start = service.start({ env: state.env, stdout: process.stdout });
      start.catch(() => undefined);
      await admitted;
      expect(events).toEqual(["publication-started"]);
      held.release();
      await expect(held.settled).resolves.toBeUndefined();
      await expect(start).resolves.toBeUndefined();
      expect(events).toEqual(["publication-started", "publication-finished", "service-started"]);
    });
  }));

it("queues a service retarget while the served entrypoint is cleaned for rebuild", () =>
  withOpenClawTestState({ label: "publication-exclusion-cleaned" }, async (state) => {
    await seedCompletedRuntimePinMigration(state.env);
    await withDarwinService(async () => {
      const checkout = await writePublishingCheckout(state.root);
      // A real rebuild removes its dist entrypoint before recompiling; the served
      // root must still resolve from the path string through that window.
      await fs.rm(path.join(checkout, "dist", "entry.js"));
      const events: string[] = [];
      await expectRetargetQueuedBehindPublication({
        state,
        publishingRoot: checkout,
        servedEntry: path.join(checkout, "dist", "entry.js"),
        events,
      });
    });
  }));

it("queues a service retarget whose shared outputs point into the publishing checkout", () =>
  withOpenClawTestState({ label: "publication-exclusion-shared" }, async (state) => {
    await seedCompletedRuntimePinMigration(state.env);
    await withDarwinService(async () => {
      const publishingRoot = await writePublishingCheckout(state.root, "checkout-a");
      const servedRoot = await writePublishingCheckout(state.root, "checkout-b");
      // Supported shared-output topology: the served checkout's runtime output
      // directory physically is the publishing checkout's.
      await fs.rm(path.join(servedRoot, "dist-runtime"), { recursive: true, force: true });
      await fs.symlink(
        path.join(publishingRoot, "dist-runtime"),
        path.join(servedRoot, "dist-runtime"),
        "dir",
      );
      const events: string[] = [];
      await expectRetargetQueuedBehindPublication({
        state,
        publishingRoot,
        servedEntry: path.join(servedRoot, "dist", "entry.js"),
        events,
      });
    });
  }));

it("queues a service retarget whose shared SDK alias points into the publishing checkout", () =>
  withOpenClawTestState({ label: "publication-exclusion-alias" }, async (state) => {
    await seedCompletedRuntimePinMigration(state.env);
    await withDarwinService(async () => {
      const publishingRoot = await writePublishingCheckout(state.root, "checkout-a");
      const servedRoot = await writePublishingCheckout(state.root, "checkout-b");
      // Supported shared-SDK topology: the served checkout's bundled SDK alias
      // physically resolves into the publishing checkout.
      const aliasParent = path.join(servedRoot, "dist", "extensions", "node_modules");
      await fs.mkdir(aliasParent, { recursive: true });
      await fs.symlink(publishingRoot, path.join(aliasParent, "openclaw"), "dir");
      const events: string[] = [];
      await expectRetargetQueuedBehindPublication({
        state,
        publishingRoot,
        servedEntry: path.join(servedRoot, "dist", "entry.js"),
        events,
      });
    });
  }));

it("queues a service retarget whose shared alias target is cleaned mid-publication", () =>
  withOpenClawTestState({ label: "publication-exclusion-dangling" }, async (state) => {
    await seedCompletedRuntimePinMigration(state.env);
    await withDarwinService(async () => {
      const publishingRoot = await writePublishingCheckout(state.root, "checkout-a");
      const servedRoot = await writePublishingCheckout(state.root, "checkout-b");
      const nested = path.join(publishingRoot, "dist", "extensions", "demo");
      await fs.mkdir(nested, { recursive: true });
      const aliasParent = path.join(servedRoot, "dist", "extensions", "node_modules");
      await fs.mkdir(aliasParent, { recursive: true });
      await fs.symlink(nested, path.join(aliasParent, "openclaw"), "dir");
      const service = resolveGatewayService();
      const events: string[] = [];
      native.install.mockImplementation(async (args: Service.GatewayServiceInstallArgs) => {
        native.command = {
          programArguments: args.programArguments,
          workingDirectory: args.workingDirectory,
        };
        events.push("service-retargeted");
      });
      const held = await startHeldPublication(publishingRoot, events);
      // The writer's own clean step removes the shared target while it holds
      // its locks; the dangling alias must still resolve into the publisher.
      await fs.rm(nested, { recursive: true, force: true });
      const admitted = armExclusionAdmission();
      const install = service.install({
        env: state.env,
        stdout: process.stdout,
        programArguments: [process.execPath, path.join(servedRoot, "dist", "entry.js"), "gateway"],
      });
      install.catch(() => undefined);
      await admitted;
      expect(events).toEqual(["publication-started"]);
      held.release();
      await expect(held.settled).resolves.toBeUndefined();
      await expect(install).resolves.toBeUndefined();
      expect(events).toEqual(["publication-started", "publication-finished", "service-retargeted"]);
    });
  }));

it("queues a service retarget whose alias targets an output nested in the publishing checkout", () =>
  withOpenClawTestState({ label: "publication-exclusion-nested" }, async (state) => {
    await seedCompletedRuntimePinMigration(state.env);
    await withDarwinService(async () => {
      const publishingRoot = await writePublishingCheckout(state.root, "checkout-a");
      const servedRoot = await writePublishingCheckout(state.root, "checkout-b");
      // Nested shared-output topology: the alias resolves to a path *inside* one
      // of the publishing checkout's output roots, matching no exact key of it.
      const nested = path.join(publishingRoot, "dist-runtime", "extensions", "demo");
      await fs.mkdir(nested, { recursive: true });
      const aliasParent = path.join(servedRoot, "dist", "extensions", "node_modules");
      await fs.mkdir(aliasParent, { recursive: true });
      await fs.symlink(nested, path.join(aliasParent, "openclaw"), "dir");
      const events: string[] = [];
      await expectRetargetQueuedBehindPublication({
        state,
        publishingRoot,
        servedEntry: path.join(servedRoot, "dist", "entry.js"),
        events,
      });
    });
  }));
