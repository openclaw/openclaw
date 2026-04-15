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

  it("masks apiKey in the response to prevent leaking secrets", async () => {
    writtenConfig = null;

    let result: Record<string, unknown> | null = null;
    await skillsHandlers["skills.update"]({
      params: {
        skillKey: "brave-search",
        apiKey: "sk-1234567890abcdef",
      },
      req: {} as never,
      client: null as never,
      isWebchatConnect: () => false,
      context: {} as never,
      respond: (_success, res) => {
        result = res as Record<string, unknown>;
      },
    });

    const config = result?.config as Record<string, unknown>;
    // The response should NOT contain the full API key
    expect(config.apiKey).not.toBe("sk-1234567890abcdef");
    // It should be masked (first 4 + … + last 4)
    expect(config.apiKey).toBe("sk-1…cdef");

    // But the written config should still have the full key
    expect(writtenConfig).toMatchObject({
      skills: {
        entries: {
          "brave-search": {
            apiKey: "sk-1234567890abcdef",
          },
        },
      },
    });
  });
});
