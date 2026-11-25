import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resetCommandQueueStateForTest } from "../../process/command-queue.test-support.js";
import { createDeferredCore } from "../../shared/deferred.js";
import type { WizardSession } from "../../wizard/session.js";
import { whenAdmittedWizardSessionSettled } from "./setup-admission.js";
import {
  answerWizard,
  callWizardNext,
  invoke,
  makeContext,
} from "./system-agent-setup.test-support.js";

const mocks = vi.hoisted(() => ({
  prepare: vi.fn(),
  snapshot: vi.fn(),
  write: vi.fn(),
}));

// mock-isolation: Hold provider preparation without prompting for or storing real credentials.
vi.mock("../../plugins/provider-auth-choice.js", () => ({
  prepareAuthChoiceLoadedPluginProvider: mocks.prepare,
}));
// mock-isolation: Admission tests use controlled snapshots, never the operator's configuration.
vi.mock("../../wizard/setup.shared.js", () => ({
  readSetupConfigFileSnapshot: mocks.snapshot,
}));
vi.mock("../../plugins/provider-auth-config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/provider-auth-config.js")>()),
  writeProviderAuthConfig: mocks.write,
}));

const config: OpenClawConfig = {
  agents: { defaults: { model: "openai/gpt-5.6-luna" } },
};

describe("openclaw.setup provider preparation", () => {
  beforeEach(() => {
    mocks.snapshot.mockResolvedValue({
      exists: true,
      valid: true,
      path: "/tmp/openclaw.json",
      hash: "setup-resolution-config",
      sourceConfig: config,
      config,
      issues: [],
    });
    mocks.write.mockImplementation(async ({ config: writtenConfig }) => writtenConfig);
  });

  afterEach(() => {
    vi.resetAllMocks();
    resetCommandQueueStateForTest();
  });

  it.each(["before credentials", "during credentials"])(
    "keeps provider preparation consistent when expiry occurs %s",
    async (expiryPoint) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const { wizardSessions, context } = makeContext();
      const sessionId = "prepare-credential-commit";
      const preparationStarted = createDeferredCore();
      const finishPreparation = createDeferredCore();
      const credentialWriteStarted = createDeferredCore();
      const finishCredentialWrite = createDeferredCore();
      const preparedConfig: OpenClawConfig = {
        ...config,
        auth: { profiles: { "fixture:default": { provider: "fixture", mode: "api_key" } } },
      };
      const beforeCredentials = expiryPoint === "before credentials";
      let credentialsWritten = false;
      let session: WizardSession | undefined;
      const persistAuthProfiles = vi.fn();
      mocks.prepare.mockImplementationOnce(async (params, consume) => {
        await params.prompter.confirm({ message: "Prepare provider?", initialValue: false });
        await params.beforePersistentEffect();
        preparationStarted.resolve();
        await finishPreparation.promise;
        persistAuthProfiles.mockImplementationOnce(async () => {
          await params.beforePersistentEffect();
          credentialWriteStarted.resolve();
          await finishCredentialWrite.promise;
          credentialsWritten = true;
        });
        return consume({
          config: preparedConfig,
          agentModelOverride: "fixture/demo-model",
          authProfiles: [],
          persistAuthProfiles,
        });
      });
      try {
        await invoke("openclaw.setup.prepare.start", context, {
          sessionId,
          authChoice: "fixture-provider",
        });
        session = expectDefined(wizardSessions.get(sessionId), "provider preparation wizard");
        const confirmation = await callWizardNext(context, { sessionId });
        const terminal = answerWizard(context, sessionId, confirmation, true);
        await preparationStarted.promise;
        if (beforeCredentials) {
          await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1_000);
          expect(session.getStatus()).toBe("running");
          finishCredentialWrite.resolve();
        }
        finishPreparation.resolve();
        if (!beforeCredentials) {
          await credentialWriteStarted.promise;
          await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1_000);

          const calls = await invoke("wizard.cancel", context, { sessionId });
          expect(calls[0]?.payload).toMatchObject({ status: "running" });
          expect(session.signal.aborted).toBe(false);
          expect(mocks.write).not.toHaveBeenCalled();
          finishCredentialWrite.resolve();
        }
        const done = await terminal;
        expect(credentialsWritten).toBe(!beforeCredentials);
        expect(persistAuthProfiles).toHaveBeenCalledTimes(beforeCredentials ? 0 : 1);
        expect(done).toMatchObject({
          done: true,
          status: beforeCredentials ? "cancelled" : "done",
        });
        if (beforeCredentials) {
          expect(mocks.write).not.toHaveBeenCalled();
          expect(done).not.toHaveProperty("preparedModelRef");
        } else {
          expect(mocks.write).toHaveBeenCalledOnce();
          expect(done.preparedModelRef).toBe("fixture/demo-model");
        }
        expect(wizardSessions.has(sessionId)).toBe(false);
      } finally {
        finishPreparation.resolve();
        finishCredentialWrite.resolve();
        session?.cancel();
        if (session) {
          await whenAdmittedWizardSessionSettled(session);
        }
        vi.useRealTimers();
      }
    },
  );

  it.each([false, true])(
    "runs provider preparation with native discovery preference %s",
    async (nativeSessionCatalogsEnabled) => {
      const preparedConfig: OpenClawConfig = {
        ...config,
        models: { providers: { ollama: { baseUrl: "http://127.0.0.1:11434", models: [] } } },
      };
      const persistAuthProfiles = vi.fn();
      mocks.prepare.mockImplementationOnce(async (params, consume) => {
        await params.prompter.note("Model ready", "Ollama");
        await params.beforePersistentEffect();
        return consume({
          config: preparedConfig,
          agentModelOverride: "ollama/qwen3:0.6b",
          authProfiles: [],
          persistAuthProfiles,
        });
      });
      const { wizardSessions, context } = makeContext();

      const calls = await invoke("openclaw.setup.prepare.start", context, {
        sessionId: "prepare-session-1",
        nativeSessionCatalogsEnabled,
        agentId: "research",
        authChoice: "ollama",
        workspace: "/tmp/models-workspace",
      });

      expect(calls[0]).toMatchObject({
        ok: true,
        payload: { sessionId: "prepare-session-1", done: false, status: "running" },
      });
      const session = expectDefined(
        wizardSessions.get("prepare-session-1"),
        "prepare wizard session",
      );
      const note = await callWizardNext(context, { sessionId: "prepare-session-1" });
      expect(note).toMatchObject({
        done: false,
        step: { type: "note", title: "Ollama", message: "Model ready" },
      });
      expect(mocks.prepare).toHaveBeenCalledWith(
        expect.objectContaining({
          authChoice: "ollama",
          agentId: "research",
          config,
          workspaceDir: "/tmp/models-workspace",
          setDefaultModel: false,
          preserveExistingDefaultModel: true,
          signal: session.signal,
          isRemote: true,
        }),
        expect.any(Function),
      );
      const done = await answerWizard(context, "prepare-session-1", note, null);
      expect(done).toEqual({
        done: true,
        status: "done",
        preparedModelRef: "ollama/qwen3:0.6b",
      });
      expect(persistAuthProfiles).toHaveBeenCalledOnce();
      expect(mocks.write).toHaveBeenCalledOnce();
    },
  );
});
