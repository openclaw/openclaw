import { expect, it, vi, type Mock } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { validateConfigObject } from "../../config/validation-core.js";
import type { ProviderAuthResult } from "../../plugins/types.js";
import type { runModelsAuthLoginFlowCore } from "./auth.js";

type LoginOptions = Partial<Parameters<typeof runModelsAuthLoginFlowCore>[0]>;

/** Harness-owned sign-ins that stage a per-agent runtime policy instead of a credential profile. */
export function registerModelsAuthRuntimeStagingTests(fixture: {
  loginFlow: (options: LoginOptions) => ReturnType<typeof runModelsAuthLoginFlowCore>;
  setProviderAuthResult: (result: ProviderAuthResult) => void;
  getConfig: () => OpenClawConfig;
  setConfig: (config: OpenClawConfig) => void;
  repairModelSelectionRuntimePlugins: Mock;
}) {
  const { loginFlow } = fixture;
  it("stages the declared agent runtime for credential-only harness sign-ins", async () => {
    fixture.setProviderAuthResult({
      profiles: [],
      defaultModel: "openai/gpt-5.5",
      agentRuntimeId: "codex",
      configPatch: {
        plugins: { entries: { codex: { enabled: true }, other: { enabled: true } } },
      },
    });
    await loginFlow({ credentialOnly: true });
    expect(
      fixture.getConfig().agents?.entries?.main?.models?.["openai/gpt-5.5"]?.agentRuntime,
    ).toEqual({
      id: "codex",
    });
    expect(fixture.getConfig().plugins?.entries?.codex?.enabled).toBe(true);
    // Harness-owned logins only keep their own plugin/runtime enablement entries.
    expect(fixture.getConfig().plugins?.entries?.other).toBeUndefined();
  });

  it("stages the declared agent runtime on the non-credential-only (CLI) path too", async () => {
    fixture.setProviderAuthResult({
      profiles: [],
      defaultModel: "openai/gpt-5.5",
      agentRuntimeId: "codex",
    });
    await loginFlow({});
    expect(
      fixture.getConfig().agents?.entries?.main?.models?.["openai/gpt-5.5"]?.agentRuntime,
    ).toEqual({
      id: "codex",
    });
  });

  it("does not let a login stage a runtime policy for another provider's model", async () => {
    fixture.setProviderAuthResult({
      profiles: [],
      defaultModel: "meta/muse-spark-1.3",
      agentRuntimeId: "muse",
    });
    const result = await loginFlow({ credentialOnly: true });
    expect(
      fixture.getConfig().agents?.entries?.main?.models?.["meta/muse-spark-1.3"],
    ).toBeUndefined();
    expect(result.stagedRuntimePolicy).toBeUndefined();
  });

  it("stages the runtime policy under the authored agent key", async () => {
    fixture.setConfig({ agents: { entries: { Main: {} } } });
    fixture.setProviderAuthResult({
      profiles: [],
      defaultModel: "openai/gpt-5.5",
      agentRuntimeId: "codex",
    });
    await loginFlow({ credentialOnly: true });
    expect(
      fixture.getConfig().agents?.entries?.Main?.models?.["openai/gpt-5.5"]?.agentRuntime,
    ).toEqual({
      id: "codex",
    });
    expect(fixture.getConfig().agents?.entries?.main).toBeUndefined();
  });

  it("does not stage a runtime policy for credential-only logins on the default runtime", async () => {
    fixture.setProviderAuthResult({
      profiles: [],
      defaultModel: "openai/gpt-5.5",
      agentRuntimeId: "openclaw",
    });
    await loginFlow({ credentialOnly: true });
    expect(fixture.getConfig().agents?.entries?.main?.models?.["openai/gpt-5.5"]).toBeUndefined();
  });

  it("reports the persisted runtime staging to chat for credential-only harness sign-ins", async () => {
    fixture.setProviderAuthResult({
      profiles: [],
      defaultModel: "openai/gpt-5.5",
      agentRuntimeId: "codex",
    });
    const result = await loginFlow({ credentialOnly: true });
    expect(result.stagedRuntimePolicy).toBe(true);
    expect(result.profiles).toEqual([]);
  });

  it("keeps an existing stored config intact and valid when a chat harness sign-in stages its runtime", async () => {
    // Shape persisted by earlier releases: authored agent entry with its own model
    // settings, an unrelated enabled plugin, and an existing default model.
    const stored: OpenClawConfig = {
      agents: {
        defaults: { model: { primary: "other/current" } },
        entries: {
          main: {
            workspace: "/tmp/openclaw/workspace",
            models: {
              "other/current": { alias: "current" },
              "openai/gpt-5.5": { alias: "gpt", params: { temperature: 0.2 } },
            },
          },
        },
      },
      plugins: { entries: { other: { enabled: true } } },
    };
    expect(validateConfigObject(stored).ok).toBe(true);
    fixture.setConfig(structuredClone(stored));
    fixture.setProviderAuthResult({
      profiles: [],
      defaultModel: "openai/gpt-5.5",
      agentRuntimeId: "codex",
      configPatch: { plugins: { entries: { codex: { enabled: true } } } },
    });
    await loginFlow({ credentialOnly: true });
    expect(fixture.getConfig().agents?.defaults?.model).toEqual({ primary: "other/current" });
    expect(fixture.getConfig().agents?.entries?.main?.workspace).toBe("/tmp/openclaw/workspace");
    expect(fixture.getConfig().agents?.entries?.main?.models).toEqual({
      "other/current": { alias: "current" },
      "openai/gpt-5.5": {
        alias: "gpt",
        params: { temperature: 0.2 },
        agentRuntime: { id: "codex" },
      },
    });
    expect(fixture.getConfig().plugins?.entries?.other).toEqual({ enabled: true });
    expect(fixture.getConfig().plugins?.entries?.codex?.enabled).toBe(true);
    expect(validateConfigObject(fixture.getConfig()).ok).toBe(true);
  });

  it("rechecks login authority before runtime-plugin repair effects", async () => {
    const authority = new AbortController();
    let repairEffect = false;
    fixture.repairModelSelectionRuntimePlugins.mockImplementationOnce(
      async (params: { beforePersistentEffect?: () => void | Promise<void> }) => {
        // Owner access is revoked while repair awaits its lease or package work.
        authority.abort(new Error("Login authority ended."));
        await params.beforePersistentEffect?.();
        repairEffect = true;
        return [];
      },
    );
    fixture.setProviderAuthResult({
      profiles: [],
      defaultModel: "openai/gpt-5.5",
      agentRuntimeId: "codex",
    });
    await expect(
      loginFlow({
        credentialOnly: true,
        assertCurrent: () => authority.signal.throwIfAborted(),
      }),
    ).rejects.toThrow("Login authority ended.");
    expect(repairEffect).toBe(false);
    expect(fixture.repairModelSelectionRuntimePlugins).toHaveBeenCalledWith(
      expect.objectContaining({ model: "openai/gpt-5.5", agentId: "main" }),
    );
  });

  it("runs model-access consent after a profileless harness sign-in stages its runtime", async () => {
    const onModelAccessRequested = vi.fn();
    fixture.setProviderAuthResult({
      profiles: [],
      defaultModel: "openai/gpt-5.5",
      agentRuntimeId: "codex",
    });
    fixture.setConfig({
      agents: { defaults: { modelPolicy: { allow: ["other/current"] } } },
    });
    await loginFlow({ credentialOnly: true, onModelAccessRequested });
    expect(onModelAccessRequested).toHaveBeenCalled();
  });
}
