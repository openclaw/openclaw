import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshotRefreshHandler } from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createTestModelDefinition } from "../test-runtime-config-helpers.js";
import { allowLoginProviderModels } from "./auth-model-policy.js";
import { updateConfig } from "./shared.js";

describe("provider model access after sign-in", () => {
  let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
  let config: OpenClawConfig;
  const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
  const readSaved = async (): Promise<OpenClawConfig> =>
    JSON.parse(await fs.readFile(state.configPath, "utf8"));
  const readBytes = () => fs.readFile(state.configPath, "utf8");
  const allow = (assertCurrent?: () => void) =>
    allowLoginProviderModels({ config, runtime, assertCurrent }, "main", "sample");

  beforeEach(async () => {
    state = await createOpenClawTestState({ label: "model-access" });
    config = {
      agents: {
        defaults: { model: "other/current", modelPolicy: { allow: ["other/current"] } },
        entries: { main: { workspace: state.workspaceDir } },
      },
    };
    await state.writeConfig(config);
    vi.clearAllMocks();
  });
  afterEach(async () => {
    setRuntimeConfigSnapshotRefreshHandler(null);
    await state.cleanup();
  });

  it("widens only the allowlist that governs the agent", async () => {
    config.agents!.entries!.main!.modelPolicy = { allow: ["other/private"] };
    await state.writeConfig(config);
    const access = await allow();
    expect(access).toEqual({
      applied: false,
      message: expect.stringContaining("Added sample/* to allowed models."),
    });
    expect((await readSaved()).agents).toMatchObject({
      defaults: { modelPolicy: { allow: ["other/current"] } },
      entries: { main: { modelPolicy: { allow: ["other/private", "sample/*"] } } },
    });
  });

  it("leaves config untouched without an allowlist or when the provider is already allowed", async () => {
    delete config.agents!.defaults!.modelPolicy;
    await state.writeConfig(config);
    const before = await readBytes();
    await expect(allow()).resolves.toBeUndefined();
    config.agents!.defaults!.modelPolicy = { allow: ["sample/*"] };
    await expect(allow()).resolves.toBeUndefined();
    expect(await readBytes()).toBe(before);
  });

  it.each([
    ["exact models", ["other/current", "sample/one", "sample/two"]],
    ["a narrower wildcard", ["other/current", "sample/family/*"]],
  ])("keeps an allowlist that already names %s of the provider", async (_name, allowed) => {
    config.agents!.defaults!.modelPolicy = { allow: allowed };
    await state.writeConfig(config);
    const before = await readBytes();
    await expect(allow()).resolves.toBeUndefined();
    expect(await readBytes()).toBe(before);
  });

  it("keeps every model of a deferred legacy allowlist", async () => {
    delete config.agents!.defaults!.modelPolicy;
    config.agents!.defaults!.models = { "existing-model": {} };
    await state.writeConfig(config);
    await allow();
    await updateConfig((current) => ({ ...current, logging: { level: "debug" } }));
    const saved = await readSaved();
    expect(saved.agents?.defaults?.models).toEqual({ "existing-model": {}, "sample/*": {} });
    expect(saved.agents?.defaults?.modelPolicy).toBeUndefined();
  });

  it("infers a bare legacy ref's provider like the policy owner", async () => {
    delete config.agents!.defaults!.modelPolicy;
    config.agents!.defaults!.models = { tiny: {} };
    config.models = {
      providers: {
        sample: {
          baseUrl: "https://sample.invalid/v1",
          models: [createTestModelDefinition("tiny", { name: "Tiny" })],
        },
      },
    };
    await state.writeConfig(config);
    const before = await readBytes();
    await expect(allow()).resolves.toBeUndefined();
    expect(await readBytes()).toBe(before);
  });

  it("does not treat a migrated model map as an allowlist", async () => {
    delete config.agents!.defaults!.modelPolicy;
    config.agents!.defaults!.models = { "other/current": {} };
    config.meta = { migrations: { modelPolicyAllowlist: true } };
    await state.writeConfig(config);
    await expect(allow()).resolves.toBeUndefined();
  });

  it("rechecks sign-in authority after the writer's asynchronous preflight", async () => {
    const before = await readBytes();
    const assertCurrent = vi.fn();
    setRuntimeConfigSnapshotRefreshHandler({
      preflight: async () => {
        assertCurrent.mockImplementation(() => {
          throw new Error("Login replaced");
        });
      },
      refresh: () => true,
    });
    await expect(allow(assertCurrent)).rejects.toThrow("Login replaced");
    expect(await readBytes()).toBe(before);
  });
});
