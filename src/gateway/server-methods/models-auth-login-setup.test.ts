import { expectDefined } from "@openclaw/normalization-core";
import { Compile } from "typebox/compile";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WizardNextResultSchema } from "../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import type * as ModelsAuth from "../../commands/models/auth.js";
import type * as ProviderChoices from "../../plugins/provider-auth-choices.js";
import type { ProviderAuthChoiceMetadata } from "../../plugins/provider-auth-choices.js";
import type * as SetupMigration from "../../wizard/setup.migration-snapshot.js";
import { createWizardSessionTracker } from "../server-wizard-sessions.js";
import type { GatewayClient } from "./client-types.js";
import { modelsAuthLoginHandlers } from "./models-auth-login.js";
import { whenAdmittedWizardSessionSettled } from "./setup-admission.js";
import type * as SetupExecution from "./system-agent-execution.js";
import type { GatewayRequestContext, RespondFn } from "./types.js";
import { wizardHandlers } from "./wizard.js";

const hooks = vi.hoisted(() => ({ choice: vi.fn(), activate: vi.fn(), login: vi.fn() }));
vi.mock("../../plugins/provider-auth-choices.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ProviderChoices>()),
  resolveManifestDeclaredProviderAuthChoices: () => [hooks.choice()],
}));
vi.mock("../../commands/models/auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ModelsAuth>()),
  runModelsAuthLoginFlowForGateway: hooks.login,
}));
vi.mock("./system-agent-execution.js", async (importOriginal) => ({
  ...(await importOriginal<typeof SetupExecution>()),
  activateGatewaySetupInference: hooks.activate,
}));
vi.mock("../../wizard/setup.migration-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof SetupMigration>()),
  withSetupMigrationTargetLock: async (_stateDir: string, run: () => Promise<unknown>) =>
    await run(),
}));

const choice: ProviderAuthChoiceMetadata = {
  pluginId: "meta",
  providerId: "meta",
  methodId: "muse-code",
  choiceId: "muse-code",
  choiceLabel: "Muse Code",
  appGuidedAuth: "device-code",
};
const tracker = createWizardSessionTracker();
const client: GatewayClient = {
  connId: "setup-owner",
  connect: {
    minProtocol: 1,
    maxProtocol: 1,
    scopes: ["operator.admin"],
    client: { id: "cli", version: "test", platform: "test", mode: "cli" },
  },
};
// SAFETY: These handlers consume only the wizard tracker and runtime-config getter in this fixture.
const context = { ...tracker, getRuntimeConfig: () => ({}) } as GatewayRequestContext;

async function invoke(method: string, params: Record<string, unknown>) {
  const respond = vi.fn<RespondFn>();
  await expectDefined(
    modelsAuthLoginHandlers[method] ?? wizardHandlers[method],
    method,
  )({
    req: { type: "req", id: "request", method, params },
    params,
    respond,
    context,
    client,
    isWebchatConnect: () => false,
  });
  expect(respond).toHaveBeenCalledOnce();
  return expectDefined(respond.mock.calls[0], "RPC response");
}

const validateWizardResult = Compile(WizardNextResultSchema);
let connection = new AbortController();
beforeEach(() => {
  hooks.choice.mockReturnValue(choice);
  client.connect.scopes = ["operator.admin"];
  connection = new AbortController();
  client.connectionSignal = connection.signal;
});
afterEach(async () => {
  for (const session of tracker.wizardSessions.values()) {
    session.cancel();
    await whenAdmittedWizardSessionSettled(session);
  }
  tracker.wizardSessions.clear();
  vi.resetAllMocks();
});

it.each([false, true])(
  "dispatches provider login through its declared setup semantics (credentialOnly: %s)",
  async (credentialOnly) => {
    hooks.choice.mockReturnValue({ ...choice, credentialOnly });
    hooks.activate.mockImplementation(
      async (params: Parameters<typeof SetupExecution.activateGatewaySetupInference>[0]) => {
        expect(params).toMatchObject({
          kind: "provider-auth",
          authChoice: "muse-code",
          agentId: "main",
        });
        await params.prompter?.note("Approve the Muse code");
        await params.beforePersistentEffect?.();
        params.onCommitStarted?.({});
        return { ok: true, modelRef: "meta/muse-spark-1.3", latencyMs: 1, lines: [] };
      },
    );
    hooks.login.mockImplementation(async (params: ModelsAuth.ModelsAuthLoginFlowOptions) => {
      await params.prompter?.note("Save the credential");
      return {
        providerId: "meta",
        methodId: "muse-code",
        authRefresh: "refreshed",
        profiles: [{ profileId: "meta:fixture", provider: "meta", mode: "oauth" }],
      };
    });
    expect(
      (
        await invoke("models.authLogin", {
          sessionId: "setup-login",
          authChoice: "meta/muse-code",
          agentId: "main",
        })
      )[0],
    ).toBe(true);
    const first = await invoke("wizard.next", { sessionId: "setup-login" });
    expect(first[0]).toBe(true);
    if (!validateWizardResult.Check(first[1])) {
      throw new Error("Expected a wizard response");
    }
    const step = expectDefined(first[1]?.step, "login step");
    expect(step.message).toBe(credentialOnly ? "Save the credential" : "Approve the Muse code");
    const done = await invoke("wizard.next", {
      sessionId: "setup-login",
      answer: { stepId: step.id, value: null },
    });
    expect(done[1]).toMatchObject({ done: true, status: "done" });
    expect(hooks.activate).toHaveBeenCalledTimes(credentialOnly ? 0 : 1);
    expect(hooks.login).toHaveBeenCalledTimes(credentialOnly ? 1 : 0);
  },
);

it("cancels native setup when the owning login connection closes", async () => {
  const stopped = createDeferred();
  hooks.activate.mockImplementation(
    async (params: Parameters<typeof SetupExecution.activateGatewaySetupInference>[0]) => {
      const signal = expectDefined(params.signal, "setup cancellation signal");
      signal.addEventListener("abort", () => stopped.resolve(), { once: true });
      await params.prompter?.note("Approve the Muse code");
      throw new Error("Setup must remain paused until cancellation");
    },
  );
  await invoke("models.authLogin", {
    sessionId: "setup-disconnect",
    authChoice: "meta/muse-code",
    agentId: "main",
  });
  await invoke("wizard.next", { sessionId: "setup-disconnect" });
  connection.abort();
  await stopped.promise;
  const session = tracker.wizardSessions.get("setup-disconnect");
  if (session) {
    await whenAdmittedWizardSessionSettled(session);
  }
  expect(hooks.login).not.toHaveBeenCalled();
});
