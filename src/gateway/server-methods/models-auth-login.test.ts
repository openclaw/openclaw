import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred, withTestTimeout } from "../../../test/helpers/promise.js";
import type { ModelsAuthLoginFlowOptions } from "../../commands/models/auth.js";
import type { ProviderAuthChoiceMetadata } from "../../plugins/provider-auth-choices.js";
import { createWizardSessionTracker } from "../server-wizard-sessions.js";
import type { GatewayClient } from "./client-types.js";
import { modelsAuthLoginHandlers } from "./models-auth-login.js";
import { whenAdmittedWizardSessionSettled } from "./setup-admission.js";
import type { GatewayRequestContext } from "./types.js";
import { wizardHandlers } from "./wizard.js";

const hooks = vi.hoisted(() => ({ login: vi.fn(), choice: vi.fn(), admission: vi.fn() }));
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

  it("denies peer reads, answers and cancellation while the owner can complete", async () => {
    const h = harness();
    let accepted = false;
    hooks.login.mockImplementation(async (options: ModelsAuthLoginFlowOptions) => {
      accepted = await options.prompter.confirm({ message: "Continue?" });
      return result;
    });
    await h.start();
    const session = expectDefined(h.tracker.wizardSessions.get("login"), "login session");
    const prompt = await session.next();
    const answer = { stepId: expectDefined(prompt.step, "confirmation").id, value: true };
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
    expect(accepted).toBe(false);
    expect(session.getStatus()).toBe("running");
    const completed = await h.invoke("wizard.next", { sessionId: "login", answer });
    expect(completed).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ done: true, status: "done" }),
      undefined,
    );
    expect(accepted).toBe(true);
  });

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

  it("releases admission on disconnect with a pending note after cancellation locks", async () => {
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
      const cancelled = await h.invoke("wizard.cancel", { sessionId: "login" });
      expect(cancelled).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ status: "running" }),
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
      expect(await h.invoke("wizard.cancel", { sessionId: "login" })).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ status: "running" }),
        undefined,
      );
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
