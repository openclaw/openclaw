import { expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { baseUrlTextInput, defineTokenCredential } from "./setup-credential.js";

type DemoConfig = { token?: unknown; tokenFile?: string; baseUrl?: string };

const context = (config: DemoConfig) => ({
  cfg: { channels: { demo: config } } as OpenClawConfig,
  accountId: "default",
  credentialValues: {},
});
function resolveDemoAccount({ cfg }: { cfg: OpenClawConfig }) {
  const config = (cfg.channels?.demo ?? {}) as DemoConfig;
  return { config, token: typeof config.token === "string" ? config.token : undefined };
}

function patchDemoConfig(params: {
  cfg: OpenClawConfig;
  patch: Record<string, unknown>;
  clearFields?: string[];
}): OpenClawConfig {
  const { cfg, patch, clearFields = [] } = params;
  const current = { ...((cfg.channels?.demo ?? {}) as Record<string, unknown>) };
  clearFields.forEach((field) => delete current[field]);
  return context({ ...current, ...patch }).cfg;
}

const definition = defineTokenCredential({
  inputKey: "token",
  configKey: "token",
  configuredFields: ["token", "tokenFile"],
  providerHint: "demo",
  credentialLabel: "token",
  envPrompt: "env",
  keepPrompt: "keep",
  inputPrompt: "input",
  resolveAccount: resolveDemoAccount,
  resolvedValue: (account) => account.token,
  envValue: () => "env-token",
  patchAccount: patchDemoConfig,
  useEnv: { clearFields: ["token", "tokenFile"] },
  set: { clearFields: ["tokenFile"], value: "resolved" },
});

it("defineTokenCredential inspects configured fields and resolved/env values", () => {
  expect(definition.inspect(context({ tokenFile: "/tmp/token" }))).toEqual({
    accountConfigured: true,
    hasConfiguredValue: true,
    resolvedValue: undefined,
    envValue: "env-token",
  });
});

it("clears sibling fields for env and set writes", async () => {
  const ctx = context({ token: "old", tokenFile: "/tmp/token", baseUrl: "https://demo" });
  const env = await definition.applyUseEnv?.(ctx);
  const set = await definition.applySet?.({ ...ctx, value: "raw", resolvedValue: "redacted" });
  expect([env?.channels?.demo, set?.channels?.demo]).toEqual([
    { baseUrl: "https://demo" },
    { token: "redacted", baseUrl: "https://demo" },
  ]);
});

it("baseUrlTextInput wires current, normalize, validate, and patch behavior", async () => {
  const input = baseUrlTextInput({
    inputKey: "httpUrl",
    configKey: "baseUrl",
    message: "URL",
    resolveAccount: resolveDemoAccount,
    currentValue: (account) => account.config.baseUrl,
    includeInitialValue: true,
    validate: (value) => (value.startsWith("https://") ? undefined : "https required"),
    normalize: (value) => value.trim().replace(/\/$/, ""),
    patchAccount: patchDemoConfig,
  });
  const ctx = context({ baseUrl: "https://old" });
  expect(await input.currentValue?.(ctx)).toBe("https://old");
  expect(input.validate?.({ ...ctx, value: "http://bad" })).toBe("https required");
  expect(input.normalizeValue?.({ ...ctx, value: " https://new/ " })).toBe("https://new");
  expect(await input.applySet?.({ ...ctx, value: "https://new" })).toEqual(
    context({ baseUrl: "https://new" }).cfg,
  );
});
