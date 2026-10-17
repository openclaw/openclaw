import fs from "node:fs/promises";
import type { ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as nativeProvider from "../../test/e2e/qa-lab/runtime/native-provider-proof-fixture.js";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import { resolveAgentDir } from "../agents/agent-scope-config.js";
import { loadAuthProfileStoreWithoutExternalProfiles } from "../agents/auth-profiles/store-runtime.js";
import type { ModelProviderConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { captureFullEnv, deleteTestEnvValue, setTestEnvValue } from "../test-utils/env.js";

const cleanupTasks: Array<() => void | Promise<void>> = [];
const model = "fixture-model";
const keyRef = { source: "env", provider: "default", id: "CUSTOM_SETUP_FIXTURE_KEY" } as const;
const profileShape = { type: "api_key", provider: "fixture-custom" } as const;
const refProfile = { ...profileShape, keyRef };
const priorProvider = {
  baseUrl: "http://127.0.0.1:1/v1",
  api: "openai-completions",
  apiKey: "prior-fixture-credential",
} satisfies Omit<ModelProviderConfig, "models">;

afterEach(async () => {
  await Promise.allSettled(cleanupTasks.splice(0).map(async (cleanup) => cleanup()));
  vi.resetModules();
});

type Scenario = {
  protocol: "openai" | "openai-responses" | "anthropic";
  secretRef?: boolean;
  unavailableSecretRef?: boolean;
  preparationFailure?: "unexpected" | "abort";
  authless?: boolean;
  outcome?: "fail" | "cancel" | "prompt-cancel";
  surface?: "cli" | "gateway";
  isLocalGateway?: boolean;
  revokeDuringPreparation?: boolean;
};

async function runCustomSetup(scenario: Scenario) {
  const { WizardCancelledError } = await import("../wizard/prompts.js");
  const credential = `fixture-${scenario.protocol}-${scenario.outcome ?? "success"}-${scenario.secretRef ? "ref" : "literal"}`;
  const env = captureFullEnv();
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "guided-custom-")));
  const configPath = path.join(root, "openclaw.json");
  const workspace = path.join(root, "workspace");
  const requests: Array<{ stream: boolean; pathname: string; authorized: boolean }> = [];
  const serverErrors: unknown[] = [];
  const controller = new AbortController();
  const initialConfig: OpenClawConfig = {
    gateway: { mode: "local" },
    plugins: { slots: { memory: "none" } },
    agents: {
      defaults: { workspace, skipBootstrap: true, skills: [], model: "prior/working-model" },
    },
    models: { providers: { prior: { ...priorProvider, models: [] } } },
  };
  const initialBytes = `${JSON.stringify(initialConfig)}\n`;
  await fs.mkdir(workspace);
  await fs.writeFile(configPath, initialBytes);
  setTestEnvValue("OPENCLAW_STATE_DIR", root);
  setTestEnvValue("OPENCLAW_CONFIG_PATH", configPath);
  setTestEnvValue("CUSTOM_SETUP_FIXTURE_KEY", credential);
  const agentDir = resolveAgentDir(initialConfig, "main");
  const readProfiles = () => loadAuthProfileStoreWithoutExternalProfiles(agentDir).profiles;

  const server = nativeProvider.createNativeProvider(
    async (request, response, raw) => {
      const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      if (request.method === "GET" && pathname === "/v1/models") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [] }));
        return;
      }
      const body = JSON.parse(raw) as { stream?: boolean; model?: string };
      expect(pathname).toBe(
        {
          openai: "/v1/chat/completions",
          "openai-responses": "/v1/responses",
          anthropic: "/v1/messages",
        }[scenario.protocol],
      );
      const authorized = scenario.authless
        ? request.headers.authorization === undefined
        : scenario.protocol === "anthropic"
          ? request.headers["x-api-key"] === credential
          : request.headers.authorization === `Bearer ${credential}`;
      requests.push({ stream: body.stream === true, pathname, authorized });
      expect(body.model).toBe(model);
      expect(await fs.readFile(configPath, "utf8")).toBe(initialBytes);
      if (!body.stream) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{}");
        return;
      }
      if (scenario.outcome === "fail") {
        response.writeHead(401, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: `Rejected credential ${credential}` } }));
        return;
      }
      if (scenario.outcome === "cancel") {
        controller.abort();
      }
      writeCompletion(response, scenario.protocol);
    },
    (error, response) => {
      serverErrors.push(error);
      response.destroy(error instanceof Error ? error : undefined);
    },
  );
  const providerUrl = await nativeProvider.listenNativeProvider(server);
  cleanupTasks.push(async () => {
    env.restore();
    await nativeProvider.closeNativeProvider(server);
    await fs.rm(root, { recursive: true, force: true });
  });
  const baseUrl = scenario.protocol === "anthropic" ? providerUrl.slice(0, -3) : providerUrl;
  const textAnswers = [
    baseUrl,
    scenario.authless ? "" : scenario.secretRef ? "CUSTOM_SETUP_FIXTURE_KEY" : credential,
    model,
    "fixture-custom",
    "fixture-alias",
  ];
  const selectAnswers = [
    "__more",
    "custom",
    ...(scenario.surface === "gateway" && !scenario.isLocalGateway
      ? []
      : [...(scenario.secretRef ? ["ref", "env"] : ["plaintext"]), scenario.protocol]),
    "skip",
  ];
  const prompter = createWizardPrompter({
    confirm: vi.fn(async ({ message }) => {
      if (message === "Does this model support image input?") {
        return false;
      }
      expect(message).toBe("Connection verified. Activate this saved sign-in?");
      return true;
    }),
    text: vi.fn(async (params) => {
      if (scenario.outcome === "prompt-cancel" && textAnswers.length === 2) {
        throw new WizardCancelledError("cancelled");
      }
      const answer = textAnswers.shift() ?? "";
      expect(await params.validate?.(answer)).toBeUndefined();
      return answer;
    }),
    select: async (params) => {
      const value = selectAnswers.shift();
      expect(params.options.map((option) => option.value)).toContain(value);
      return value as never;
    },
  });
  const runtime = {
    log: vi.fn(),
    error: vi.fn(),
    exit: (code: number): never => {
      throw new Error(`unexpected exit ${code}`);
    },
  };
  const configModule = await import("../config/config.js");
  configModule.clearRuntimeConfigSnapshot();
  cleanupTasks.push(configModule.clearRuntimeConfigSnapshot);
  await configModule.captureRuntimeConfigAsyncReader()();
  const { activateSetupInference } = await import("../system-agent/setup-inference.js");
  const { runManualStage } = await import("./onboard-guided-manual.js");
  const activationResults: unknown[] = [];
  const replaceSelectedCredential = async () => {
    const { upsertAuthProfileWithLock } = await import("../agents/auth-profiles.js");
    const { getRuntimeAuthProfileStoreCredentialsRevision } =
      await import("../agents/auth-profiles/runtime-snapshots.js");
    const selected = Object.entries(readProfiles()).find(
      ([, profile]) => profile.provider === "fixture-custom",
    );
    if (!selected || selected[1].type !== "api_key") {
      throw new Error("Expected the saved fixture credential");
    }
    const [profileId, source] = selected;
    const revision = getRuntimeAuthProfileStoreCredentialsRevision();
    for (const replacement of [
      { ...source, keyRef: { ...keyRef, id: "UNREAD_REPLACEMENT_FIXTURE" } },
      source,
    ]) {
      expect(
        await upsertAuthProfileWithLock({ agentDir, profileId, credential: replacement }),
      ).not.toBeNull();
    }
    expect(readProfiles()[profileId]).toEqual(source);
    expect(getRuntimeAuthProfileStoreCredentialsRevision()).toBeGreaterThan(revision);
  };
  if (
    scenario.revokeDuringPreparation ||
    scenario.unavailableSecretRef ||
    scenario.preparationFailure
  ) {
    const secrets = await import("../secrets/runtime.js");
    const prepare = secrets.prepareSecretsRuntimeSnapshot;
    const spy = vi
      .spyOn(secrets, "prepareSecretsRuntimeSnapshot")
      .mockImplementationOnce(async (params) => {
        if (scenario.preparationFailure === "unexpected") {
          throw Object.assign(new Error("fixture unexpected preparation failure"), {
            name: "SecretRefResolutionError",
            code: "SECRET_REF_NOT_FOUND",
            source: "env",
            provider: "default",
            refId: "CUSTOM_SETUP_FIXTURE_KEY",
          });
        }
        if (scenario.unavailableSecretRef) {
          expect(Object.values(readProfiles())).toEqual([expect.objectContaining(refProfile)]);
          deleteTestEnvValue("CUSTOM_SETUP_FIXTURE_KEY");
        }
        if (scenario.revokeDuringPreparation || !scenario.unavailableSecretRef) {
          await replaceSelectedCredential();
        }
        if (scenario.unavailableSecretRef && scenario.preparationFailure === "abort") {
          controller.abort();
        }
        return await prepare(params);
      });
    cleanupTasks.push(() => void spy.mockRestore());
  }
  const resultPromise = runManualStage({
    detection: {
      candidates: [],
      unavailableCandidates: [],
      recommendedInstalls: [],
      manualProviders: [],
      authOptions: [],
      workspace,
      setupComplete: true,
    },
    config: initialConfig,
    workspace,
    prompter,
    runtime,
    activate: async (params) => {
      const result = await activateSetupInference({
        ...params,
        surface: scenario.surface ?? "cli",
        ...(scenario.isLocalGateway ? { isRemoteProviderAuth: false } : {}),
        signal: controller.signal,
      });
      activationResults.push(result);
      return result;
    },
  });
  const result =
    scenario.outcome === "prompt-cancel"
      ? await resultPromise.catch((error: unknown) => error)
      : await resultPromise;
  expect(serverErrors).toEqual([]);
  const authProfiles = Object.entries(readProfiles()).filter(
    ([, profile]) => profile.provider === "fixture-custom",
  );
  return {
    authProfiles: authProfiles.map(([, profile]) => profile),
    authProfileIds: authProfiles.map(([profileId]) => profileId),
    result,
    credential,
    cancelled: result instanceof WizardCancelledError,
    requests,
    initialConfig,
    activationResults,
    textPrompts: vi.mocked(prompter.text).mock.calls,
    config: JSON.parse(await fs.readFile(configPath, "utf8")) as OpenClawConfig,
    output: JSON.stringify([
      runtime.log.mock.calls,
      runtime.error.mock.calls,
      vi.mocked(prompter.note).mock.calls,
    ]),
  };
}

type Setup = Awaited<ReturnType<typeof runCustomSetup>>;
function runSecretRefSetup(overrides: Omit<Scenario, "protocol" | "secretRef"> = {}) {
  return runCustomSetup({ protocol: "openai-responses", secretRef: true, ...overrides });
}
function expectUnpromoted(setup: Setup, sent = false) {
  expect(setup.requests).toEqual(
    sent ? [expect.objectContaining({ stream: true, authorized: true })] : [],
  );
  expect(setup.config).toEqual(setup.initialConfig);
  expect(setup.output).not.toContain(setup.credential);
}
function expectActivationFailure(setup: Setup, status: string) {
  expect(setup.activationResults).toEqual([expect.objectContaining({ ok: false, status })]);
}

it("refuses a SecretRef source whose generation changes before preparation", async () => {
  const setup = await runSecretRefSetup({ revokeDuringPreparation: true });
  expect(setup.activationResults).toEqual([expect.objectContaining({ ok: false })]);
  expectUnpromoted(setup);
  expect(setup.authProfiles[0]?.setup).toBeDefined();
}, 300_000);

it.each<Scenario>([
  { protocol: "openai" as const },
  { protocol: "openai-responses" as const, secretRef: true },
  { protocol: "anthropic" as const },
  { protocol: "openai" as const, authless: true },
  { protocol: "openai", surface: "gateway", isLocalGateway: true },
  { protocol: "anthropic", surface: "gateway", isLocalGateway: true },
])(
  "verifies and persists $protocol with its selected credential shape",
  async (scenario) => {
    const setup = await runCustomSetup(scenario);
    const defaults = setup.config.agents?.defaults;
    const providers = setup.config.models?.providers;
    expect(setup.result, JSON.stringify(setup.activationResults)).toEqual(
      expect.arrayContaining(["Inference verified: fixture-custom/fixture-model"]),
    );
    expect(setup.requests).toEqual([expect.objectContaining({ stream: true, authorized: true })]);
    expect(providers?.["fixture-custom"]?.apiKey).toBe(setup.authProfileIds[0]);
    expect(JSON.stringify(setup.config)).not.toContain(setup.credential);
    expect(setup.authProfiles).toHaveLength(scenario.authless ? 0 : 1);
    if (!scenario.authless) {
      expect(setup.authProfiles[0]).toMatchObject({
        ...profileShape,
        ...(scenario.secretRef ? { keyRef } : { key: setup.credential }),
      });
      expect(setup.authProfiles[0]?.setup).toBeUndefined();
    }
    expect(defaults?.model).toContain("fixture-custom/fixture-model");
    expect(defaults?.models?.["fixture-custom/fixture-model"]?.alias).toBe("fixture-alias");
    expect(providers?.prior).toEqual(setup.initialConfig.models?.providers?.prior);
    expect(setup.output).not.toContain(setup.credential);
  },
  300_000,
);

it("does not normalize an untrusted preparer error as a missing SecretRef", async () => {
  const setup = runSecretRefSetup({ preparationFailure: "unexpected" });
  await expect(setup).rejects.toThrow("fixture unexpected preparation failure");
});

it.each([
  ["cancellation", { preparationFailure: "abort" }, "unavailable"],
  ["credential-generation drift", { revokeDuringPreparation: true }, "auth"],
  ["unresolved SecretRef", {}, "unknown"],
] as const)(
  "preserves the route on %s during SecretRef preparation",
  async (_name, scenario, status) => {
    const setup = await runSecretRefSetup({ unavailableSecretRef: true, ...scenario });
    expectUnpromoted(setup);
    expectActivationFailure(setup, status);
    if (status === "unknown") {
      expect(setup.result).toBeNull();
      expect(setup.authProfiles).toEqual([expect.objectContaining(refProfile)]);
      expect(setup.activationResults).toEqual([
        expect.objectContaining({ disposition: "rejected-before-promotion" }),
      ]);
    }
  },
);

it.each<Scenario>([
  { protocol: "openai", outcome: "fail" },
  { protocol: "openai", outcome: "cancel" },
  { protocol: "openai", outcome: "fail", surface: "gateway", isLocalGateway: true },
  { protocol: "anthropic", outcome: "cancel", surface: "gateway", isLocalGateway: true },
])(
  "preserves the prior route after $surface completion $outcome",
  async (scenario) => {
    const setup = await runCustomSetup(scenario);
    expectUnpromoted(setup, true);
    expect(setup.result).toBeNull();
    expectActivationFailure(setup, scenario.outcome === "fail" ? "auth" : "unavailable");
  },
  300_000,
);

it("preserves the prior route when custom prompts are cancelled before activation", async () => {
  const setup = await runCustomSetup({ protocol: "openai", outcome: "prompt-cancel" });
  expectUnpromoted(setup);
  expect(setup.cancelled).toBe(true);
});

it("keeps custom credential entry local to the Gateway host CLI", async () => {
  const setup = await runCustomSetup({ protocol: "openai", surface: "gateway" });
  expectUnpromoted(setup);
  expect(setup.textPrompts).toEqual([]);
  expect(setup.result).toBeNull();
  expect(setup.output).toContain(
    "run openclaw onboard --auth-choice custom-api-key on the Gateway host",
  );
});
function writeCompletion(response: ServerResponse, protocol: Scenario["protocol"]): void {
  if (protocol === "openai-responses") {
    writeOpenAiResponsesText(response, {
      text: "OK",
      messageId: "fixture-message",
      responseId: "fixture-response",
    });
    return;
  }
  if (protocol === "openai") {
    nativeProvider.writeNativeCompletion(response, "fixture-response", model, "OK");
    return;
  }
  response.writeHead(200, { "content-type": "text/event-stream" });
  const events = [
    {
      type: "message_start",
      message: {
        id: "fixture-response",
        model,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ];
  response.end(
    events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
  );
}
