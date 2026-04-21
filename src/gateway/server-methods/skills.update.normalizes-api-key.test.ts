import { describe, expect, it, vi } from "vitest";

let writtenConfig: unknown = null;
let mutateBase: unknown = null;

vi.mock("../../config/config.js", () => {
  return {
    loadConfig: () => ({
      tools: {
        web: {
          search: {
            enabled: true,
            apiKey: "runtime-only-legacy-key",
          },
        },
      },
      skills: {
        entries: {},
      },
    }),
    mutateConfigFile: async ({
      base,
      mutate,
    }: {
      base?: string;
      mutate: (draft: Record<string, unknown>) => unknown;
    }) => {
      mutateBase = base;
      const draft = {
        tools: {
          web: {
            search: {
              enabled: true,
            },
          },
        },
        skills: {
          entries: {},
        },
      };
      const result = await mutate(draft);
      writtenConfig = draft;
      return { result };
    },
  };
});

const { skillsHandlers } = await import("./skills.js");

describe("skills.update", () => {
  it("writes skill api keys from the source config snapshot", async () => {
    writtenConfig = null;
    mutateBase = null;

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
    expect(mutateBase).toBe("source");
    expect(writtenConfig).toMatchObject({
      tools: {
        web: {
          search: {
            enabled: true,
          },
        },
      },
      skills: {
        entries: {
          "brave-search": {
            apiKey: "abcdef",
          },
        },
      },
    });
    expect(writtenConfig).not.toMatchObject({
      tools: {
        web: {
          search: {
            apiKey: expect.any(String),
          },
        },
      },
    });
  });

  it("disables a skill without persisting runtime-only legacy web search config", async () => {
    writtenConfig = null;
    mutateBase = null;

    let ok: boolean | null = null;
    let error: unknown = null;
    await skillsHandlers["skills.update"]({
      params: {
        skillKey: "browserless",
        enabled: false,
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
    expect(mutateBase).toBe("source");
    expect(writtenConfig).toMatchObject({
      tools: {
        web: {
          search: {
            enabled: true,
          },
        },
      },
      skills: {
        entries: {
          browserless: {
            enabled: false,
          },
        },
      },
    });
    expect(writtenConfig).not.toMatchObject({
      tools: {
        web: {
          search: {
            apiKey: expect.any(String),
          },
        },
      },
    });
  });
});
