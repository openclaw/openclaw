import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

vi.unmock("../plugins/provider-runtime.js");
vi.unmock("../plugins/provider-runtime.runtime.js");
vi.unmock("../plugins/providers.runtime.js");

let resolveTranscriptPolicy: typeof import("./transcript-policy.js").resolveTranscriptPolicy;
const MISTRAL_PLUGIN_CONFIG = {
  plugins: {
    entries: {
      mistral: { enabled: true },
    },
  },
} as OpenClawConfig;

function createProviderRuntimeSmokeContext(): {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  workspaceDir: string;
} {
  const env = { ...process.env };
  delete env.OPENCLAW_BUNDLED_PLUGINS_DIR;
  delete env.OPENCLAW_SKIP_PROVIDERS;
  delete env.OPENCLAW_SKIP_CHANNELS;
  delete env.OPENCLAW_SKIP_CRON;
  delete env.OPENCLAW_TEST_MINIMAL_GATEWAY;
  return {
    config: {},
    env,
    workspaceDir: process.cwd(),
  };
}

beforeEach(async () => {
  vi.resetModules();
  vi.doUnmock("../plugins/provider-runtime.js");
  vi.doUnmock("../plugins/provider-runtime.runtime.js");
  vi.doUnmock("../plugins/providers.runtime.js");
  ({ resolveTranscriptPolicy } = await import("./transcript-policy.js"));
});

describe("resolveTranscriptPolicy e2e smoke", () => {
  it("uses images-only sanitization without tool-call id rewriting for OpenAI models", () => {
    const policy = resolveTranscriptPolicy({
      ...createProviderRuntimeSmokeContext(),
      provider: "openai",
      modelId: "gpt-4o",
      modelApi: "openai",
    });
    expect(policy.sanitizeMode).toBe("images-only");
    expect(policy.sanitizeToolCallIds).toBe(false);
    expect(policy.toolCallIdMode).toBeUndefined();
  });

  it("uses strict9 tool-call sanitization for Mistral-family models", () => {
    const policy = resolveTranscriptPolicy({
      ...createProviderRuntimeSmokeContext(),
      provider: "mistral",
      modelId: "mistral-large-latest",
      config: MISTRAL_PLUGIN_CONFIG,
    });
    expect(policy.sanitizeToolCallIds).toBe(true);
    expect(policy.toolCallIdMode).toBe("strict9");
  });
});
