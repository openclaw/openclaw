import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { Compile } from "typebox/compile";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  WizardNextResultSchema,
  WizardStartResultSchema,
} from "../../../packages/gateway-protocol/src/schema/wizard.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../../config/io.js";
import type { ModelDefinitionConfig } from "../../config/types.models.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resetCommandQueueStateForTest } from "../../process/command-queue.test-support.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import type { WizardSession } from "../../wizard/session.js";
import { readSetupConfigFileSnapshot } from "../../wizard/setup.shared.js";
import { createWizardSessionTracker } from "../server-wizard-sessions.js";
import { whenAdmittedWizardSessionSettled } from "./setup-admission.js";
import { systemAgentHandlers } from "./system-agent.js";
import type { GatewayRequestContext, RespondFn } from "./types.js";
import { wizardHandlers } from "./wizard.js";

const provider = vi.hoisted(() => ({
  prepare:
    vi.fn<
      typeof import("../../plugins/provider-auth-choice.js").prepareAuthChoiceLoadedPluginProvider
    >(),
}));
vi.mock("../../plugins/provider-auth-choice.js", () => ({
  prepareAuthChoiceLoadedPluginProvider: provider.prepare,
}));

const sessions = new Set<WizardSession>();
const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(async () => {
    for (const session of sessions) {
      session.cancel();
      await whenAdmittedWizardSessionSettled(session);
    }
    sessions.clear();
    vi.resetAllMocks();
    resetCommandQueueStateForTest();
    clearConfigCache();
    clearRuntimeConfigSnapshot();
    closeOpenClawStateDatabaseForTest();
    vi.unstubAllEnvs();
    cleanup();
  });
});
const validateResult = Compile(WizardNextResultSchema);
const validateStart = Compile(WizardStartResultSchema);
const model = (id: string): ModelDefinitionConfig => ({
  id,
  name: id,
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  maxTokens: 1024,
});
const connection = { baseUrl: "http://127.0.0.1:11434", models: [model("existing")] };
let configPath: string;
const writeConfig = (config: OpenClawConfig) =>
  fs.writeFileSync(configPath, JSON.stringify(config));
const readConfig = async () => (await readSetupConfigFileSnapshot()).sourceConfig;

beforeEach(() => {
  const root = tempDirs.make("openclaw-setup-concurrent-");
  configPath = path.join(root, "openclaw.json");
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
  vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "1");
  writeConfig({
    plugins: { allow: [] },
    messages: { ackReaction: "before" },
    models: { providers: { fixture: connection } },
  });
});

async function startPrepare(change: (config: OpenClawConfig) => void = () => {}) {
  let credentialsSaved = false;
  provider.prepare.mockImplementationOnce(async ({ config, prompter }) => {
    const prepared = structuredClone(config);
    prepared.auth = { profiles: { "fixture:default": { provider: "fixture", mode: "api_key" } } };
    change(prepared);
    await prompter.text({ message: "Enter provider key", sensitive: true });
    return {
      config: prepared,
      authProfiles: [
        {
          profileId: "fixture:default",
          credential: { type: "api_key", provider: "fixture", key: "synthetic-key" },
        },
      ],
      persistAuthProfiles: async () => {
        credentialsSaved = true;
      },
    };
  });
  const tracker = createWizardSessionTracker();
  const context = tracker as GatewayRequestContext;
  const sessionId = "prepare-concurrent";
  const invoke = async (method: string, params: Record<string, unknown>) => {
    const respond = vi.fn<RespondFn>();
    await expectDefined(
      systemAgentHandlers[method] ?? wizardHandlers[method],
      method,
    )({
      req: { type: "req", id: "request", method, params },
      params,
      respond,
      context,
      client: null,
      isWebchatConnect: () => false,
    });
    expect(respond).toHaveBeenCalledOnce();
    const [ok, payload] = expectDefined(respond.mock.calls[0], "Gateway response");
    expect(ok).toBe(true);
    if (!validateResult.Check(payload) && !validateStart.Check(payload)) {
      throw new Error("Invalid wizard response");
    }
    return payload;
  };
  await invoke("openclaw.setup.prepare.start", { sessionId, authChoice: "fixture" });
  sessions.add(expectDefined(tracker.wizardSessions.get(sessionId), "prepared session"));
  const prompt = await invoke("wizard.next", { sessionId });
  expect(prompt.step).toMatchObject({ type: "text", message: "Enter provider key" });
  const stepId = expectDefined(prompt.step, "provider prompt").id;
  return {
    credentialsSaved: () => credentialsSaved,
    complete: () =>
      invoke("wizard.next", { sessionId, answer: { stepId, value: "synthetic-key" } }),
  };
}

describe("setup prepare concurrent config writes", () => {
  it("preserves invalid concurrent edits and reports that credentials were saved", async () => {
    const setup = await startPrepare();
    const edited = '{ "messages":';
    fs.writeFileSync(configPath, edited);

    const result = await setup.complete();
    expect(setup.credentialsSaved()).toBe(true);
    expect(result).toMatchObject({ done: true, status: "error" });
    expect(result.error).toContain("Credentials saved, but provider settings could not be applied");
    expect(fs.readFileSync(configPath, "utf8")).toBe(edited);
  });

  it("keeps an unrelated edit made while provider login is pending", async () => {
    const setup = await startPrepare();
    const concurrent = await readConfig();
    concurrent.messages = { ackReaction: "concurrent-edit" };
    writeConfig(concurrent);

    expect(await setup.complete()).toMatchObject({ done: true, status: "done" });
    expect(setup.credentialsSaved()).toBe(true);
    expect(await readConfig()).toMatchObject({
      messages: { ackReaction: "concurrent-edit" },
      auth: { profiles: { "fixture:default": { provider: "fixture", mode: "api_key" } } },
    });
  });

  it("keeps distinct model rows added by setup and a concurrent editor", async () => {
    const setup = await startPrepare((config) => {
      config.models = {
        providers: {
          fixture: { ...connection, models: [...connection.models, model("prepared")] },
        },
      };
    });
    const concurrent = await readConfig();
    concurrent.models = {
      providers: {
        fixture: { ...connection, models: [...connection.models, model("concurrent")] },
      },
    };
    writeConfig(concurrent);

    expect(await setup.complete()).toMatchObject({ done: true, status: "done" });
    expect((await readConfig()).models?.providers?.fixture?.models).toEqual([
      model("existing"),
      model("concurrent"),
      model("prepared"),
    ]);
  });

  it("reports saved credentials when the same provider setting changed during login", async () => {
    const setup = await startPrepare((config) => {
      config.models = {
        providers: { fixture: { ...connection, baseUrl: "http://127.0.0.1:11435" } },
      };
    });
    const concurrent = await readConfig();
    concurrent.models = {
      providers: { fixture: { ...connection, baseUrl: "http://127.0.0.1:11436" } },
    };
    writeConfig(concurrent);

    const result = await setup.complete();
    expect(setup.credentialsSaved()).toBe(true);
    expect(result).toMatchObject({ done: true, status: "error" });
    expect(result.error).toContain("Credentials saved, but provider settings could not be applied");
    expect(result.error).toContain("Review the current settings and retry");
    expect((await readConfig()).models?.providers?.fixture?.baseUrl).toBe("http://127.0.0.1:11436");
  });
});
