import { describe, expect, it, vi } from "vitest";

let writtenConfig: unknown = null;

vi.mock("../../config/config.js", () => {
  return {
    loadConfig: () => ({
      skills: {
        entries: {},
      },
    }),
    writeConfigFile: async (cfg: unknown) => {
      writtenConfig = cfg;
    },
  };
});

const { skillsHandlers } = await import("./skills.js");

describe("skills.update", () => {
  it("strips embedded CR/LF from apiKey", async () => {
    writtenConfig = null;

    let ok: boolean | null = null;
    let error: unknown = null;
    await skillsHandlers["skills.update"]({
      params: {
        skillKey: "brave-search",
        apiKey: "abc\r\ndef",
      },
      req: {} as never,
      client: null as never,
      isWebchatConnect: () => false,
      context: {} as never,
      respond: (success, _result, err) => {
        ok = success;
        error = err;
      },
    });

    expect(ok).toBe(true);
    expect(error).toBeUndefined();
    expect(writtenConfig).toMatchObject({
      skills: {
        entries: {
          "brave-search": {
            apiKey: "abcdef",
          },
        },
      },
    });
  });

  it("redacts apiKey and secret env values from the response but writes full values to config", async () => {
    writtenConfig = null;

    let responseResult: unknown = null;
    await skillsHandlers["skills.update"]({
      params: {
        skillKey: "demo-skill",
        apiKey: "secret-api-key-123",
        env: {
          GEMINI_API_KEY: "secret-env-key-456",
          BRAVE_REGION: "us",
        },
      },
      req: {} as never,
      client: null as never,
      isWebchatConnect: () => false,
      context: {} as never,
      respond: (_success, result, _err) => {
        responseResult = result;
      },
    });

    // Full values must be persisted to config
    expect(writtenConfig).toMatchObject({
      skills: {
        entries: {
          "demo-skill": {
            apiKey: "secret-api-key-123",
            env: {
              GEMINI_API_KEY: "secret-env-key-456",
              BRAVE_REGION: "us",
            },
          },
        },
      },
    });

    // Response must not expose plaintext secrets
    const config = (responseResult as { config: Record<string, unknown> }).config;
    expect(config.apiKey).not.toBe("secret-api-key-123");
    const env = config.env as Record<string, string>;
    expect(env.GEMINI_API_KEY).not.toBe("secret-env-key-456");
    // Non-secret env values should still be present
    expect(env.BRAVE_REGION).toBe("us");
  });
});
