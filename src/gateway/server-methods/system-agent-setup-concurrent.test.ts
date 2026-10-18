import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../../config/io.js";
import type { ModelDefinitionConfig } from "../../config/types.models.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resetCommandQueueStateForTest } from "../../process/command-queue.test-support.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../../state/openclaw-state-db.js";
import type { WizardSession } from "../../wizard/session.js";
import { readSetupConfigFileSnapshot } from "../../wizard/setup.shared.js";
import { createWizardSessionTracker } from "../server-wizard-sessions.js";
import { whenAdmittedWizardSessionSettled } from "./setup-admission.js";
import { startGatewayRequest, wizardResponse } from "./system-agent-chat-fixture.test-support.js";
import { systemAgentHandlers } from "./system-agent.js";
import type { GatewayRequestContext } from "./types.js";
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
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    vi.unstubAllEnvs();
    cleanup();
  });
});
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

const providerConfig = (changes: Partial<typeof connection>): OpenClawConfig["models"] => ({
  providers: { fixture: { ...connection, ...changes } },
});
const editConfig = async (changes: Partial<OpenClawConfig>) =>
  writeConfig({ ...(await readConfig()), ...changes });

async function startPrepare(changes: Partial<OpenClawConfig> = {}) {
  let credentialsSaved = false;
  provider.prepare.mockImplementationOnce(async ({ config, prompter }) => {
    const prepared = { ...structuredClone(config), ...changes };
    prepared.auth = { profiles: { "fixture:default": { provider: "fixture", mode: "api_key" } } };
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
    const { calls, pending } = startGatewayRequest(
      systemAgentHandlers[method] ?? wizardHandlers[method],
      {
        req: { type: "req", id: "request", method, params },
        params,
        context,
        client: null,
        isWebchatConnect: () => false,
      },
    );
    await pending;
    return wizardResponse(calls, true);
  };
  await invoke("openclaw.setup.prepare.start", { sessionId, authChoice: "fixture" });
  sessions.add(expectDefined(tracker.wizardSessions.get(sessionId), "prepared session"));
  const prompt = await invoke("wizard.next", { sessionId });
  expect(prompt.step).toMatchObject({ type: "text", message: "Enter provider key" });
  const stepId = expectDefined(prompt.step, "provider prompt").id;
  return {
    complete: async (status = "done") => {
      const result = await invoke("wizard.next", {
        sessionId,
        answer: { stepId, value: "synthetic-key" },
      });
      expect(result).toMatchObject({ done: true, status });
      expect(credentialsSaved).toBe(true);
      return result;
    },
  };
}

it.each(["invalid JSON", "conflicting provider"] as const)(
  "preserves %s and reports that credentials were saved",
  async (edit) => {
    const conflict = edit === "conflicting provider";
    const setup = await startPrepare(
      conflict
        ? {
            models: providerConfig({ baseUrl: "http://127.0.0.1:11435" }),
          }
        : {},
    );
    const invalid = '{ "messages":';
    if (conflict) {
      await editConfig({ models: providerConfig({ baseUrl: "http://127.0.0.1:11436" }) });
    } else {
      fs.writeFileSync(configPath, invalid);
    }
    const result = await setup.complete("error");
    expect(result.error).toContain("Credentials saved, but provider settings could not be applied");
    if (conflict) {
      expect(result.error).toContain("Review the current settings and retry");
      expect((await readConfig()).models?.providers?.fixture?.baseUrl).toBe(
        "http://127.0.0.1:11436",
      );
    } else {
      expect(fs.readFileSync(configPath, "utf8")).toBe(invalid);
    }
  },
);

it("keeps an unrelated edit made while provider login is pending", async () => {
  const setup = await startPrepare();
  await editConfig({ messages: { ackReaction: "concurrent-edit" } });
  await setup.complete();
  expect(await readConfig()).toMatchObject({
    messages: { ackReaction: "concurrent-edit" },
    auth: { profiles: { "fixture:default": { provider: "fixture", mode: "api_key" } } },
  });
});

it("keeps distinct model rows added by setup and a concurrent editor", async () => {
  const setup = await startPrepare({
    models: providerConfig({ models: [...connection.models, model("prepared")] }),
  });
  await editConfig({
    models: providerConfig({ models: [...connection.models, model("concurrent")] }),
  });
  await setup.complete();
  expect((await readConfig()).models?.providers?.fixture?.models).toEqual(
    ["existing", "concurrent", "prepared"].map(model),
  );
});
