import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { withTempHome } from "../../test/helpers/temp-home.js";
import { loadAndMaybeMigrateDoctorConfig } from "./doctor-config-flow.js";
import { runDoctorConfigWithInput } from "./doctor-config-flow.test-utils.js";

function expectGoogleChatDmAllowFromRepaired(cfg: unknown) {
  const typed = cfg as {
    channels: {
      googlechat: {
        dm: { allowFrom: string[] };
        allowFrom?: string[];
      };
    };
  };
  expect(typed.channels.googlechat.dm.allowFrom).toEqual(["*"]);
  expect(typed.channels.googlechat.allowFrom).toBeUndefined();
}

type DiscordGuildRule = {
  users: string[];
  roles: string[];
  channels: Record<string, { users: string[]; roles: string[] }>;
};

type DiscordAccountRule = {
  allowFrom: string[];
  dm: { allowFrom: string[]; groupChannels: string[] };
  execApprovals: { approvers: string[] };
  guilds: Record<string, DiscordGuildRule>;
};

type RepairedDiscordPolicy = {
  allowFrom: string[];
  dm: { allowFrom: string[]; groupChannels: string[] };
  execApprovals: { approvers: string[] };
  guilds: Record<string, DiscordGuildRule>;
  accounts: Record<string, DiscordAccountRule>;
};

describe("doctor config flow", () => {
  it("preserves invalid config for doctor repairs", async () => {
    const result = await runDoctorConfigWithInput({
      config: {
        gateway: { auth: { mode: "token", token: 123 } },
        agents: { list: [{ id: "pi" }] },
      },
      run: loadAndMaybeMigrateDoctorConfig,
    });

    expect((result.cfg as Record<string, unknown>).gateway).toEqual({
      auth: { mode: "token", token: 123 },
    });
  });

  it("drops unknown keys on repair", async () => {
    const result = await runDoctorConfigWithInput({
      repair: true,
      config: {
        bridge: { bind: "auto" },
        gateway: { auth: { mode: "token", token: "ok", extra: true } },
        agents: { list: [{ id: "pi" }] },
      },
      run: loadAndMaybeMigrateDoctorConfig,
    });

    const cfg = result.cfg as Record<string, unknown>;
    expect(cfg.bridge).toBeUndefined();
    expect((cfg.gateway as Record<string, unknown>)?.auth).toEqual({
      mode: "token",
      token: "ok",
    });
  });

  it("preserves discord streaming intent while stripping unsupported keys on repair", async () => {
    const result = await runDoctorConfigWithInput({
      repair: true,
      config: {
        channels: {
          discord: {
            streaming: true,
            lifecycle: {
              enabled: true,
              reactions: {
                queued: "⏳",
                thinking: "🧠",
                tool: "🔧",
                done: "✅",
                error: "❌",
              },
            },
          },
        },
      },
      run: loadAndMaybeMigrateDoctorConfig,
    });

    const cfg = result.cfg as {
      channels: {
        discord: {
          streamMode?: string;
          streaming?: string;
          lifecycle?: unknown;
        };
      };
    };
    expect(cfg.channels.discord.streaming).toBe("partial");
    expect(cfg.channels.discord.streamMode).toBeUndefined();
    expect(cfg.channels.discord.lifecycle).toBeUndefined();
  });

  it("resolves Telegram @username allowFrom entries to numeric IDs on repair", async () => {
    const fetchSpy = vi.fn(async (url: string) => {
      const u = String(url);
      const chatId = new URL(u).searchParams.get("chat_id") ?? "";
      const id =
        chatId.toLowerCase() === "@testuser"
          ? 111
          : chatId.toLowerCase() === "@groupuser"
            ? 222
            : chatId.toLowerCase() === "@topicuser"
              ? 333
              : chatId.toLowerCase() === "@accountuser"
                ? 444
                : null;
      return {
        ok: id != null,
        json: async () => (id != null ? { ok: true, result: { id } } : { ok: false }),
      } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const result = await runDoctorConfigWithInput({
        repair: true,
        config: {
          channels: {
            telegram: {
              botToken: "123:abc",
              allowFrom: ["@testuser"],
              groupAllowFrom: ["groupUser"],
              groups: {
                "-100123": {
                  allowFrom: ["tg:@topicUser"],
                  topics: { "99": { allowFrom: ["@accountUser"] } },
                },
              },
              accounts: {
                alerts: { botToken: "456:def", allowFrom: ["@accountUser"] },
              },
            },
          },
        },
        run: loadAndMaybeMigrateDoctorConfig,
      });

      const cfg = result.cfg as unknown as {
        channels: {
          telegram: {
            allowFrom: string[];
            groupAllowFrom: string[];
            groups: Record<
              string,
              { allowFrom: string[]; topics: Record<string, { allowFrom: string[] }> }
            >;
            accounts: Record<string, { allowFrom: string[] }>;
          };
        };
      };
      expect(cfg.channels.telegram.allowFrom).toEqual(["111"]);
      expect(cfg.channels.telegram.groupAllowFrom).toEqual(["222"]);
      expect(cfg.channels.telegram.groups["-100123"].allowFrom).toEqual(["333"]);
      expect(cfg.channels.telegram.groups["-100123"].topics["99"].allowFrom).toEqual(["444"]);
      expect(cfg.channels.telegram.accounts.alerts.allowFrom).toEqual(["444"]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("converts numeric discord ids to strings on repair", async () => {
    await withTempHome(async (home) => {
      const configDir = path.join(home, ".openclaw");
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        path.join(configDir, "openclaw.json"),
        JSON.stringify(
          {
            channels: {
              discord: {
                allowFrom: [123],
                dm: { allowFrom: [456], groupChannels: [789] },
                execApprovals: { approvers: [321] },
                guilds: {
                  "100": {
                    users: [111],
                    roles: [222],
                    channels: {
                      general: { users: [333], roles: [444] },
                    },
                  },
                },
                accounts: {
                  work: {
                    allowFrom: [555],
                    dm: { allowFrom: [666], groupChannels: [777] },
                    execApprovals: { approvers: [888] },
                    guilds: {
                      "200": {
                        users: [999],
                        roles: [1010],
                        channels: {
                          help: { users: [1111], roles: [1212] },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          null,
          2,
        ),
        "utf-8",
      );

      const result = await loadAndMaybeMigrateDoctorConfig({
        options: { nonInteractive: true, repair: true },
        confirm: async () => false,
      });

      const cfg = result.cfg as unknown as {
        channels: { discord: RepairedDiscordPolicy };
      };

      expect(cfg.channels.discord.allowFrom).toEqual(["123"]);
      expect(cfg.channels.discord.dm.allowFrom).toEqual(["456"]);
      expect(cfg.channels.discord.dm.groupChannels).toEqual(["789"]);
      expect(cfg.channels.discord.execApprovals.approvers).toEqual(["321"]);
      expect(cfg.channels.discord.guilds["100"].users).toEqual(["111"]);
      expect(cfg.channels.discord.guilds["100"].roles).toEqual(["222"]);
      expect(cfg.channels.discord.guilds["100"].channels.general.users).toEqual(["333"]);
      expect(cfg.channels.discord.guilds["100"].channels.general.roles).toEqual(["444"]);
      expect(cfg.channels.discord.accounts.work.allowFrom).toEqual(["555"]);
      expect(cfg.channels.discord.accounts.work.dm.allowFrom).toEqual(["666"]);
      expect(cfg.channels.discord.accounts.work.dm.groupChannels).toEqual(["777"]);
      expect(cfg.channels.discord.accounts.work.execApprovals.approvers).toEqual(["888"]);
      expect(cfg.channels.discord.accounts.work.guilds["200"].users).toEqual(["999"]);
      expect(cfg.channels.discord.accounts.work.guilds["200"].roles).toEqual(["1010"]);
      expect(cfg.channels.discord.accounts.work.guilds["200"].channels.help.users).toEqual([
        "1111",
      ]);
      expect(cfg.channels.discord.accounts.work.guilds["200"].channels.help.roles).toEqual([
        "1212",
      ]);
    });
  });

  it('adds allowFrom ["*"] when dmPolicy="open" and allowFrom is missing on repair', async () => {
    const result = await runDoctorConfigWithInput({
      repair: true,
      config: {
        channels: {
          discord: {
            token: "test-token",
            dmPolicy: "open",
            groupPolicy: "open",
          },
        },
      },
      run: loadAndMaybeMigrateDoctorConfig,
    });

    const cfg = result.cfg as unknown as {
      channels: { discord: { allowFrom: string[]; dmPolicy: string } };
    };
    expect(cfg.channels.discord.allowFrom).toEqual(["*"]);
    expect(cfg.channels.discord.dmPolicy).toBe("open");
  });

  it("adds * to existing allowFrom array when dmPolicy is open on repair", async () => {
    const result = await runDoctorConfigWithInput({
      repair: true,
      config: {
        channels: {
          slack: {
            botToken: "xoxb-test",
            appToken: "xapp-test",
            dmPolicy: "open",
            allowFrom: ["U123"],
          },
        },
      },
      run: loadAndMaybeMigrateDoctorConfig,
    });

    const cfg = result.cfg as unknown as {
      channels: { slack: { allowFrom: string[] } };
    };
    expect(cfg.channels.slack.allowFrom).toContain("*");
    expect(cfg.channels.slack.allowFrom).toContain("U123");
  });

  it("repairs nested dm.allowFrom when top-level allowFrom is absent on repair", async () => {
    const result = await runDoctorConfigWithInput({
      repair: true,
      config: {
        channels: {
          discord: {
            token: "test-token",
            dmPolicy: "open",
            dm: { allowFrom: ["123"] },
          },
        },
      },
      run: loadAndMaybeMigrateDoctorConfig,
    });

    const cfg = result.cfg as unknown as {
      channels: { discord: { dm: { allowFrom: string[] }; allowFrom?: string[] } };
    };
    // When dmPolicy is set at top level but allowFrom only exists nested in dm,
    // the repair adds "*" to dm.allowFrom
    if (cfg.channels.discord.dm) {
      expect(cfg.channels.discord.dm.allowFrom).toContain("*");
      expect(cfg.channels.discord.dm.allowFrom).toContain("123");
    } else {
      // If doctor flattened the config, allowFrom should be at top level
      expect(cfg.channels.discord.allowFrom).toContain("*");
    }
  });

  it("skips repair when allowFrom already includes *", async () => {
    const result = await runDoctorConfigWithInput({
      repair: true,
      config: {
        channels: {
          discord: {
            token: "test-token",
            dmPolicy: "open",
            allowFrom: ["*"],
          },
        },
      },
      run: loadAndMaybeMigrateDoctorConfig,
    });

    const cfg = result.cfg as unknown as {
      channels: { discord: { allowFrom: string[] } };
    };
    expect(cfg.channels.discord.allowFrom).toEqual(["*"]);
  });

  it("repairs per-account dmPolicy open without allowFrom on repair", async () => {
    const result = await runDoctorConfigWithInput({
      repair: true,
      config: {
        channels: {
          discord: {
            token: "test-token",
            accounts: {
              work: {
                token: "test-token-2",
                dmPolicy: "open",
              },
            },
          },
        },
      },
      run: loadAndMaybeMigrateDoctorConfig,
    });

    const cfg = result.cfg as unknown as {
      channels: {
        discord: { accounts: { work: { allowFrom: string[]; dmPolicy: string } } };
      };
    };
    expect(cfg.channels.discord.accounts.work.allowFrom).toEqual(["*"]);
  });

  it("migrates legacy toolsBySender keys to typed id entries on repair", async () => {
    const result = await runDoctorConfigWithInput({
      repair: true,
      config: {
        channels: {
          whatsapp: {
            groups: {
              "123@g.us": {
                toolsBySender: {
                  owner: { allow: ["exec"] },
                  alice: { deny: ["exec"] },
                  "id:owner": { deny: ["exec"] },
                  "username:@ops-bot": { allow: ["fs.read"] },
                  "*": { deny: ["exec"] },
                },
              },
            },
          },
        },
      },
      run: loadAndMaybeMigrateDoctorConfig,
    });

    const cfg = result.cfg as unknown as {
      channels: {
        whatsapp: {
          groups: {
            "123@g.us": {
              toolsBySender: Record<string, { allow?: string[]; deny?: string[] }>;
            };
          };
        };
      };
    };
    const toolsBySender = cfg.channels.whatsapp.groups["123@g.us"].toolsBySender;
    expect(toolsBySender.owner).toBeUndefined();
    expect(toolsBySender.alice).toBeUndefined();
    expect(toolsBySender["id:owner"]).toEqual({ deny: ["exec"] });
    expect(toolsBySender["id:alice"]).toEqual({ deny: ["exec"] });
    expect(toolsBySender["username:@ops-bot"]).toEqual({ allow: ["fs.read"] });
    expect(toolsBySender["*"]).toEqual({ deny: ["exec"] });
  });

  it("repairs googlechat dm.policy open by setting dm.allowFrom on repair", async () => {
    const result = await runDoctorConfigWithInput({
      repair: true,
      config: {
        channels: {
          googlechat: {
            dm: {
              policy: "open",
            },
          },
        },
      },
      run: loadAndMaybeMigrateDoctorConfig,
    });

    expectGoogleChatDmAllowFromRepaired(result.cfg);
  });

  it("repairs googlechat account dm.policy open by setting dm.allowFrom on repair", async () => {
    const result = await runDoctorConfigWithInput({
      repair: true,
      config: {
        channels: {
          googlechat: {
            accounts: {
              work: {
                dm: {
                  policy: "open",
                },
              },
            },
          },
        },
      },
      run: loadAndMaybeMigrateDoctorConfig,
    });

    const cfg = result.cfg as unknown as {
      channels: {
        googlechat: {
          accounts: {
            work: {
              dm: {
                policy: string;
                allowFrom: string[];
              };
              allowFrom?: string[];
            };
          };
        };
      };
    };

    expect(cfg.channels.googlechat.accounts.work.dm.allowFrom).toEqual(["*"]);
    expect(cfg.channels.googlechat.accounts.work.allowFrom).toBeUndefined();
  });

  it("recovers from stale googlechat top-level allowFrom by repairing dm.allowFrom", async () => {
    const result = await runDoctorConfigWithInput({
      repair: true,
      config: {
        channels: {
          googlechat: {
            allowFrom: ["*"],
            dm: {
              policy: "open",
            },
          },
        },
      },
      run: loadAndMaybeMigrateDoctorConfig,
    });

    expectGoogleChatDmAllowFromRepaired(result.cfg);
  });
});
