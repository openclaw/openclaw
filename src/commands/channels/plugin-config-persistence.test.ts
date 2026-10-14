import fs from "node:fs/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { coerceSecretRef } from "../../config/types.secrets.js";
import { readSecretStoreValue } from "../../secrets/store/secret-store.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { createRuntimeEnv } from "../../test-utils/plugin-runtime-env.js";
import { persistChannelPluginConfig } from "./plugin-config-persistence.js";

let state: OpenClawTestState;
beforeEach(async () => {
  state = await createOpenClawTestState({ prefix: "channel-setup-secrets-", applyEnv: true });
});
afterEach(async () => {
  await state.cleanup();
});

it("saves new channel credentials as resolvable protected refs without migrating other settings", async () => {
  const previousConfig: OpenClawConfig = {
    secrets: { providers: { protected: { source: "store" } } },
    channels: { discord: { token: "existing-discord-token" } },
  };
  await state.writeConfig(previousConfig);
  const cfg: OpenClawConfig = {
    ...previousConfig,
    channels: {
      ...previousConfig.channels,
      telegram: { botToken: "new-telegram-token" },
      slack: { botToken: { source: "env", provider: "default", id: "SLACK_BOT_TOKEN" } },
    },
  };
  await persistChannelPluginConfig({
    cfg,
    pluginInstalled: false,
    runtime: createRuntimeEnv(),
    setup: { previousConfig },
  });

  const raw = await fs.readFile(state.configPath, "utf8");
  const saved: OpenClawConfig = JSON.parse(raw);
  const ref = coerceSecretRef(saved.channels?.telegram?.botToken);
  expect(ref).toEqual({ source: "store", provider: "protected", id: expect.any(String) });
  expect(raw).not.toContain("new-telegram-token");
  expect(saved.channels?.discord).toEqual(previousConfig.channels?.discord);
  expect(saved.channels?.slack).toEqual(cfg.channels?.slack);
  expect(cfg.channels?.telegram?.botToken).toBe("new-telegram-token");
  expect(await readSecretStoreValue({ scope: { kind: "team" }, name: ref!.id })).toEqual({
    ok: true,
    value: "new-telegram-token",
  });
});

it("does not publish credentials after setup authority is revoked", async () => {
  await state.writeConfig({});
  const assertCurrent = vi.fn(() => {
    throw new Error("setup cancelled");
  });
  await expect(
    persistChannelPluginConfig({
      cfg: { channels: { telegram: { botToken: "cancelled-token" } } },
      pluginInstalled: false,
      runtime: createRuntimeEnv(),
      setup: { previousConfig: {}, assertCurrent },
    }),
  ).rejects.toThrow("setup cancelled");
  expect(await fs.readFile(state.configPath, "utf8")).not.toContain("cancelled-token");
});
