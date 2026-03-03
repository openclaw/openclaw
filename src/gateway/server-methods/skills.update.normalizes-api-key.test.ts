import { beforeEach, describe, expect, it, vi } from "vitest";

let writtenConfig: unknown = null;
let currentConfig: unknown = null;

vi.mock("../../config/config.js", () => {
  return {
    loadConfig: () => structuredClone(currentConfig),
    writeConfigFile: async (cfg: unknown) => {
      writtenConfig = cfg;
    },
  };
});

const { skillsHandlers } = await import("./skills.js");

describe("skills.update", () => {
  beforeEach(() => {
    currentConfig = {
      skills: {
        entries: {},
      },
      agents: {
        defaults: {
          skills: [],
        },
      },
    };
  });

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

  it("updates default skill classification", async () => {
    writtenConfig = null;

    let ok: boolean | null = null;
    let error: unknown = null;
    await skillsHandlers["skills.update"]({
      params: {
        skillKey: "playwright",
        skillName: "playwright",
        type: "default",
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
      agents: {
        defaults: {
          skills: ["playwright"],
        },
      },
    });
  });
});
