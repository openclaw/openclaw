import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as nativeProvider from "../../test/e2e/qa-lab/runtime/native-provider-proof-fixture.js";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import { listKnownProviderAuthEnvVarNamesCore } from "../secrets/provider-env-vars.js";
import { captureFullEnv, deleteTestEnvValue, setTestEnvValue } from "../test-utils/env.js";
import type { GuidedOrchestrationFixture as GuidedOnboardingDeps } from "./onboard-guided-runtime.test-support.js";

vi.mock("./onboard-interactive-runner.js", async (importActual) => {
  const actual = await importActual<typeof import("./onboard-interactive-runner.js")>();
  return {
    ...actual,
    hasInteractiveOnboardingTty: () => true,
    runInteractiveOnboarding: async (run: () => Promise<void>) => await run(),
  };
});

const cleanupTasks: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.allSettled(cleanupTasks.splice(0).map((cleanup) => cleanup()));
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("guided onboarding inference composition", () => {
  it.each(["configured", "before-provision", "after-members", "after-provision"] as const)(
    "advances through a real embedded probe and setup (%s)",
    { timeout: 300_000 },
    async (mode) => {
      const team = mode !== "configured";
      const env = captureFullEnv();
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-guided-inference-e2e-"));
      const workspace = path.join(root, "workspace");
      const configPath = path.join(root, "openclaw.json");
      const mockOpenAi = await startMockOpenAiServer();
      cleanupTasks.push(async () => {
        env.restore();
        await mockOpenAi.close();
        await fs.rm(root, { recursive: true, force: true });
      });

      for (const key of listKnownProviderAuthEnvVarNamesCore()) {
        deleteTestEnvValue(key);
      }
      setTestEnvValue("HOME", root);
      setTestEnvValue("USERPROFILE", root);
      setTestEnvValue("CODEX_HOME", path.join(root, "codex"));
      setTestEnvValue("CLAUDE_CONFIG_DIR", path.join(root, "claude"));
      setTestEnvValue("OPENCLAW_STATE_DIR", root);
      setTestEnvValue("OPENCLAW_CONFIG_PATH", configPath);
      setTestEnvValue("OPENAI_API_KEY", "test-openai-key");
      setTestEnvValue("PATH", path.dirname(process.execPath));
      // The live probe and owner revalidation must use the same packaged plugin tree.
      // The shared source-test default otherwise mixes built fingerprints with source loading.
      setTestEnvValue(
        "OPENCLAW_BUNDLED_PLUGINS_DIR",
        fileURLToPath(new URL("../../dist/extensions", import.meta.url)),
      );

      await fs.mkdir(workspace, { recursive: true });
      await fs.writeFile(
        configPath,
        `${JSON.stringify({
          meta: { migrations: { utilityModelSeparation: true } },
          ...(!team ? { gateway: { mode: "local" } } : {}),
          plugins: { slots: { memory: "none" } },
          agents: {
            defaults: {
              ...(!team ? { workspace } : {}),
              skipBootstrap: true,
              skills: [],
            },
          },
          models: {
            mode: "replace",
            providers: {
              openai: {
                baseUrl: mockOpenAi.baseUrl,
                apiKey: "OPENAI_API_KEY",
                api: "openai-responses",
                request: { allowPrivateNetwork: true },
                models: [
                  nativeProvider.nativeModel("gpt-5.6", {
                    name: "GPT-5.6 mock",
                    api: "openai-responses",
                    reasoning: true,
                    contextWindow: 272_000,
                    maxTokens: 128_000,
                  }),
                ],
              },
            },
          },
        })}\n`,
      );

      const prompter = createWizardPrompter(
        {
          text: vi.fn(async ({ initialValue }) => initialValue ?? ""),
        },
        { selectValues: [team ? "team" : "one", "full", "detected-ai"] },
      );
      const runSetupMemoryImportStep = vi.fn(async () => ({
        status: "skipped" as const,
        providers: [],
      }));
      const runAppRecommendations = vi.fn(async ({ config }) => ({
        config,
        commitResult: vi.fn(async () => undefined),
      }));
      const launchHatchTui = vi.fn(async () => undefined);
      const observeHandoff = vi.fn();
      const runSystemAgentChat = vi.fn(async () => undefined);
      const runtime = {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn((code: number): never => {
          throw new Error(`unexpected exit ${code}`);
        }),
      };

      const configModule = await import("../config/config.js");
      configModule.clearConfigCache();
      const setupInference = await import("../system-agent/setup-inference.js");
      const onboardInference = await import("./onboard-inference.js");
      const detectBackends = onboardInference.detectInferenceBackends;
      const providerChoices = await import("../plugins/provider-auth-choices.js");
      const probes = await import("../system-agent/probes.js");
      const cliCredentials = await import("../agents/cli-credentials.js");
      vi.spyOn(probes, "probeLocalCommand").mockImplementation(async (command) => ({
        command,
        found: false,
        error: "not found",
      }));
      vi.spyOn(cliCredentials, "hasCodexCliAuthFile").mockReturnValue(false);
      const { runGuidedOnboardingWithFixtures: runGuidedOnboarding } =
        await import("./onboard-guided-runtime.test-support.js");
      const { applySystemAgentSetup } = await import("../system-agent/setup-apply.js");
      let activePrompter = prompter;
      let interruptAfterProvision = team;
      const deps: GuidedOnboardingDeps = {
        createPrompter: () => activePrompter,
        detect: async () => {
          const choices = vi
            .spyOn(providerChoices, "resolveManifestProviderAuthChoices")
            .mockReturnValue([]);
          const backends = vi
            .spyOn(onboardInference, "detectInferenceBackends")
            .mockImplementation(async (options) =>
              detectBackends({
                config: options?.config,
              }),
            );
          try {
            return await setupInference.detectSetupInference();
          } finally {
            backends.mockRestore();
            choices.mockRestore();
          }
        },
        activate: async (params) => {
          const result = await setupInference.activateSetupInference(params);
          expect(result.ok, result.ok ? undefined : result.error).toBe(true);
          return result;
        },
        applySetup: async (params, hooks) => {
          if (interruptAfterProvision && mode === "before-provision") {
            throw new Error("fixture interruption before provisioning");
          }
          if (interruptAfterProvision && mode === "after-members") {
            const onboarding = await import("./onboard-agent.js");
            const ensureAgent = onboarding.ensureOnboardingAgent;
            vi.spyOn(onboarding, "ensureOnboardingAgent").mockImplementationOnce(async (input) => {
              await ensureAgent(input);
              throw new Error("fixture interruption after member creation");
            });
          }
          const result = await applySystemAgentSetup({ ...params, surface: "gateway" }, hooks);
          return interruptAfterProvision ? { ...result, workspaceReady: false } : result;
        },
        runSetupMemoryImportStep,
        runAppRecommendations,
        launchHatchTui,
        observeHandoff,
        runSystemAgentChat,
      };
      const run = () =>
        runGuidedOnboarding({ acceptRisk: true, workspace, tui: true }, runtime, deps);
      if (team) {
        await expect(run()).rejects.toThrow(
          mode === "after-provision" ? "workspace could not be prepared" : "fixture interruption",
        );
        const { readLocalOnboardingState } = await import("../state/local-onboarding-state.js");
        expect(readLocalOnboardingState(configPath)).toMatchObject({
          status: "pending",
          workspace,
          teamCoordinatorId: "coordinator",
        });
        expect(launchHatchTui).not.toHaveBeenCalled();
        if (mode === "after-members") {
          expect(
            (await configModule.readConfigFileSnapshot()).sourceConfigBeforeMigrations?.agents
              ?.defaults?.workspace,
          ).toBeUndefined();
        }
        interruptAfterProvision = false;
        activePrompter = createWizardPrompter(undefined, {
          selectValues: ["full", "detected-ai", "candidate:existing-model"],
        });
      }
      await run();

      const selection = (index: number, options: object) =>
        expect(prompter.select).toHaveBeenNthCalledWith(index, expect.objectContaining(options));
      selection(1, {
        initialValue: false,
        options: [
          expect.objectContaining({ value: false }),
          expect.objectContaining({ value: true }),
        ],
      });
      selection(2, {
        initialValue: "one",
        options: [
          { value: "one", label: "One agent" },
          { value: "team", label: "A small team: a chief of staff plus specialists" },
        ],
      });
      selection(3, {
        options: expect.arrayContaining([expect.objectContaining({ value: "full" })]),
      });
      const persisted = await configModule.readConfigFileSnapshot();
      expect(runSystemAgentChat).not.toHaveBeenCalled();
      expect(persisted.valid).toBe(true);
      expect(persisted.sourceConfig).toMatchObject({
        telemetry: { enabled: false, consentedAt: expect.any(String) },
        wizard: { accessMode: "full" },
      });
      expect(mockOpenAi.requestBodies).toHaveLength(team ? 2 : 1);
      expect(JSON.parse(mockOpenAi.requestBodies[0] ?? "{}")).toMatchObject({
        model: "gpt-6-astra",
      });
      const notes = [
        ...vi.mocked(prompter.note).mock.calls,
        ...(activePrompter === prompter ? [] : vi.mocked(activePrompter.note).mock.calls),
      ];
      const inferenceReadyIndex = notes.findIndex((call) => call[1] === "Inference ready");
      const postInferenceIndex = notes.findIndex(
        (call, index) =>
          index > inferenceReadyIndex &&
          call[0].includes(team ? "Workspace:" : "your AI just passed a fresh check"),
      );
      expect(inferenceReadyIndex).toBeGreaterThanOrEqual(0);
      expect(postInferenceIndex).toBeGreaterThan(inferenceReadyIndex);
      expect(runSetupMemoryImportStep).toHaveBeenCalledOnce();
      expect(runAppRecommendations).toHaveBeenCalledWith(
        expect.objectContaining({
          modelRouteVerified: true,
          workspaceDir: team ? path.join(workspace, "coordinator") : workspace,
        }),
      );
      expect(observeHandoff).toHaveBeenCalledWith(
        expect.objectContaining({
          next: "hatch",
          workspace: team ? path.join(workspace, "coordinator") : workspace,
        }),
      );
      expect(launchHatchTui).toHaveBeenCalledWith(
        expect.objectContaining({
          deliver: false,
          ...(team ? { session: "agent:coordinator:main" } : { local: true }),
        }),
      );
      if (team) {
        expect(Object.keys(persisted.sourceConfig.agents?.entries ?? {})).toEqual([
          "coordinator",
          "researcher",
          "writer",
          "reviewer",
        ]);
        const { readLocalOnboardingState } = await import("../state/local-onboarding-state.js");
        expect(readLocalOnboardingState(configPath)).toMatchObject({
          status: "completed",
          workspace,
        });
      }
    },
  );
});

async function startMockOpenAiServer() {
  const requestBodies: string[] = [];
  const server = nativeProvider.createNativeProvider(
    async (request, response, body) => {
      if (
        request.method !== "POST" ||
        new URL(request.url ?? "/", "http://127.0.0.1").pathname !== "/v1/responses"
      ) {
        response.writeHead(404).end();
        return;
      }
      requestBodies.push(body);
      writeOpenAiResponsesText(response, {
        text: "OK",
        messageId: "guided-inference-message",
        responseId: "guided-inference-response",
      });
    },
    (error, response) => response.destroy(error instanceof Error ? error : undefined),
  );
  return {
    baseUrl: await nativeProvider.listenNativeProvider(server),
    requestBodies,
    close: () => nativeProvider.closeNativeProvider(server),
  };
}
