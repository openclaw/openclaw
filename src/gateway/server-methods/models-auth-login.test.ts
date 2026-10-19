import syncFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { setImmediate as nextEventLoopTurn } from "node:timers/promises";
import { expectDefined } from "@openclaw/normalization-core";
import { Compile } from "typebox/compile";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WizardNextResultSchema } from "../../../packages/gateway-protocol/src/index.js";
import { createDeferred, withTestTimeout } from "../../../test/helpers/promise.js";
import { prepareProviderModelAccess } from "../../commands/models/auth-model-policy.js";
import type { ModelsAuthLoginFlowOptions } from "../../commands/models/auth.js";
import { registerRuntimeConfigWriteListener } from "../../config/runtime-snapshot.js";
import {
  getRuntimeConfigWriteApplication,
  type RuntimeConfigWriteApplicationClaim,
} from "../../config/runtime-write-application.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ProviderAuthChoiceMetadata } from "../../plugins/provider-auth-choices.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { createWizardSessionTracker } from "../server-wizard-sessions.js";
import { prepareTailscalePublishedOrigin } from "../tailscale-published-origin.js";
import type { GatewayClient } from "./client-types.js";
import { modelsAuthLoginHandlers } from "./models-auth-login.js";
import { whenAdmittedWizardSessionSettled } from "./setup-admission.js";
import type * as SetupExecution from "./system-agent-execution.js";
import type { GatewayRequestContext, RespondFn } from "./types.js";
import { wizardHandlers } from "./wizard.js";

const hooks = vi.hoisted(() => ({
  login: vi.fn(),
  choice: vi.fn(),
  activate: vi.fn<typeof SetupExecution.activateGatewaySetupInference>(),
  admission: vi.fn(),
  writeConfig: vi.fn<typeof import("../../commands/models/shared.js").updateConfig>(),
}));
vi.mock("../../commands/models/shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../commands/models/shared.js")>()),
  updateConfig: hooks.writeConfig,
}));
vi.mock("../../commands/models/auth.js", () => ({ runModelsAuthLoginFlowForGateway: hooks.login }));
vi.mock("../../plugins/provider-auth-choices.js", () => ({
  resolveManifestDeclaredProviderAuthChoices: () => {
    const choice = hooks.choice();
    return choice ? [choice] : [];
  },
}));
vi.mock("./system-agent-execution.js", async (importOriginal) => ({
  ...(await importOriginal<typeof SetupExecution>()),
  activateGatewaySetupInference: hooks.activate,
}));
vi.mock("../../wizard/setup.migration-snapshot.js", () => ({
  SetupTargetLockedError: class extends Error {},
  withSetupMigrationTargetLock: hooks.admission,
}));

const choice: ProviderAuthChoiceMetadata = {
  pluginId: "fixture",
  providerId: "fixture",
  methodId: "device-code",
  choiceId: "fixture-device",
  choiceLabel: "Fixture",
  appGuidedAuth: "device-code",
  credentialOnly: true,
};
const result = {
  providerId: "fixture",
  methodId: "device-code",
  authRefresh: "refreshed",
  profiles: [{ profileId: "fixture:owner", provider: "fixture", mode: "oauth" }],
};
const sessions = new Set<ReturnType<typeof createWizardSessionTracker>>();
const modelConfig: OpenClawConfig = {
  agents: {
    defaults: { model: "other/current", modelPolicy: { allow: ["other/current"] } },
    entries: { main: {} },
  },
};
function requestModelAccess(options: ModelsAuthLoginFlowOptions) {
  const prepared = expectDefined(
    prepareProviderModelAccess({
      config: modelConfig,
      agentId: "main",
      provider: "fixture",
      providerLabel: "Fixture",
    }),
    "model access request",
  );
  expectDefined(options.onModelAccessRequested, "deferred model access callback")(prepared);
}

const validateWizardResult = Compile(WizardNextResultSchema);
const publishedOrigin = { origin: "https://gateway.example", mode: "serve" } as const;
const cleanups: Array<() => void> = [];

function gate() {
  const deferred = createDeferred();
  cleanups.push(() => deferred.resolve());
  return deferred;
}

function mockLogin(
  run: (options: ModelsAuthLoginFlowOptions) => void | Promise<void>,
  once = true,
) {
  const started = createDeferred<ModelsAuthLoginFlowOptions>();
  const login = async (options: ModelsAuthLoginFlowOptions) => {
    started.resolve(options);
    await run(options);
    return result;
  };
  hooks.login[once ? "mockImplementationOnce" : "mockImplementation"](login);
  return started.promise;
}

function browserHarness(browserOrigin: GatewayClient["browserOrigin"]) {
  const withdraw = prepareTailscalePublishedOrigin(publishedOrigin);
  const h = harness();
  h.client.browserOrigin = browserOrigin;
  cleanups.push(withdraw, () => h.controller.abort());
  return { h, withdraw };
}

function expectReply(respond: ReturnType<typeof vi.fn<RespondFn>>, payload: unknown) {
  expect(respond).toHaveBeenCalledWith(true, expect.objectContaining(payload), undefined);
}

function expectRejected(respond: ReturnType<typeof vi.fn<RespondFn>>, error: unknown) {
  expect(respond).toHaveBeenCalledWith(false, undefined, expect.objectContaining(error));
}

function postSaveNote() {
  void mockLogin(async (options) => {
    await expectDefined(options.beforePersistentEffect, "credential commit callback")();
    await options.prompter.note("Credentials saved.");
  });
}

async function policyWizard(state: OpenClawTestState, onWrite: () => void = () => {}) {
  const config = structuredClone(modelConfig);
  await state.writeConfig(config);
  const shared = await vi.importActual<typeof import("../../commands/models/shared.js")>(
    "../../commands/models/shared.js",
  );
  hooks.writeConfig.mockImplementation(async (...args) => {
    const saved = await shared.updateConfig(...args);
    onWrite();
    return saved;
  });
  void mockLogin(requestModelAccess);
  const h = harness(config);
  await h.start();
  return { h, prompt: await h.next() };
}

function holdAdmission(beforeRun = false) {
  const entered = gate(),
    release = gate();
  hooks.admission.mockImplementationOnce(async (_stateDir: string, run: () => Promise<unknown>) => {
    if (beforeRun) {
      entered.resolve();
      await release.promise;
      return run();
    }
    const runResult = await run();
    await release.promise;
    return runResult;
  });
  return { entered, release };
}

function harness(config: OpenClawConfig = {}) {
  const tracker = createWizardSessionTracker();
  sessions.add(tracker);
  const controller = new AbortController();
  const client: GatewayClient = {
    connId: "owner",
    connectionSignal: controller.signal,
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      scopes: ["operator.admin"],
      client: { id: "cli", version: "test", platform: "test", mode: "cli" },
    },
  };
  const context = { ...tracker, getRuntimeConfig: () => config } as GatewayRequestContext;
  const invoke = async (method: string, params: Record<string, unknown>, caller = client) => {
    const respond = vi.fn<RespondFn>();
    const handler = expectDefined(
      modelsAuthLoginHandlers[method] ?? wizardHandlers[method],
      method,
    );
    await handler({
      req: { type: "req", id: "request", method, params },
      params,
      respond,
      context,
      client: caller,
      isWebchatConnect: () => false,
    });
    return respond;
  };
  const start = () =>
    invoke("models.authLogin", { sessionId: "login", authChoice: "fixture/fixture-device" });
  let stepId: string | undefined;
  const next = async (value?: string) => {
    const respond = await invoke("wizard.next", {
      sessionId: "login",
      ...(value === undefined
        ? {}
        : { answer: { stepId: expectDefined(stepId, "wizard step"), value } }),
    });
    const response = expectDefined(respond.mock.calls[0], "wizard response");
    expect(respond.mock.calls).toEqual([[true, expect.anything(), undefined]]);
    if (!validateWizardResult.Check(response[1])) {
      throw new Error("Expected a valid wizard response");
    }
    stepId = response[1].step?.id;
    return response[1];
  };
  const session = () => expectDefined(tracker.wizardSessions.get("login"), "login session");
  const begin = async () => {
    await start();
    return session();
  };
  const cancel = (closeInput?: boolean, caller = client) =>
    invoke("wizard.cancel", { sessionId: "login", ...(closeInput ? { closeInput } : {}) }, caller);
  return { tracker, controller, client, invoke, start, begin, next, session, cancel };
}

describe("models.authLogin ownership", () => {
  beforeEach(() => {
    hooks.choice.mockReturnValue(choice);
    hooks.login.mockResolvedValue(result);
    hooks.writeConfig.mockRejectedValue(new Error("Unexpected model policy write"));
    hooks.admission.mockImplementation(async (_stateDir: string, run: () => Promise<unknown>) =>
      run(),
    );
  });
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).toReversed()) {
      cleanup();
    }
    vi.restoreAllMocks();
    for (const tracker of sessions) {
      for (const session of tracker.wizardSessions.values()) {
        session.cancel();
        await whenAdmittedWizardSessionSettled(session);
      }
    }
    sessions.clear();
    vi.useRealTimers();
    vi.resetAllMocks();
  });

  it.each([
    { ...choice, credentialOnly: false, appGuidedAuth: undefined },
    { ...choice, pluginId: "replacement" },
  ])("rejects an unavailable choice before login", async (unavailable) => {
    const h = harness();
    hooks.choice.mockReturnValue(unavailable);
    const respond = await h.start();
    expectRejected(respond, { code: "INVALID_REQUEST" });
    expect(h.tracker.wizardSessions.size).toBe(0);
    expect(hooks.login).not.toHaveBeenCalled();
  });

  it("rejects a wrong local owner before starting a credential wizard", async () => {
    const h = harness();
    const respond = await h.invoke("models.authLogin", {
      sessionId: "login",
      authChoice: "fixture/fixture-device",
      expectedOwnerId: "not-the-current-owner",
    });
    expectRejected(respond, {
      details: { reason: "STATE_OWNER_CHANGED", mutationAccepted: false },
    });
    expect(hooks.login).not.toHaveBeenCalled();
    expect(hooks.writeConfig).not.toHaveBeenCalled();
    expect(h.tracker.wizardSessions.size).toBe(0);
  });

  it.each([true, false])(
    "dispatches login without waiting for a provider prompt (credentialOnly: %s)",
    async (credentialOnly) => {
      const h = harness();
      const finish = gate();
      hooks.choice.mockReturnValue({ ...choice, credentialOnly });
      void mockLogin(() => finish.promise, false);
      hooks.activate.mockImplementation(async () => {
        await finish.promise;
        return { ok: true, modelRef: "fixture/model", latencyMs: 1, lines: [] };
      });
      const respond = await h.start();
      expect(respond).toHaveBeenCalledWith(
        true,
        { sessionId: "login", done: false, status: "running" },
        undefined,
      );
      expect(h.tracker.wizardSessions.get("login")?.getStatus()).toBe("running");
      expect(hooks.login).toHaveBeenCalledTimes(credentialOnly ? 1 : 0);
      expect(hooks.activate).toHaveBeenCalledTimes(credentialOnly ? 0 : 1);
      if (!credentialOnly) {
        expect(hooks.activate).toHaveBeenCalledWith(
          expect.objectContaining({
            kind: "provider-auth",
            authChoice: "fixture-device",
            selectModel: false,
          }),
        );
      }
    },
  );

  it("returns the recovery message without the error class name through wizard.next", async () => {
    hooks.login.mockRejectedValueOnce(
      Object.assign(new Error("Connection settings changed. Open Model Setup to try again."), {
        name: "SetupInferenceOwnerDriftError",
      }),
    );
    const h = harness();
    await h.start();
    expect(await h.next()).toEqual({
      done: true,
      status: "error",
      error: "Connection settings changed. Open Model Setup to try again.",
    });
  });

  it("reports saved credentials with unconfirmed refresh through wizard.next", async () => {
    hooks.login.mockResolvedValueOnce({ ...result, authRefresh: "gateway-rejected" });
    const h = harness();
    await h.start();
    expect(await h.next()).toMatchObject({
      done: true,
      status: "error",
      error: expect.stringMatching(/sign-in was saved.*\/login refresh/),
    });
    expect(hooks.login).toHaveBeenCalledTimes(1);
    expect(hooks.writeConfig).not.toHaveBeenCalled();
  });

  it.each(["applied", "restart-pending", "unclaimed"] as const)(
    "preserves saved model access through the registered wizard when application is %s",
    async (status) => {
      await withOpenClawTestState({ label: "wizard-policy-application" }, async (state) => {
        const written = gate();
        const { h, prompt } = await policyWizard(state, written.resolve);
        expect(prompt.step?.type).toBe("select");
        const claimed = createDeferred<RuntimeConfigWriteApplicationClaim>();
        let claim: RuntimeConfigWriteApplicationClaim | undefined;
        const stop = registerRuntimeConfigWriteListener((event) => {
          if (status !== "unclaimed") {
            const receipt = getRuntimeConfigWriteApplication(event)?.claim();
            if (receipt) {
              claim = receipt;
              claimed.resolve(receipt);
            }
          }
        });
        const response = h.next("all");
        try {
          if (status !== "unclaimed") {
            const receipt = await Promise.race([
              claimed.promise,
              response.then(() => {
                throw new Error("Wizard completed without claiming application");
              }),
            ]);
            await written.promise;
            expect(
              await Promise.race([response.then(() => "completed"), nextEventLoopTurn("pending")]),
            ).toBe("pending");
            receipt.settle(status);
          }
          const terminal = await response;
          expect(terminal).toMatchObject({
            done: true,
            status: status === "applied" ? "done" : "error",
          });
          if (status !== "applied") {
            expect(terminal.error).toContain("sign-in and model access were saved");
            expect(terminal.error).toContain("not confirmed");
            expect(terminal.error).toContain("Open Settings and select Apply changes");
          }
          const saved: OpenClawConfig = JSON.parse(await fs.readFile(state.configPath, "utf8"));
          expect(saved.agents?.defaults).toMatchObject({
            model: "other/current",
            modelPolicy: { allow: ["other/current", "fixture/*"] },
          });
          expect(hooks.login).toHaveBeenCalledOnce();
        } finally {
          claim?.settle("failed");
          stop();
          await response;
        }
      });
    },
  );

  it.each(["preparation", "staging"])(
    "does not publish model access after a disconnect during %s",
    async (boundary) => {
      await withOpenClawTestState({ label: "wizard-policy-disconnect" }, async (state) => {
        const { h } = await policyWizard(state);
        const before = await fs.readFile(state.configPath, "utf8");
        const session = h.session();
        const lockCancellation = session.lockCancellation.bind(session);
        const lockSpy = vi.spyOn(session, "lockCancellation").mockImplementation(() => {
          lockCancellation();
          if (boundary === "preparation") {
            queueMicrotask(() => h.controller.abort());
          }
        });
        const openSync = syncFs.openSync;
        let stagedFd: number | undefined;
        const openSpy = vi.spyOn(syncFs, "openSync").mockImplementation((file, flags, mode) => {
          const fd = openSync(file, flags, mode);
          if (
            typeof file === "string" &&
            path.dirname(file) === path.dirname(state.configPath) &&
            path.basename(file).startsWith(".fs-safe-") &&
            file.endsWith(".tmp")
          ) {
            stagedFd = fd;
          }
          return fd;
        });
        const writeFileSync = syncFs.writeFileSync;
        const writeSpy = vi
          .spyOn(syncFs, "writeFileSync")
          .mockImplementation((file, data, options) => {
            writeFileSync(file, data, options);
            if (boundary === "staging" && file === stagedFd) {
              h.controller.abort();
            }
          });
        try {
          const terminal = await h.next("all");
          await whenAdmittedWizardSessionSettled(session);
          expect(h.controller.signal.aborted).toBe(true);
          expect(terminal.status).toBe("error");
          expect(await fs.readFile(state.configPath, "utf8")).toBe(before);
        } finally {
          writeSpy.mockRestore();
          openSpy.mockRestore();
          lockSpy.mockRestore();
        }
      });
    },
  );

  it.each([
    ["keep", "refreshed"],
    ["all", "gateway-rejected"],
  ])("keeps post-save %s input owner-bound with %s refresh", async (modelAccess, authRefresh) => {
    const h = harness();
    let saved = modelConfig;
    hooks.writeConfig.mockImplementationOnce(async (mutator, _refs, beforeCommit, options) => {
      const next = await mutator(structuredClone(modelConfig), {
        runtimeConfig: modelConfig,
        restoreSourceEntry: (_from, _to, entry) => entry,
      });
      beforeCommit?.();
      expectReply(await h.cancel(), { status: "running" });
      saved = next;
      expectDefined(
        getRuntimeConfigWriteApplication(expectDefined(options, "write options"))?.claim(),
        "application receipt",
      ).settle("applied");
      return saved;
    });
    hooks.login.mockImplementation(async (options: ModelsAuthLoginFlowOptions) => {
      await expectDefined(options.beforePersistentEffect, "credential commit callback")();
      requestModelAccess(options);
      return { ...result, authRefresh };
    });
    const session = await h.begin();
    const prompt = await h.next();
    const answer = { stepId: expectDefined(prompt.step, "model access").id, value: modelAccess };
    expect(await h.next()).toMatchObject({
      step: {
        type: "select",
        initialValue: "keep",
        options: [
          { value: "all", label: "Show all Fixture models" },
          { value: "keep", label: "Keep current restrictions" },
        ],
      },
    });
    const peer = { ...h.client, connId: "peer" };
    for (const method of ["wizard.status", "wizard.next", "wizard.cancel"]) {
      const respond = await h.invoke(
        method,
        { sessionId: "login", ...(method === "wizard.next" ? { answer } : {}) },
        peer,
      );
      expectRejected(respond, { details: { code: "WIZARD_NOT_FOUND" } });
    }
    expectRejected(await h.cancel(true, peer), { details: { code: "WIZARD_NOT_FOUND" } });
    expect(hooks.writeConfig).not.toHaveBeenCalled();
    expect(session.getStatus()).toBe("running");
    expect(await h.next(modelAccess)).toMatchObject({
      done: true,
      status: authRefresh === "refreshed" ? "done" : "error",
      ...(authRefresh === "refreshed"
        ? {}
        : { error: expect.stringMatching(/sign-in was saved.*\/login refresh/) }),
    });
    expect(hooks.writeConfig).toHaveBeenCalledTimes(modelAccess === "all" ? 1 : 0);
    expect(saved.agents?.defaults?.modelPolicy?.allow).toEqual(
      modelAccess === "all" ? ["other/current", "fixture/*"] : ["other/current"],
    );
  });

  it.each(["cancel", "expire"])(
    "releases post-save consent on %s after protecting the write",
    async (action) => {
      vi.useFakeTimers();
      const enteredWrite = gate();
      const finishWrite = gate();
      const h = harness();
      void mockLogin(async (options) => {
        await expectDefined(options.beforePersistentEffect, "credential commit callback")();
        enteredWrite.resolve();
        await finishWrite.promise;
        requestModelAccess(options);
      });
      const session = await h.begin();
      await enteredWrite.promise;
      expectReply(await h.cancel(), { status: "running" });
      expect(session.signal.aborted).toBe(false);
      finishWrite.resolve();
      expect(await h.next()).toMatchObject({ step: { type: "select" } });
      if (action === "expire") {
        await vi.advanceTimersByTimeAsync(25 * 60_000);
      } else {
        expectReply(await h.cancel(), { status: "cancelled" });
      }
      expect(session.getStatus()).toBe("cancelled");
      expect(session.signal.aborted).toBe(true);
      await whenAdmittedWizardSessionSettled(session);
      expect(hooks.writeConfig).not.toHaveBeenCalled();
      expectReply(await harness().start(), { sessionId: "login", status: "running" });
    },
  );

  it("keeps a cancelled login readable until repeated cancellation releases admission", async () => {
    const { release } = holdAdmission();
    void mockLogin((options) => options.prompter.note("Waiting for acknowledgement"), false);
    const h = harness();
    const session = await h.begin();
    await h.cancel();
    await session.whenSettled();
    await h.cancel();
    const status = h.invoke("wizard.status", { sessionId: "login" });
    release.resolve();
    expect(await status).toHaveBeenCalledWith(
      true,
      { status: "cancelled", error: "cancelled" },
      undefined,
    );
  });

  it.each(["https://gateway.example", "http://localhost:18789", undefined])(
    "binds browser callback eligibility and cancellation to the connected origin (%s)",
    async (origin) => {
      const { h } = browserHarness(
        origin ? { origin, requestHost: new URL(origin).host, isLocalClient: true } : undefined,
      );
      const started = mockLogin(async (options) => {
        await options.openUrl?.("https://provider.example/authorize");
        await options.prompter.text({ message: "Paste the redirect URL" });
      });
      const session = await h.begin();
      const options = await started;
      expect(typeof options.browserAuthorization).toBe(origin ? "function" : "undefined");
      expect((await h.next()).step).toMatchObject({
        type: "text",
        message: "Paste the redirect URL",
        externalUrl: "https://provider.example/authorize",
      });
      h.controller.abort();
      await whenAdmittedWizardSessionSettled(session);
      expect(options.signal?.aborted).toBe(true);
      expect(options.beforePersistentEffect).toThrow();
      expect(session.getStatus()).toBe("error");
    },
  );

  it("models.authLogin preserves device-flow cancellation when its managed origin is withdrawn", async () => {
    const { h, withdraw } = browserHarness({ origin: publishedOrigin.origin });
    void mockLogin(async (options) => {
      await options.prompter.text({ message: "Waiting for device approval" });
      options.assertCurrent?.();
    });
    const session = await h.begin();
    await h.next();
    withdraw();
    const options: ModelsAuthLoginFlowOptions = hooks.login.mock.calls[0]![0];
    expect(options.signal?.aborted).toBe(true);
    expect(options.assertCurrent).toThrow();
    session.cancel();
  });

  it.each(["keep", "revoked"])("closes browser sign-in before post-save %s", async (action) => {
    const { h, withdraw } = browserHarness({ origin: publishedOrigin.origin });
    const received = mockLogin(async (options) => {
      await options.beforePersistentEffect?.();
      expect(options.signal?.aborted).toBe(false);
      expect(options.assertCurrent).not.toThrow();
      requestModelAccess(options);
    });
    const session = await h.begin();
    const options = await received;
    const prompt = await h.next();
    expect(prompt.step?.type).toBe("select");
    expect(options.signal?.aborted).toBe(true);
    expect(options.assertCurrent).toThrow("closed");
    withdraw();
    expect(session.signal.aborted).toBe(false);
    if (action === "revoked") {
      h.client.connect.scopes = [];
    }
    await h.invoke("wizard.next", {
      sessionId: "login",
      answer: { stepId: expectDefined(prompt.step, "model access").id, value: "keep" },
    });
    await whenAdmittedWizardSessionSettled(session);
    expect(session.getStatus()).toBe(action === "keep" ? "done" : "error");
    if (action === "revoked") {
      expect(session.getError()).toContain(
        "Credentials saved, but provider settings could not be applied",
      );
    }
    expect(hooks.writeConfig).not.toHaveBeenCalled();
  });

  it("releases admission on disconnect with a post-save note", async () => {
    const h = harness();
    postSaveNote();
    const session = await h.begin();
    expect(await h.next()).toMatchObject({ step: { message: "Credentials saved." } });
    h.controller.abort();
    await withTestTimeout(
      whenAdmittedWizardSessionSettled(session),
      1_000,
      "Disconnected login retained admission",
    );
    expect(session.getStatus()).toBe("error");
    expectReply(await harness().start(), { sessionId: "login" });
  });

  it("settles discarded login input before admitting another login on the same connection", async () => {
    const h = harness();
    const { release } = holdAdmission();
    postSaveNote();
    const session = await h.begin();
    await h.invoke("wizard.next", { sessionId: "login" });
    let responded = false;
    const closing = h.cancel(true);
    void closing.then(() => {
      responded = true;
    });
    await withTestTimeout(session.whenSettled(), 1_000, "Disposed login kept waiting for input");
    expect(responded).toBe(false);
    release.resolve();
    expectReply(await closing, { status: "error" });
    expect(h.controller.signal.aborted).toBe(false);
    expectReply(await h.start(), { sessionId: "login", status: "running" });
  });

  it("does not register or start login when the owner disconnects during admission", async () => {
    const h = harness();
    const { entered, release } = holdAdmission(true);
    const started = h.start();
    await entered.promise;
    h.controller.abort();
    release.resolve();
    await expect(started).rejects.toThrow();
    expect(h.tracker.wizardSessions.size).toBe(0);
    expect(hooks.login).not.toHaveBeenCalled();
  });

  it.each(["owner", "method"])(
    "rejects the pre-write callback after %s authority changes",
    async (changed) => {
      const h = harness();
      const release = gate();
      let wrote = false;
      void mockLogin(async (options) => {
        await release.promise;
        await options.beforePersistentEffect?.();
        wrote = true;
      }, false);
      const session = await h.begin();
      if (changed === "owner") {
        h.client.invalidated = true;
      } else {
        hooks.choice.mockReturnValue({ ...choice, methodId: "other-method" });
      }
      release.resolve();
      await whenAdmittedWizardSessionSettled(session);
      expect(session.getStatus()).toBe("error");
      expect(session.getError()).toMatch(/no longer/);
      expect(wrote).toBe(false);
    },
  );
});
