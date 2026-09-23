import fs from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import { resolveAgentDir } from "../agents/agent-scope-config.js";
import { loadAuthProfileStoreWithoutExternalProfiles } from "../agents/auth-profiles/store-runtime.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { captureFullEnv, deleteTestEnvValue, setTestEnvValue } from "../test-utils/env.js";

const cleanupTasks: Array<() => Promise<void>> = [];
const model = "fixture-model";

afterEach(async () => {
  await Promise.allSettled(cleanupTasks.splice(0).map((cleanup) => cleanup()));
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
    models: {
      providers: {
        prior: {
          baseUrl: "http://127.0.0.1:1/v1",
          api: "openai-completions",
          apiKey: "prior-fixture-credential",
          models: [],
        },
      },
    },
  };
  const initialBytes = `${JSON.stringify(initialConfig)}\n`;
  await fs.mkdir(workspace);
  await fs.writeFile(configPath, initialBytes);
  setTestEnvValue("OPENCLAW_STATE_DIR", root);
  setTestEnvValue("OPENCLAW_CONFIG_PATH", configPath);
  setTestEnvValue("CUSTOM_SETUP_FIXTURE_KEY", credential);

  const server = createServer((request, response) => {
    void (async () => {
      let raw = "";
      for await (const chunk of request) {
        raw += String(chunk);
      }
      const body = JSON.parse(raw) as { stream?: boolean; model?: string };
      const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
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
    })().catch((error: unknown) => {
      serverErrors.push(error);
      response.destroy(error instanceof Error ? error : undefined);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  cleanupTasks.push(async () => {
    env.restore();
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    await fs.rm(root, { recursive: true, force: true });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("custom provider fixture did not bind");
  }
  const baseUrl = `http://127.0.0.1:${address.port}${scenario.protocol === "anthropic" ? "" : "/v1"}`;
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
  configModule.clearConfigCache();
  const { activateSetupInference } = await import("../system-agent/setup-inference.js");
  const { runManualStage } = await import("./onboard-guided-manual.js");
  const activationResults: unknown[] = [];
  const replaceSelectedCredential = async () => {
    const { upsertAuthProfileWithLock } = await import("../agents/auth-profiles.js");
    const { getRuntimeAuthProfileStoreCredentialsRevision } =
      await import("../agents/auth-profiles/runtime-snapshots.js");
    const agentDir = resolveAgentDir(initialConfig, "main");
    const selected = Object.entries(
      loadAuthProfileStoreWithoutExternalProfiles(agentDir).profiles,
    ).find(([, profile]) => profile.provider === "fixture-custom");
    if (!selected || selected[1].type !== "api_key") {
      throw new Error("Expected the saved fixture credential");
    }
    const [profileId, source] = selected;
    const revision = getRuntimeAuthProfileStoreCredentialsRevision();
    expect(
      await upsertAuthProfileWithLock({
        agentDir,
        profileId,
        credential: {
          ...source,
          type: "api_key",
          keyRef: { source: "env", provider: "default", id: "UNREAD_REPLACEMENT_FIXTURE" },
        },
      }),
    ).not.toBeNull();
    expect(
      await upsertAuthProfileWithLock({ agentDir, profileId, credential: source }),
    ).not.toBeNull();
    expect(loadAuthProfileStoreWithoutExternalProfiles(agentDir).profiles[profileId]).toEqual(
      source,
    );
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
          const saved = loadAuthProfileStoreWithoutExternalProfiles(
            resolveAgentDir(initialConfig, "main"),
          );
          expect(Object.values(saved.profiles)).toEqual([
            expect.objectContaining({
              type: "api_key",
              provider: "fixture-custom",
              keyRef: { source: "env", provider: "default", id: "CUSTOM_SETUP_FIXTURE_KEY" },
            }),
          ]);
          deleteTestEnvValue("CUSTOM_SETUP_FIXTURE_KEY");
          if (scenario.revokeDuringPreparation) {
            await replaceSelectedCredential();
          }
          if (scenario.preparationFailure === "abort") {
            controller.abort();
          }
        } else {
          await replaceSelectedCredential();
        }
        return await prepare(params);
      });
    cleanupTasks.push(async () => {
      spy.mockRestore();
    });
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
  const authProfiles = Object.values(
    loadAuthProfileStoreWithoutExternalProfiles(resolveAgentDir(initialConfig, "main")).profiles,
  ).filter((profile) => profile.provider === "fixture-custom");
  return {
    authProfiles,
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

describe("guided custom provider activation", () => {
  it(
    "refuses a SecretRef source whose generation changes before preparation",
    { timeout: 300_000 },
    async () => {
      const setup = await runCustomSetup({
        protocol: "openai-responses",
        secretRef: true,
        revokeDuringPreparation: true,
      });
      expect(setup.activationResults).toEqual([expect.objectContaining({ ok: false })]);
      expect(setup.requests).toEqual([]);
      expect(setup.config.agents?.defaults?.model).toBe("prior/working-model");
      expect(setup.authProfiles[0]?.setup).toBeDefined();
      expect(setup.output).not.toContain(setup.credential);
    },
  );

  it.each<Scenario>([
    { protocol: "openai" as const },
    { protocol: "openai-responses" as const, secretRef: true },
    { protocol: "anthropic" as const },
    { protocol: "openai" as const, authless: true },
    { protocol: "openai", surface: "gateway", isLocalGateway: true },
    { protocol: "anthropic", surface: "gateway", isLocalGateway: true },
  ])(
    "verifies and persists $protocol with its selected credential shape",
    { timeout: 300_000 },
    async (scenario) => {
      const setup = await runCustomSetup(scenario);
      expect(setup.result, JSON.stringify(setup.activationResults)).toEqual(
        expect.arrayContaining(["Inference verified: fixture-custom/fixture-model"]),
      );
      expect(setup.requests).toEqual([expect.objectContaining({ stream: true, authorized: true })]);
      expect(setup.config.models?.providers?.["fixture-custom"]?.apiKey).toBeUndefined();
      expect(JSON.stringify(setup.config)).not.toContain(setup.credential);
      expect(setup.authProfiles).toHaveLength(scenario.authless ? 0 : 1);
      if (!scenario.authless) {
        expect(setup.authProfiles[0]).toMatchObject({
          type: "api_key",
          provider: "fixture-custom",
          ...(scenario.secretRef
            ? { keyRef: { source: "env", provider: "default", id: "CUSTOM_SETUP_FIXTURE_KEY" } }
            : { key: setup.credential }),
        });
        expect(setup.authProfiles[0]?.setup).toBeUndefined();
      }
      expect(setup.config.agents?.defaults?.model).toContain("fixture-custom/fixture-model");
      expect(setup.config.agents?.defaults?.models?.["fixture-custom/fixture-model"]?.alias).toBe(
        "fixture-alias",
      );
      expect(setup.config.models?.providers?.prior).toEqual(
        setup.initialConfig.models?.providers?.prior,
      );
      expect(setup.output).not.toContain(setup.credential);
    },
  );

  it("does not normalize an untrusted preparer error as a missing SecretRef", async () => {
    await expect(
      runCustomSetup({
        protocol: "openai-responses",
        secretRef: true,
        preparationFailure: "unexpected",
      }),
    ).rejects.toThrow("fixture unexpected preparation failure");
  });

  it("keeps cancellation ahead of a missing SecretRef refusal", async () => {
    const setup = await runCustomSetup({
      protocol: "openai-responses",
      secretRef: true,
      unavailableSecretRef: true,
      preparationFailure: "abort",
    });
    expect(setup.requests).toEqual([]);
    expect(setup.config).toEqual(setup.initialConfig);
    expect(setup.activationResults).toEqual([
      expect.objectContaining({ ok: false, status: "unavailable" }),
    ]);
    expect(setup.output).not.toContain(setup.credential);
  });

  it("keeps credential-generation drift ahead of a missing SecretRef refusal", async () => {
    const setup = await runCustomSetup({
      protocol: "openai-responses",
      secretRef: true,
      unavailableSecretRef: true,
      revokeDuringPreparation: true,
    });
    expect(setup.requests).toEqual([]);
    expect(setup.config).toEqual(setup.initialConfig);
    expect(setup.activationResults).toEqual([
      expect.objectContaining({ ok: false, status: "auth" }),
    ]);
    expect(setup.output).not.toContain(setup.credential);
  });

  it("saves an unresolved SecretRef without promoting the prior route", async () => {
    const setup = await runCustomSetup({
      protocol: "openai-responses",
      secretRef: true,
      unavailableSecretRef: true,
    });
    expect(setup.requests).toEqual([]);
    expect(setup.result).toBeNull();
    expect(setup.config).toEqual(setup.initialConfig);
    expect(Object.values(setup.authProfiles)).toEqual([
      expect.objectContaining({
        type: "api_key",
        provider: "fixture-custom",
        keyRef: {
          source: "env",
          provider: "default",
          id: "CUSTOM_SETUP_FIXTURE_KEY",
        },
      }),
    ]);
    expect(setup.activationResults).toEqual([
      expect.objectContaining({
        ok: false,
        status: "unknown",
        disposition: "rejected-before-promotion",
      }),
    ]);
    expect(setup.output).not.toContain(setup.credential);
  });

  it.each<Scenario>([
    { protocol: "openai", outcome: "fail" },
    { protocol: "openai", outcome: "cancel" },
    { protocol: "openai", outcome: "fail", surface: "gateway", isLocalGateway: true },
    { protocol: "anthropic", outcome: "cancel", surface: "gateway", isLocalGateway: true },
  ])(
    "preserves the prior route after $surface completion $outcome",
    { timeout: 300_000 },
    async (scenario) => {
      const setup = await runCustomSetup(scenario);
      expect(setup.requests).toEqual([expect.objectContaining({ stream: true, authorized: true })]);
      expect(setup.result).toBeNull();
      expect(setup.config).toEqual(setup.initialConfig);
      expect(setup.output).not.toContain(setup.credential);
      expect(setup.activationResults).toEqual([
        expect.objectContaining({
          ok: false,
          status: scenario.outcome === "fail" ? "auth" : "unavailable",
        }),
      ]);
    },
  );

  it("preserves the prior route when custom prompts are cancelled before activation", async () => {
    const setup = await runCustomSetup({ protocol: "openai", outcome: "prompt-cancel" });
    expect(setup.requests).toEqual([]);
    expect(setup.cancelled).toBe(true);
    expect(setup.config).toEqual(setup.initialConfig);
  });

  it("keeps custom credential entry local to the Gateway host CLI", async () => {
    const setup = await runCustomSetup({ protocol: "openai", surface: "gateway" });
    expect(setup.requests).toEqual([]);
    expect(setup.textPrompts).toEqual([]);
    expect(setup.result).toBeNull();
    expect(setup.config).toEqual(setup.initialConfig);
    expect(setup.output).toContain(
      "run openclaw onboard --auth-choice custom-api-key on the Gateway host",
    );
  });
});

function writeCompletion(response: ServerResponse, protocol: Scenario["protocol"]): void {
  response.writeHead(200, { "content-type": "text/event-stream" });
  if (protocol === "openai") {
    const chunk = {
      id: "fixture-response",
      object: "chat.completion.chunk",
      created: 1,
      model,
      choices: [{ index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: null }],
    };
    response.end(
      `data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
    );
    return;
  }
  if (protocol === "anthropic") {
    const events = [
      {
        type: "message_start",
        message: {
          id: "fixture-response",
          type: "message",
          role: "assistant",
          model,
          content: [],
          stop_reason: null,
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
    return;
  }
  const item = {
    type: "message",
    id: "fixture-message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: "OK", annotations: [] }],
  };
  const events = [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, status: "in_progress", content: [] },
    },
    {
      type: "response.output_text.delta",
      output_index: 0,
      content_index: 0,
      item_id: item.id,
      delta: "OK",
    },
    {
      type: "response.output_text.done",
      output_index: 0,
      content_index: 0,
      item_id: item.id,
      text: "OK",
    },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: "fixture-response",
        status: "completed",
        model,
        output: [item],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ];
  response.end(
    `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`,
  );
}
