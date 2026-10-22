import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { REDACTED_SENTINEL } from "../../config/redact-snapshot.js";
import { callGatewayHandler } from "./skills.test-helpers.js";

let writtenConfig: unknown = null;
let loadedConfig: OpenClawConfig = { skills: { entries: {} } };
const secretEntry = {
  apiKey: "secret-api-key-123",
  env: { GEMINI_API_KEY: "secret-env-key-456", BRAVE_REGION: "us" },
};

// mock-isolation: record config mutations without reading or writing operator configuration.
vi.mock("../../config/config.js", () => {
  return {
    loadConfig: () => loadedConfig,
    getRuntimeConfig: () => loadedConfig,
    writeConfigFile: async (cfg: unknown) => {
      writtenConfig = cfg;
    },
    replaceConfigFile: async ({ nextConfig }: { nextConfig: unknown }) => {
      writtenConfig = nextConfig;
    },
    mutateConfigFileWithRetry: async (params: {
      mutate: (
        draft: OpenClawConfig,
        context: { snapshot: { path: string }; previousHash: string; attempt: number },
      ) => unknown;
    }) => {
      const draft = structuredClone(loadedConfig);
      const snapshot = { path: "/tmp/openclaw/config.json" };
      const result = await params.mutate(draft, {
        snapshot,
        previousHash: "test-hash",
        attempt: 0,
      });
      writtenConfig = draft;
      return { result };
    },
  };
});

const { skillsHandlers } = await import("./skills.js");

function update(params: Record<string, unknown>) {
  writtenConfig = null;
  return callGatewayHandler(
    skillsHandlers,
    "skills.update",
    { skillKey: "demo-skill", ...params },
    {
      context: { getRuntimeConfig: () => loadedConfig },
    },
  );
}

function expectWrittenSkillEntry(skillKey: string, entry: unknown) {
  expect(writtenConfig).toEqual({ skills: { entries: { [skillKey]: entry } } });
}

describe("skills.update", () => {
  it("redacts apiKey and secret env values from the response but writes full values to config", async () => {
    loadedConfig = { skills: { entries: {} } };
    const result = await update({
      apiKey: "secret-api-\r\nkey-123",
      env: secretEntry.env,
    });
    expectWrittenSkillEntry("demo-skill", secretEntry);
    expect(result.response).toMatchObject({
      config: {
        apiKey: REDACTED_SENTINEL,
        env: { GEMINI_API_KEY: REDACTED_SENTINEL, BRAVE_REGION: "us" },
      },
    });
  });

  it("keeps existing secrets when clients submit redacted sentinel values", async () => {
    loadedConfig = { skills: { entries: { "demo-skill": secretEntry } } };
    await update({
      apiKey: REDACTED_SENTINEL,
      env: { GEMINI_API_KEY: REDACTED_SENTINEL, BRAVE_REGION: "eu" },
    });

    expectWrittenSkillEntry("demo-skill", {
      ...secretEntry,
      env: { ...secretEntry.env, BRAVE_REGION: "eu" },
    });
  });
});
