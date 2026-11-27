import { expectDefined } from "@openclaw/normalization-core";
import { Compile } from "typebox/compile";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WizardNextResultSchema } from "../../../packages/gateway-protocol/src/index.js";
import { createDeferred, withTestTimeout } from "../../../test/helpers/promise.js";
import type { ModelsAuthLoginFlowOptions } from "../../commands/models/auth.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ProviderAuthChoiceMetadata } from "../../plugins/provider-auth-choices.js";
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
  catalog: vi.fn(),
}));
vi.mock("./models-list-result.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./models-list-result.js")>()),
  buildModelsListResult: hooks.catalog,
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

  it.each([
    { primary: undefined, selects: true },
    { primary: "other/chosen", selects: false },
  ])(
    "a credential-only sign-in selects the account's recommended model only without a primary ($primary)",
    async ({ primary, selects }) => {
      const h = harness(primary ? { agents: { defaults: { model: { primary } } } } : {});
      hooks.catalog.mockResolvedValue({
        models: [
          { provider: "local", id: "model", name: "Local", available: true, recommended: true },
          { provider: "fixture", id: "first", name: "First", available: true },
          { provider: "fixture", id: "best", name: "Best", available: true, recommended: true },
        ],
      });
      hooks.activate.mockResolvedValue({
        ok: true,
        modelRef: "fixture/best",
        modelName: "Best",
        latencyMs: 1,
        lines: [],
      });
      await h.invoke("models.authLogin", {
        sessionId: "login",
        authChoice: "fixture/fixture-device",
        selectModel: true,
      });
      const terminal = await h.next();
      expect(terminal).toMatchObject({ done: true, status: "done" });
      if (selects) {
        expect(hooks.activate).toHaveBeenCalledWith(
          expect.objectContaining({
            kind: "saved-auth:fixture%3Aowner",
            modelRef: "fixture/best",
            selectModel: true,
          }),
        );
        expect(terminal.modelActivation).toEqual({ modelRef: "fixture/best", modelName: "Best" });
      } else {
        expect(hooks.catalog).not.toHaveBeenCalled();
        expect(hooks.activate).not.toHaveBeenCalled();
        expect(terminal.modelActivation).toBeUndefined();
      }
    },
  );

  it("a credential-only sign-in selects the model its provider recommends for an agent without one", async () => {
    const h = harness();
    hooks.login.mockResolvedValueOnce({ ...result, defaultModel: "fixture/plan" });
    hooks.catalog.mockResolvedValue({
      models: [
        { provider: "fixture", id: "first", name: "First", available: true },
        { provider: "fixture", id: "best", name: "Best", available: true, recommended: true },
        { provider: "fixture", id: "plan", name: "Plan", available: true },
      ],
    });
    hooks.activate.mockResolvedValue({
      ok: true,
      modelRef: "fixture/plan",
      latencyMs: 1,
      lines: [],
    });
    await h.invoke("models.authLogin", {
      sessionId: "login",
      authChoice: "fixture/fixture-device",
      selectModel: true,
    });
    expect(await h.next()).toMatchObject({ done: true, status: "done" });
    expect(hooks.activate).toHaveBeenCalledWith(
      expect.objectContaining({ modelRef: "fixture/plan", selectModel: true }),
    );
  });

  it("reports a saved sign-in whose model check failed with the activation's one sentence", async () => {
    const h = harness();
    hooks.catalog.mockResolvedValue({
      models: [{ provider: "fixture", id: "best", name: "Best", available: true }],
    });
    const error =
      "Your sign-in is saved. The model check failed because the provider is busy or limiting requests. Wait a few minutes, then try again.";
    hooks.activate.mockResolvedValue({
      ok: false,
      status: "rate_limit",
      error,
      disposition: "rejected-before-promotion",
    });
    await h.invoke("models.authLogin", {
      sessionId: "login",
      authChoice: "fixture/fixture-device",
      selectModel: true,
    });
    expect(await h.next()).toEqual({
      done: true,
      status: "error",
      error,
      activationRejection: { disposition: "rejected-before-promotion", status: "rate_limit" },
    });
  });

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
      error: expect.stringMatching(/sign-in was saved.*reopen Models/),
    });
    expect(hooks.login).toHaveBeenCalledTimes(1);
  });

  it("reports model access the Gateway has not confirmed through wizard.next", async () => {
    hooks.login.mockResolvedValueOnce({
      ...result,
      modelAccess: { message: "Added fixture/* to allowed models.", applied: false },
    });
    const h = harness();
    await h.start();
    expect(await h.next()).toMatchObject({
      done: true,
      status: "error",
      error: expect.stringContaining("Open Settings and select Apply changes"),
    });
  });

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
    "binds browser callback eligibility to the connected origin and stops on cancel (%s)",
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
      // Leaving the tab keeps the sign-in; only its cancellation stops the provider flow.
      h.controller.abort();
      expect(session.getStatus()).toBe("running");
      expectReply(await h.cancel(), { status: "cancelled" });
      await whenAdmittedWizardSessionSettled(session);
      expect(options.signal?.aborted).toBe(true);
      expect(options.beforePersistentEffect).toThrow();
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

  it("keeps a sign-in across a socket loss; another owner replaces it only while nobody reads it", async () => {
    const h = harness();
    void mockLogin(async (options) => {
      await options.prompter.text({ message: "Address of the page your browser opened" });
    });
    const session = await h.begin();
    const step = await h.next();
    h.controller.abort();
    expect(session.getStatus()).toBe("running");
    // The user comes back on a new socket and reads the same step.
    const returning = new AbortController();
    const returned: GatewayClient = {
      ...h.client,
      connId: "returned",
      connectionSignal: returning.signal,
    };
    const resumed = await h.invoke("wizard.next", { sessionId: "login" }, returned);
    expectReply(resumed, { step: expect.objectContaining({ id: step.step?.id }) });
    // Someone is watching the sign-in again, so another operator stays busy.
    const other: GatewayClient = { ...h.client, connId: "other" };
    const start = () =>
      h.invoke(
        "models.authLogin",
        { sessionId: "replacement", authChoice: "fixture/fixture-device" },
        other,
      );
    expectRejected(await start(), { details: { code: "SETUP_ADMISSION_BUSY" } });
    // A second tab reads it and drops; the returned tab still shows it.
    const secondTab = new AbortController();
    await h.invoke(
      "wizard.next",
      { sessionId: "login" },
      {
        ...h.client,
        connId: "second-tab",
        connectionSignal: secondTab.signal,
      },
    );
    secondTab.abort();
    expectRejected(await start(), { details: { code: "SETUP_ADMISSION_BUSY" } });
    expect(session.getStatus()).toBe("running");
    // Once every reader's socket is closed, nobody watches it: a new sign-in is not refused.
    returning.abort();
    void mockLogin(() => undefined);
    expectReply(await start(), { sessionId: "replacement", status: "running" });
    await whenAdmittedWizardSessionSettled(session);
    expect(session.getStatus()).toBe("cancelled");
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

  it("rejects the pre-write callback after the login method changes", async () => {
    const h = harness();
    const release = gate();
    let wrote = false;
    void mockLogin(async (options) => {
      await release.promise;
      await options.beforePersistentEffect?.();
      wrote = true;
    }, false);
    const session = await h.begin();
    hooks.choice.mockReturnValue({ ...choice, methodId: "other-method" });
    release.resolve();
    await whenAdmittedWizardSessionSettled(session);
    expect(session.getStatus()).toBe("error");
    expect(session.getError()).toMatch(/no longer/);
    expect(wrote).toBe(false);
  });
});
