import fs from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import { __setFsSafeTestHooksForTest } from "@openclaw/fs-safe/test-hooks";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WizardStartResult } from "../../../packages/gateway-protocol/src/schema/wizard.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { getCurrentPluginMetadataSnapshot } from "../../plugins/current-plugin-metadata-snapshot.js";
import {
  bindPluginMetadataSnapshotCache,
  createPluginCache,
  getPluginCache,
  type PluginCache,
} from "../../plugins/plugin-cache.js";
import { PluginInstance } from "../../plugins/plugin-instance.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import {
  getPluginRuntimeGenerationRegistry,
  withPluginRuntimeGenerationScope,
} from "../../plugins/runtime/generation-scope.js";
import {
  getActiveGatewayRootWorkCount,
  resetGatewayWorkAdmission,
  runWithGatewayIndependentRootWorkAdmission,
} from "../../process/gateway-work-admission.js";
import type { RuntimeEnv } from "../../runtime.js";
import type { WizardPrompter } from "../../wizard/prompts.js";
import type { WizardSession } from "../../wizard/session.js";
import { createWizardSessionTracker } from "../server-wizard-sessions.js";

const setupTargetLock = vi.hoisted(() => ({
  beforeRelease: undefined as Promise<void> | undefined,
  releaseReached: undefined as (() => void) | undefined,
}));

vi.mock("../../infra/file-lock.js", async () => {
  const actual = await vi.importActual<typeof import("../../infra/file-lock.js")>(
    "../../infra/file-lock.js",
  );
  return {
    ...actual,
    withFileLock: async <T>(
      filePath: string,
      options: Parameters<typeof actual.acquireFileLock>[1],
      run: () => Promise<T>,
    ): Promise<T> => {
      const lock = await actual.acquireFileLock(filePath, options);
      try {
        return await run();
      } finally {
        setupTargetLock.releaseReached?.();
        await setupTargetLock.beforeRelease;
        await lock.release();
      }
    },
  };
});

import {
  runExclusiveSystemAgentSetupActivation,
  whenAdmittedWizardSessionSettled,
} from "./setup-admission.js";
import { systemAgentHandlers } from "./system-agent.js";
import type { GatewayRequestContext, GatewayRequestHandlerOptions } from "./types.js";
import { type SetupWizardRunner, wizardHandlers } from "./wizard.js";

afterEach(() => __setFsSafeTestHooksForTest(undefined));

type WizardTestContext = Pick<
  GatewayRequestContext,
  "wizardSessions" | "wizardRunner" | "findRunningWizard" | "purgeWizardSession"
>;

function createWizardContext(wizardRunner: WizardTestContext["wizardRunner"]): WizardTestContext {
  return { ...createWizardSessionTracker(), wizardRunner };
}
function getSession(context: WizardTestContext, id: string | undefined) {
  return expectDefined(
    context.wizardSessions.get(expectDefined(id, "wizard session id")),
    "admitted wizard session",
  );
}

function readSuccessfulResponse(respond: ReturnType<typeof vi.fn>): Partial<WizardStartResult> {
  expect(respond).toHaveBeenCalledOnce();
  const [ok, result] = respond.mock.calls[0] ?? [];
  expect(ok).toBe(true);
  return expectDefined(result, "wizard result") as Partial<WizardStartResult>;
}

async function invokeWizard(
  method: string,
  params: Record<string, unknown>,
  context: WizardTestContext,
): Promise<Partial<WizardStartResult>> {
  return readSuccessfulResponse(await callWizard(method, params, context));
}

async function callWizard(
  method: string,
  params: Record<string, unknown>,
  context: WizardTestContext,
  respond = vi.fn(),
) {
  await expectDefined(wizardHandlers[method], method)({ params, respond, context } as never);
  return respond;
}

async function startWizard(context: WizardTestContext) {
  const result = await invokeWizard("wizard.start", { mode: "local" }, context);
  expect(result).toMatchObject({ status: "running" });
  return result;
}

function expectBusy(respond: ReturnType<typeof vi.fn>, extra = {}) {
  expect(respond).toHaveBeenCalledWith(
    false,
    undefined,
    expect.objectContaining({
      code: "UNAVAILABLE",
      details: { code: "SETUP_ADMISSION_BUSY" },
      ...extra,
    }),
  );
}

function expectStatus(respond: ReturnType<typeof vi.fn>, status: string) {
  expect(respond).toHaveBeenCalledWith(true, expect.objectContaining({ status }), undefined);
}

function suspendedWizard(runnerSettled: Promise<void>, terminal = "done") {
  return createWizardContext(async (_opts, _runtime, prompter) => {
    prompter.progress("working");
    await runnerSettled;
    if (terminal === "error") {
      throw new Error("Provider rejected sign-in");
    }
  });
}

async function cancelWizardSessions(sessions: Map<string, WizardSession>) {
  for (const session of sessions.values()) {
    session.cancel();
    await whenAdmittedWizardSessionSettled(session);
  }
}

it.each(["wizard.next", "wizard.cancel", "wizard.status"] as const)(
  "returns structured details from %s",
  async (method) => {
    const params = { sessionId: "expired" };
    const respond = vi.fn();
    const handler = expectDefined(wizardHandlers[method], method);

    await handler({
      req: { type: "req", id: "wizard-missing", method, params },
      params,
      client: null,
      isWebchatConnect: () => false,
      respond,
      context: { wizardSessions: new Map() } as never,
    } as GatewayRequestHandlerOptions);

    expect(respond).toHaveBeenCalledOnce();
    expect(respond).toHaveBeenCalledWith(false, undefined, {
      code: "INVALID_REQUEST",
      message: "wizard not found",
      details: { code: "WIZARD_NOT_FOUND" },
    });
  },
);

describe("hosted wizard runtime isolation", () => {
  it.each([
    { flow: "setup", cancel: false },
    { flow: "channels", cancel: false },
    { flow: "channels", cancel: true },
  ] as const)(
    "$flow isolates plugin resources until settlement (cancel=$cancel)",
    async ({ flow, cancel }) => {
      await using bootCache = createPluginCache({ kind: "process" });
      const metadataSnapshot = createPluginMetadataSnapshotFixture();
      bindPluginMetadataSnapshotCache(metadataSnapshot, bootCache);
      const pluginRegistry = createEmptyPluginRegistry();
      const bootInstance = new PluginInstance("gateway-boot");
      bootCache.instances.add(bootInstance);
      const readBoot = bootInstance.wrap(() => "gateway available");
      const wizardInstance = new PluginInstance("hosted-wizard");
      const events: string[] = [];
      wizardInstance.lifecycle.onDispose(() => {
        events.push("wizard disposed");
      });
      const readWizard = wizardInstance.wrap(() => "post-write complete");
      const finishPostWrite = createDeferred();
      const observed = createDeferred<{
        cache: PluginCache;
        metadata: ReturnType<typeof getCurrentPluginMetadataSnapshot>;
        registry: ReturnType<typeof getPluginRuntimeGenerationRegistry>;
      }>();
      const runner = async (_opts: unknown, _runtime: RuntimeEnv, prompter: WizardPrompter) => {
        const cache = getPluginCache();
        cache.instances.add(wizardInstance);
        observed.resolve({
          cache,
          metadata: getCurrentPluginMetadataSnapshot(),
          registry: getPluginRuntimeGenerationRegistry(),
        });
        prompter.progress("Finishing channel setup");
        await finishPostWrite.promise;
        events.push(readWizard());
      };
      const context = { ...createWizardContext(runner), channelWizardRunner: runner };

      try {
        const start = await withPluginRuntimeGenerationScope(
          { metadataSnapshot, pluginRegistry },
          async () => {
            const result = await invokeWizard(
              "wizard.start",
              flow === "channels" ? { flow } : { mode: "local" },
              context,
            );
            expect(getPluginCache()).toBe(bootCache);
            expect(getCurrentPluginMetadataSnapshot()).toBe(metadataSnapshot);
            expect(getPluginRuntimeGenerationRegistry()).toBe(pluginRegistry);
            return result;
          },
        );
        expect(start).toMatchObject({ status: "running", done: false });
        const session = getSession(context, start.sessionId);
        const scope = await observed.promise;
        expect(scope.cache).not.toBe(bootCache);
        expect(scope).toMatchObject({ metadata: undefined, registry: undefined });

        if (cancel) {
          expect(
            await invokeWizard("wizard.cancel", { sessionId: start.sessionId }, context),
          ).toMatchObject({ status: "cancelled" });
        }

        expect(events).toEqual([]);
        expect(readWizard()).toBe("post-write complete");
        finishPostWrite.resolve();
        await whenAdmittedWizardSessionSettled(session);
        expect(events).toEqual(["post-write complete", "wizard disposed"]);
        expect(() => readWizard()).toThrow("reloaded or disabled");
        expect(readBoot()).toBe("gateway available");
      } finally {
        finishPostWrite.resolve();
        await cancelWizardSessions(context.wizardSessions);
        await wizardInstance.dispose();
      }
    },
  );

  it.each([
    { flow: "setup", exitCode: 0, status: "done" },
    { flow: "channels", exitCode: 23, status: "error" },
  ] as const)(
    "contains a $flow wizard exit $exitCode without exiting the Gateway",
    async ({ flow, exitCode, status }) => {
      const processExit = vi.spyOn(process, "exit").mockImplementation((code) => {
        throw new Error(`Gateway process exit ${code}`);
      });
      const runner = async (_opts: unknown, runtime: RuntimeEnv, prompter: WizardPrompter) => {
        await prompter.outro("wizard complete");
        runtime.exit(exitCode);
      };
      const context = { ...createWizardContext(runner), channelWizardRunner: runner };

      try {
        const start = await invokeWizard(
          "wizard.start",
          flow === "channels" ? { flow } : { mode: "local" },
          context,
        );
        expect(start).toMatchObject({ done: false, status: "running" });

        const result = await invokeWizard(
          "wizard.next",
          {
            sessionId: start.sessionId,
            answer: { stepId: expectDefined(start.step, "wizard step").id, value: null },
          },
          context,
        );
        expect(result).toMatchObject({ done: true, status });
        if (exitCode !== 0) {
          expect(result.error).toContain(String(exitCode));
        }
        expect(processExit).not.toHaveBeenCalled();
      } finally {
        processExit.mockRestore();
      }
    },
  );
});

describe("wizard setup ownership", () => {
  it("rejects classic setup while structured setup owns admission, then permits it", async () => {
    const structuredStarted = createDeferred();
    const releaseStructured = createDeferred();
    const structured = runExclusiveSystemAgentSetupActivation(async () => {
      structuredStarted.resolve();
      await releaseStructured.promise;
    });
    await structuredStarted.promise;
    const wizardRunner = vi.fn(async (_opts, _runtime, prompter: WizardPrompter) => {
      await prompter.note("ready");
    });
    const context = createWizardContext(wizardRunner);

    const blockedRespond = await callWizard("wizard.start", { mode: "local" }, context);
    try {
      expectBusy(blockedRespond);
      expect(wizardRunner).not.toHaveBeenCalled();
    } finally {
      releaseStructured.resolve();
      await structured;
    }

    await startWizard(context);
    const session = getSession(context, context.wizardSessions.keys().next().value);
    session.cancel();
    await whenAdmittedWizardSessionSettled(session);
  });

  it("makes structured setup retry while a classic runner owns admission, then releases", async () => {
    const runnerSettled = createDeferred();
    const context = suspendedWizard(runnerSettled.promise);
    await startWizard(context);

    const activateRespond = vi.fn();
    await expectDefined(
      systemAgentHandlers["openclaw.setup.activate"],
      "openclaw.setup.activate test invariant",
    )({ params: { kind: "claude-cli" }, respond: activateRespond } as never);
    try {
      expectBusy(activateRespond, { retryable: true });
    } finally {
      runnerSettled.resolve();
      await whenAdmittedWizardSessionSettled(
        getSession(context, context.wizardSessions.keys().next().value),
      );
    }
    const structuredTask = vi.fn(async () => "ok");
    await expect(runExclusiveSystemAgentSetupActivation(structuredTask)).resolves.toBe("ok");
    expect(structuredTask).toHaveBeenCalledOnce();
  });

  it("retains gateway work admission between requests until the wizard settles", async () => {
    resetGatewayWorkAdmission();
    const runnerSettled = createDeferred();
    const context = suspendedWizard(runnerSettled.promise);

    try {
      await runWithGatewayIndependentRootWorkAdmission(() => startWizard(context));

      expect(getActiveGatewayRootWorkCount()).toBe(1);
      runnerSettled.resolve();
      await vi.waitFor(() => {
        expect(getActiveGatewayRootWorkCount()).toBe(0);
      });
    } finally {
      runnerSettled.resolve();
      resetGatewayWorkAdmission();
    }
  });

  it("cleans up detached wizard owners when setup lock release fails", async () => {
    resetGatewayWorkAdmission();
    const runnerSettled = createDeferred();
    const context = suspendedWizard(runnerSettled.promise);
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandledRejections.push(reason);
    };
    process.on("unhandledRejection", onUnhandledRejection);
    let lockPath: string | undefined;

    try {
      let sessionId = "";
      await runWithGatewayIndependentRootWorkAdmission(async () => {
        const start = await invokeWizard("wizard.start", { mode: "local" }, context);
        sessionId = start.sessionId ?? "";
      });
      expect(sessionId).not.toBe("");
      expect(getActiveGatewayRootWorkCount()).toBe(1);

      expect(await invokeWizard("wizard.cancel", { sessionId }, context)).toMatchObject({
        status: "cancelled",
      });

      const releaseError = new Error("setup lock release failed");
      __setFsSafeTestHooksForTest({
        beforeSidecarLockSnapshotOpen: (candidate) => {
          lockPath = candidate;
          throw releaseError;
        },
      });
      runnerSettled.resolve();
      const session = getSession(context, sessionId);
      await expect(whenAdmittedWizardSessionSettled(session)).rejects.toBe(releaseError);
      await setImmediate();

      expect.soft(unhandledRejections).toEqual([]);
      expect.soft(getActiveGatewayRootWorkCount()).toBe(0);
      expect.soft(context.wizardSessions.has(sessionId)).toBe(false);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
      __setFsSafeTestHooksForTest(undefined);
      runnerSettled.resolve();
      resetGatewayWorkAdmission();
      if (lockPath) {
        await fs.rm(lockPath, { force: true });
      }
    }
  });

  it("blocks a replacement wizard until the cancelled runner settles", async () => {
    const runnerSettled = createDeferred();
    const context = suspendedWizard(runnerSettled.promise);
    const start = await startWizard(context);

    const cancelRespond = await callWizard(
      "wizard.cancel",
      { sessionId: start.sessionId },
      context,
    );
    expectStatus(cancelRespond, "cancelled");

    const blockedRespond = await callWizard("wizard.start", { mode: "local" }, context);
    try {
      expectBusy(blockedRespond);
    } finally {
      runnerSettled.resolve();
      await vi.waitFor(() => {
        expect(context.wizardSessions.has(String(start.sessionId))).toBe(false);
      });
    }

    await startWizard(context);

    await cancelWizardSessions(context.wizardSessions);
  });

  it.each([
    ["wizard.status", "done"],
    ["wizard.status", "error"],
    ["wizard.next", "done"],
    ["wizard.next", "error"],
  ] as const)("settles setup admission before %s returns %s", async (method, terminal) => {
    const runnerSettled = createDeferred();
    const releaseSetupTargetLock = createDeferred();
    const setupTargetLockReleaseReached = createDeferred();
    setupTargetLock.beforeRelease = releaseSetupTargetLock.promise;
    setupTargetLock.releaseReached = setupTargetLockReleaseReached.resolve;
    const context = suspendedWizard(runnerSettled.promise, terminal);
    let admittedSession: WizardSession | undefined;

    try {
      const start = await startWizard(context);
      admittedSession = getSession(context, start.sessionId);

      runnerSettled.resolve();
      await setupTargetLockReleaseReached.promise;
      expect(admittedSession.getStatus()).toBe(terminal);
      await expect(runExclusiveSystemAgentSetupActivation(async () => undefined)).rejects.toThrow(
        "setup is already in progress",
      );

      const replacementRespond = vi.fn();
      let replacementStart: Promise<void> | undefined;
      const statusRespond = vi.fn(() => {
        replacementStart = callWizard(
          "wizard.start",
          { mode: "local" },
          context,
          replacementRespond,
        ).then(() => {});
      });
      const statusTask = callWizard(method, { sessionId: start.sessionId }, context, statusRespond);

      await Promise.resolve();
      expect(statusRespond).not.toHaveBeenCalled();
      releaseSetupTargetLock.resolve();
      await statusTask;
      await vi.waitFor(() => expect(replacementStart).toBeDefined());
      await replacementStart;

      expectStatus(statusRespond, terminal);
      expectStatus(replacementRespond, "running");
    } finally {
      runnerSettled.resolve();
      releaseSetupTargetLock.resolve();
      if (admittedSession) {
        await whenAdmittedWizardSessionSettled(admittedSession);
      }
      await cancelWizardSessions(context.wizardSessions);
      setupTargetLock.beforeRelease = undefined;
      setupTargetLock.releaseReached = undefined;
    }
  });

  it.each([
    { label: "false", params: { installDaemon: false }, expected: false },
    { label: "true", params: { installDaemon: true }, expected: true },
    { label: "omitted", params: {}, expected: undefined },
  ])("projects installDaemon when $label", async ({ params, expected }) => {
    let receivedInstallDaemon: boolean | undefined;
    const tracker = createWizardSessionTracker();
    const wizardRunner: SetupWizardRunner = async (opts, _runtime, prompter) => {
      receivedInstallDaemon = opts.installDaemon;
      await prompter.note("ready");
    };
    const respond = vi.fn();

    await expectDefined(
      wizardHandlers["wizard.start"],
      "wizard.start test invariant",
    )({
      params: { mode: "local", ...params },
      respond,
      context: { ...tracker, wizardRunner },
    } as never);

    expect(receivedInstallDaemon).toBe(expected);
    expect(respond.mock.calls[0]?.[1]).toMatchObject({ done: false, status: "running" });

    await cancelWizardSessions(tracker.wizardSessions);
  });
});

it.each([false, true])("redacts sensitive defaults after plain step=%s", async (afterPlain) => {
  const context = createWizardContext(async (_opts, _runtime, prompter) => {
    if (afterPlain) {
      await prompter.text({ message: "Display name", initialValue: "OpenClaw" });
    }
    await prompter.text({
      message: "Bot token",
      sensitive: true,
      initialValue: "123456:REAL-SECRET",
    });
  });
  let result = await invokeWizard("wizard.start", {}, context);
  if (afterPlain) {
    expect(result.step).toMatchObject({ initialValue: "OpenClaw" });
    expect(typeof result.sessionId).toBe("string");
    result = await invokeWizard(
      "wizard.next",
      {
        sessionId: result.sessionId,
        answer: { stepId: expectDefined(result.step, "wizard step").id, value: "Renamed" },
      },
      context,
    );
  }
  expect(result.step).toMatchObject({ sensitive: true });
  expect(result.step).not.toHaveProperty("initialValue");
  await cancelWizardSessions(context.wizardSessions);
});
