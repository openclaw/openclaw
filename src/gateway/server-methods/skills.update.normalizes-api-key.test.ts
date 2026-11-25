import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { REDACTED_SENTINEL } from "../../config/redact-snapshot.js";
import { callGatewayHandler } from "./skills.test-helpers.js";

let writtenConfig: unknown = null;
let loadedConfig: OpenClawConfig = { skills: { entries: {} } };
let authoredConfig: OpenClawConfig | undefined;
const secretEntry = {
  apiKey: "secret-api-key-123",
  env: { GEMINI_API_KEY: "secret-env-key-456", BRAVE_REGION: "us" },
};
const envRef = { source: "env", provider: "default", id: "DEMO_KEY" } as const;

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
        context: { snapshot: object; previousHash: string; attempt: number },
      ) => unknown;
    }) => {
      const draft = structuredClone(loadedConfig);
      const snapshot = {
        path: "/tmp/openclaw/config.json",
        sourceConfig: loadedConfig,
        authoredConfig,
      };
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

  it.each([
    { stored: envRef, apiKey: "plain-key", written: null },
    { stored: "env-value", authored: "${DEMO_KEY}", apiKey: "plain-key", written: null },
    { stored: envRef, apiKey: "${OTHER_KEY}", written: { apiKey: "${OTHER_KEY}" } },
    { stored: envRef, apiKey: "", written: {} },
    { stored: "old-key", apiKey: "plain-key", written: { apiKey: "plain-key" } },
  ])("only replaces a referenced apiKey with another reference: $apiKey", async (c) => {
    loadedConfig = { skills: { entries: { "demo-skill": { apiKey: c.stored } } } };
    authoredConfig = c.authored
      ? { skills: { entries: { "demo-skill": { apiKey: c.authored } } } }
      : undefined;
    const result = await update({ apiKey: c.apiKey });
    if (c.written) {
      expectWrittenSkillEntry("demo-skill", c.written);
      return;
    }
    expect(writtenConfig).toBeNull();
    expect(result.error).toMatchObject({
      code: "INVALID_REQUEST",
      message: expect.stringContaining("skills.entries.demo-skill.apiKey is set by a SecretRef"),
    });
  });
});
