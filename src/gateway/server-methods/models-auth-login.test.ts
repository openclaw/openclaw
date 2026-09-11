import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred, withTestTimeout } from "../../../test/helpers/promise.js";
import { prepareProviderModelAccess } from "../../commands/models/auth-model-policy.js";
import type { ModelsAuthLoginFlowOptions } from "../../commands/models/auth.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ProviderAuthChoiceMetadata } from "../../plugins/provider-auth-choices.js";
import { createWizardSessionTracker } from "../server-wizard-sessions.js";
import { prepareTailscalePublishedOrigin } from "../tailscale-published-origin.js";
import type { GatewayClient } from "./client-types.js";
import { modelsAuthLoginHandlers } from "./models-auth-login.js";
import { whenAdmittedWizardSessionSettled } from "./setup-admission.js";
import type { GatewayRequestContext } from "./types.js";
import { wizardHandlers } from "./wizard.js";

const hooks = vi.hoisted(() => ({
  login: vi.fn(),
  choice: vi.fn(),
  admission: vi.fn(),
  writeConfig: vi.fn<typeof import("../../commands/models/shared.js").updateConfig>(),
}));
vi.mock("../../commands/models/shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../commands/models/shared.js")>()),
  updateConfig: hooks.writeConfig,
}));
vi.mock("../../commands/models/auth.js", () => ({ runModelsAuthLoginFlowCore: hooks.login }));
vi.mock("../../plugins/provider-auth-choices.js", () => ({
  resolveManifestDeclaredProviderAuthChoices: () => {
    const choice = hooks.choice();
    return choice ? [choice] : [];
  },
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

function harness() {
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
  const context = { ...tracker, getRuntimeConfig: () => ({}) } as GatewayRequestContext;
  const invoke = async (method: string, params: Record<string, unknown>, caller = client) => {
    const respond = vi.fn();
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
  return { tracker, controller, client, invoke, start };
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
    for (const tracker of sessions) {
      for (const session of tracker.wizardSessions.values()) {
        session.cancel();
        await whenAdmittedWizardSessionSettled(session);
      }
    }
    sessions.clear();
    vi.resetAllMocks();
  });

  it.each([
    undefined,
    { ...choice, credentialOnly: false },
    { ...choice, pluginId: "replacement" },
  ])("rejects an unavailable choice before login", async (unavailable) => {
    const h = harness();
    hooks.choice.mockReturnValue(unavailable);
    const respond = await h.start();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
    expect(h.tracker.wizardSessions.size).toBe(0);
    expect(hooks.login).not.toHaveBeenCalled();
  });

  it("acknowledges start before the provider produces any prompt", async () => {
    const h = harness();
    const finish = createDeferred();
    hooks.login.mockImplementation(async () => {
      await finish.promise;
      return result;
    });
    try {
      const respond = await h.start();
      expect(respond).toHaveBeenCalledWith(
        true,
        { sessionId: "login", done: false, status: "running" },
        undefined,
      );
      expect(h.tracker.wizardSessions.get("login")?.getStatus()).toBe("running");
    } finally {
      finish.resolve();
    }
  });

  it.each(["all", "keep"])("keeps post-save %s input owner-bound", async (modelAccess) => {
    const h = harness();
    let saved = modelConfig;
    hooks.writeConfig.mockImplementationOnce(async (mutator, _refs, beforeCommit) => {
      const next = await mutator(structuredClone(modelConfig), {
        runtimeConfig: modelConfig,
        restoreSourceEntry: (_from, _to, entry) => entry,
      });
      beforeCommit?.();
      expect(await h.invoke("wizard.cancel", { sessionId: "login" })).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ status: "running" }),
        undefined,
      );
      saved = next;
      return saved;
    });
    hooks.login.mockImplementation(async (options: ModelsAuthLoginFlowOptions) => {
      await expectDefined(options.beforePersistentEffect, "credential commit callback")();
      requestModelAccess(options);
      return result;
    });
    await h.start();
    const session = expectDefined(h.tracker.wizardSessions.get("login"), "login session");
    const prompt = await session.next();
    const answer = { stepId: expectDefined(prompt.step, "model access").id, value: modelAccess };
    expect(await h.invoke("wizard.next", { sessionId: "login" })).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        step: expect.objectContaining({
          type: "select",
          initialValue: "keep",
          options: [
            expect.objectContaining({ value: "all", label: "Show all Fixture models" }),
            expect.objectContaining({ value: "keep", label: "Keep current restrictions" }),
          ],
        }),
      }),
      undefined,
    );
    const peer = { ...h.client, connId: "peer" };
    for (const method of ["wizard.status", "wizard.next", "wizard.cancel"]) {
      const respond = await h.invoke(
        method,
        { sessionId: "login", ...(method === "wizard.next" ? { answer } : {}) },
        peer,
      );
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          details: { code: "WIZARD_NOT_FOUND" },
        }),
      );
    }
    expect(
      await h.invoke("wizard.cancel", { sessionId: "login", closeInput: true }, peer),
    ).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ details: { code: "WIZARD_NOT_FOUND" } }),
    );
    expect(hooks.writeConfig).not.toHaveBeenCalled();
    expect(session.getStatus()).toBe("running");
    const completed = await h.invoke("wizard.next", { sessionId: "login", answer });
    expect(completed).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ done: true, status: "done" }),
      undefined,
    );
    expect(hooks.writeConfig).toHaveBeenCalledTimes(modelAccess === "all" ? 1 : 0);
    expect(saved.agents?.defaults?.modelPolicy?.allow).toEqual(
      modelAccess === "all" ? ["other/current", "fixture/*"] : ["other/current"],
    );
  });

  it.each(["cancel", "expire"])(
    "releases post-save consent on %s after protecting the write",
    async (action) => {
      vi.useFakeTimers();
      const enteredWrite = createDeferred();
      const finishWrite = createDeferred();
      const h = harness();
      hooks.login.mockImplementationOnce(async (options: ModelsAuthLoginFlowOptions) => {
        await expectDefined(options.beforePersistentEffect, "credential commit callback")();
        enteredWrite.resolve();
        await finishWrite.promise;
        requestModelAccess(options);
        return result;
      });
      await h.start();
      const session = expectDefined(h.tracker.wizardSessions.get("login"), "login session");
      try {
        await enteredWrite.promise;
        expect(await h.invoke("wizard.cancel", { sessionId: "login" })).toHaveBeenCalledWith(
          true,
          expect.objectContaining({ status: "running" }),
          undefined,
        );
        expect(session.signal.aborted).toBe(false);
        finishWrite.resolve();
        expect(await h.invoke("wizard.next", { sessionId: "login" })).toHaveBeenCalledWith(
          true,
          expect.objectContaining({ step: expect.objectContaining({ type: "select" }) }),
          undefined,
        );
        if (action === "expire") {
          await vi.advanceTimersByTimeAsync(25 * 60_000);
        } else {
          expect(await h.invoke("wizard.cancel", { sessionId: "login" })).toHaveBeenCalledWith(
            true,
            expect.objectContaining({ status: "cancelled" }),
            undefined,
          );
        }
        expect(session.getStatus()).toBe("cancelled");
        expect(session.signal.aborted).toBe(true);
        await whenAdmittedWizardSessionSettled(session);
        expect(hooks.writeConfig).not.toHaveBeenCalled();
        expect(await harness().start()).toHaveBeenCalledWith(
          true,
          expect.objectContaining({ sessionId: "login", status: "running" }),
          undefined,
        );
      } finally {
        finishWrite.resolve();
        session.close(new Error("Test cleanup"));
        await whenAdmittedWizardSessionSettled(session);
        vi.useRealTimers();
      }
    },
  );

  it("keeps a cancelled login readable until repeated cancellation releases admission", async () => {
    const release = createDeferred();
    hooks.admission.mockImplementation(async (_stateDir: string, run: () => Promise<unknown>) => {
      await run();
      await release.promise;
    });
    hooks.login.mockImplementation(async (options: ModelsAuthLoginFlowOptions) => {
      await options.prompter.note("Waiting for acknowledgement");
      return result;
    });
    const h = harness();
    try {
      await h.start();
      const session = expectDefined(h.tracker.wizardSessions.get("login"), "login session");
      await h.invoke("wizard.cancel", { sessionId: "login" });
      await session.whenSettled();
      await h.invoke("wizard.cancel", { sessionId: "login" });
      const status = h.invoke("wizard.status", { sessionId: "login" });
      release.resolve();
      expect(await status).toHaveBeenCalledWith(
        true,
        { status: "cancelled", error: "cancelled" },
        undefined,
      );
    } finally {
      release.resolve();
    }
  });

  it("delivers the provider browser URL on the next wizard step", async () => {
    const h = harness();
    hooks.login.mockImplementationOnce(async (options: ModelsAuthLoginFlowOptions) => {
      await expectDefined(
        options.openUrl,
        "provider browser URL delivery",
      )("https://auth.example.test/approve");
      await options.prompter.note("Continue in your browser.");
      return result;
    });
    await h.start();
    const response = await h.invoke("wizard.next", { sessionId: "login" });
    expect(response).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        step: expect.objectContaining({ externalUrl: "https://auth.example.test/approve" }),
      }),
      undefined,
    );
  });

  it.each(["https://gateway.example", "http://localhost:18789", undefined])(
    "binds browser callback eligibility and cancellation to the connected origin (%s)",
    async (origin) => {
      const withdraw = prepareTailscalePublishedOrigin({
        origin: "https://gateway.example",
        mode: "serve",
      });
      const h = harness();
      h.client.browserOrigin = origin ? { origin } : undefined;
      const started = createDeferred<ModelsAuthLoginFlowOptions>();
      hooks.login.mockImplementationOnce(async (options: ModelsAuthLoginFlowOptions) => {
        started.resolve(options);
        await options.openUrl?.("https://provider.example/authorize");
        await options.prompter.text({ message: "Paste the redirect URL" });
        return result;
      });
      try {
        await h.start();
        const options = await started.promise;
        expect(typeof options.browserAuthorization).toBe(
          origin === "https://gateway.example" ? "function" : "undefined",
        );
        const session = expectDefined(h.tracker.wizardSessions.get("login"), "login session");
        expect((await session.next()).step).toMatchObject({
          type: "text",
          message: "Paste the redirect URL",
          externalUrl: "https://provider.example/authorize",
        });
        h.controller.abort();
        await whenAdmittedWizardSessionSettled(session);
        expect(options.signal?.aborted).toBe(true);
        expect(options.beforePersistentEffect).toThrow();
        expect(session.getStatus()).toBe("error");
      } finally {
        h.controller.abort();
        withdraw();
      }
    },
  );

  it.each(["keep", "cancel", "revoked"])(
    "closes browser sign-in before post-save %s",
    async (action) => {
      const withdraw = prepareTailscalePublishedOrigin({
        origin: "https://gateway.example",
        mode: "serve",
      });
      const h = harness();
      h.client.browserOrigin = { origin: "https://gateway.example" };
      const received = createDeferred<ModelsAuthLoginFlowOptions>();
      hooks.login.mockImplementationOnce(async (options: ModelsAuthLoginFlowOptions) => {
        received.resolve(options);
        await options.beforePersistentEffect?.();
        expect(options.signal?.aborted).toBe(false);
        expect(options.assertCurrent).not.toThrow();
        requestModelAccess(options);
        return result;
      });
      try {
        await h.start();
        const options = await received.promise;
        const session = expectDefined(h.tracker.wizardSessions.get("login"), "login session");
        const prompt = await session.next();
        expect(prompt.step?.type).toBe("select");
        expect(options.signal?.aborted).toBe(true);
        expect(options.assertCurrent).toThrow("closed");
        withdraw();
        expect(session.signal.aborted).toBe(false);
        if (action === "cancel") {
          await h.invoke("wizard.cancel", { sessionId: "login" });
        } else {
          if (action === "revoked") {
            h.client.connect.scopes = [];
          }
          await h.invoke("wizard.next", {
            sessionId: "login",
            answer: { stepId: expectDefined(prompt.step, "model access").id, value: "keep" },
          });
        }
        await whenAdmittedWizardSessionSettled(session);
        expect(session.getStatus()).toBe(
          action === "keep" ? "done" : action === "cancel" ? "cancelled" : "error",
        );
        if (action === "revoked") {
          expect(session.getError()).toContain(
            "Credentials saved, but provider settings could not be applied",
          );
        }
        expect(hooks.writeConfig).not.toHaveBeenCalled();
      } finally {
        withdraw();
      }
    },
  );

  it("releases admission on disconnect with a post-save note", async () => {
    const h = harness();
    hooks.login.mockImplementationOnce(async (options: ModelsAuthLoginFlowOptions) => {
      await expectDefined(options.beforePersistentEffect, "credential commit callback")();
      await options.prompter.note("Credentials saved.");
      return result;
    });
    await h.start();
    const session = expectDefined(h.tracker.wizardSessions.get("login"), "login session");
    try {
      const note = await h.invoke("wizard.next", { sessionId: "login" });
      expect(note).toHaveBeenCalledWith(
        true,
        expect.objectContaining({
          step: expect.objectContaining({ message: "Credentials saved." }),
        }),
        undefined,
      );
      h.controller.abort();
      await withTestTimeout(
        whenAdmittedWizardSessionSettled(session),
        1_000,
        "Disconnected login retained admission",
      );
      expect(session.getStatus()).toBe("error");
      const replacement = await harness().start();
      expect(replacement).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ sessionId: "login" }),
        undefined,
      );
    } finally {
      session.close(new Error("Test cleanup"));
      await whenAdmittedWizardSessionSettled(session);
    }
  });

  it("settles discarded login input before admitting another login on the same connection", async () => {
    const h = harness();
    const release = createDeferred();
    hooks.admission.mockImplementationOnce(
      async (_stateDir: string, run: () => Promise<unknown>) => {
        await run();
        await release.promise;
      },
    );
    hooks.login.mockImplementationOnce(async (options: ModelsAuthLoginFlowOptions) => {
      await expectDefined(options.beforePersistentEffect, "credential commit callback")();
      await options.prompter.note("Credentials saved.");
      return result;
    });
    await h.start();
    const session = expectDefined(h.tracker.wizardSessions.get("login"), "login session");
    try {
      await h.invoke("wizard.next", { sessionId: "login" });
      let responded = false;
      const closing = h.invoke("wizard.cancel", { sessionId: "login", closeInput: true });
      void closing.then(() => {
        responded = true;
      });
      await withTestTimeout(session.whenSettled(), 1_000, "Disposed login kept waiting for input");
      expect(responded).toBe(false);
      release.resolve();
      expect(await closing).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ status: "error" }),
        undefined,
      );
      expect(h.controller.signal.aborted).toBe(false);
      expect(await h.start()).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ sessionId: "login", status: "running" }),
        undefined,
      );
    } finally {
      session.close(new Error("Test cleanup"));
      release.resolve();
      await whenAdmittedWizardSessionSettled(session);
    }
  });

  it("does not register or start login when the owner disconnects during admission", async () => {
    const h = harness();
    const entered = createDeferred();
    const release = createDeferred();
    hooks.admission.mockImplementationOnce(
      async (_stateDir: string, run: () => Promise<unknown>) => {
        entered.resolve();
        await release.promise;
        return run();
      },
    );
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
      const release = createDeferred();
      let wrote = false;
      hooks.login.mockImplementation(async (options: ModelsAuthLoginFlowOptions) => {
        await release.promise;
        await options.beforePersistentEffect?.();
        wrote = true;
        return result;
      });
      await h.start();
      const session = expectDefined(h.tracker.wizardSessions.get("login"), "login session");
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
