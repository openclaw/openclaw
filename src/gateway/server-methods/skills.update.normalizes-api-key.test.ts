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

describe("skills.update", () => {
  it("strips embedded CR/LF from apiKey", async () => {
    writtenConfig = null;
    const { skillsHandlers } = await import("./skills.js");

    let ok: boolean | null = null;
    let error: unknown = null;
    await skillsHandlers["skills.update"]({
      params: {
        skillKey: "brave-search",
        apiKey: "abc\r\ndef",
      },
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
});
