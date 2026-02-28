import { describe, expect, it } from "vitest";
import { stripInvalidRuntimeKeys } from "./sanitize-invalid-keys.js";

describe("stripInvalidRuntimeKeys", () => {
  it("returns empty stripped list for valid config", () => {
    const config = {
      channels: {
        discord: {
          accounts: {
            main: { token: "tok", allowFrom: ["123"] },
          },
        },
      },
      agents: { list: [{ id: "main" }] },
    };
    const { stripped } = stripInvalidRuntimeKeys(structuredClone(config));
    expect(stripped).toEqual([]);
  });

  it("strips groupAllowFrom from discord accounts", () => {
    const config = {
      channels: {
        discord: {
          accounts: {
            marketing: { groupAllowFrom: ["123"], token: "tok" },
            sales: { groupAllowFrom: ["456"] },
          },
        },
      },
    };
    const clone = structuredClone(config);
    const { stripped } = stripInvalidRuntimeKeys(clone);
    expect(stripped).toContain("channels.discord.accounts.marketing.groupAllowFrom");
    expect(stripped).toContain("channels.discord.accounts.sales.groupAllowFrom");
    const accounts = (clone.channels.discord as Record<string, unknown>).accounts as Record<
      string,
      Record<string, unknown>
    >;
    expect(accounts.marketing.groupAllowFrom).toBeUndefined();
    expect(accounts.marketing.token).toBe("tok");
    expect(accounts.sales.groupAllowFrom).toBeUndefined();
  });

  it("strips groupAllowFrom from discord top-level config", () => {
    const config = {
      channels: {
        discord: { groupAllowFrom: ["789"] },
      },
    };
    const clone = structuredClone(config);
    const { stripped } = stripInvalidRuntimeKeys(clone);
    expect(stripped).toContain("channels.discord.groupAllowFrom");
    expect((clone.channels.discord as Record<string, unknown>).groupAllowFrom).toBeUndefined();
  });

  it("strips groupAllowFrom from slack accounts", () => {
    const config = {
      channels: {
        slack: {
          accounts: {
            work: { groupAllowFrom: ["U123"] },
          },
        },
      },
    };
    const clone = structuredClone(config);
    const { stripped } = stripInvalidRuntimeKeys(clone);
    expect(stripped).toContain("channels.slack.accounts.work.groupAllowFrom");
  });

  it("does NOT strip groupAllowFrom from telegram accounts", () => {
    const config = {
      channels: {
        telegram: {
          accounts: {
            bot: { groupAllowFrom: ["123"] },
          },
        },
      },
    };
    const clone = structuredClone(config);
    const { stripped } = stripInvalidRuntimeKeys(clone);
    expect(stripped).toEqual([]);
    expect(
      (
        (clone.channels.telegram as Record<string, unknown>).accounts as Record<
          string,
          Record<string, unknown>
        >
      ).bot.groupAllowFrom,
    ).toEqual(["123"]);
  });

  it("strips allowlist from any channel account", () => {
    const config = {
      channels: {
        discord: {
          accounts: { main: { allowlist: ["x"] } },
        },
        telegram: {
          accounts: { bot: { allowlist: ["y"] } },
        },
      },
    };
    const clone = structuredClone(config);
    const { stripped } = stripInvalidRuntimeKeys(clone);
    expect(stripped).toContain("channels.discord.accounts.main.allowlist");
    expect(stripped).toContain("channels.telegram.accounts.bot.allowlist");
  });

  it("strips allowlist from channel top-level config", () => {
    const config = {
      channels: {
        discord: { allowlist: ["x"] },
      },
    };
    const clone = structuredClone(config);
    const { stripped } = stripInvalidRuntimeKeys(clone);
    expect(stripped).toContain("channels.discord.allowlist");
  });

  it("strips routing from agent list entries", () => {
    const config = {
      agents: {
        list: [
          { id: "main", routing: { key: "val" } },
          { id: "helper" },
          { id: "worker", routing: { another: "val" } },
        ],
      },
    };
    const clone = structuredClone(config);
    const { stripped } = stripInvalidRuntimeKeys(clone);
    expect(stripped).toContain("agents.list.0.routing");
    expect(stripped).toContain("agents.list.2.routing");
    expect(stripped).toHaveLength(2);
    const list = clone.agents.list as Array<Record<string, unknown>>;
    expect(list[0].routing).toBeUndefined();
    expect(list[0].id).toBe("main");
    expect(list[1].routing).toBeUndefined();
    expect(list[2].routing).toBeUndefined();
  });

  it("handles missing or empty config gracefully", () => {
    expect(stripInvalidRuntimeKeys(null).stripped).toEqual([]);
    expect(stripInvalidRuntimeKeys(undefined).stripped).toEqual([]);
    expect(stripInvalidRuntimeKeys({}).stripped).toEqual([]);
    expect(stripInvalidRuntimeKeys({ channels: {} }).stripped).toEqual([]);
    expect(stripInvalidRuntimeKeys({ agents: {} }).stripped).toEqual([]);
    expect(stripInvalidRuntimeKeys({ agents: { list: [] } }).stripped).toEqual([]);
  });

  it("handles non-object account entries gracefully", () => {
    const config = {
      channels: {
        discord: {
          accounts: {
            broken: null,
            alsobroken: "string",
          },
        },
      },
    };
    const { stripped } = stripInvalidRuntimeKeys(config);
    expect(stripped).toEqual([]);
  });

  it("handles non-object agent list entries gracefully", () => {
    const config = {
      agents: {
        list: [null, "bad", 42],
      },
    };
    const { stripped } = stripInvalidRuntimeKeys(config);
    expect(stripped).toEqual([]);
  });
});
