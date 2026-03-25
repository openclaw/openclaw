import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveMatrixAccountStorageRoot } from "../../extensions/matrix/runtime-api.js";
import { withTempHome } from "../../test/helpers/temp-home.js";
import * as noteModule from "../terminal/note.js";
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

async function collectDoctorWarnings(config: Record<string, unknown>): Promise<string[]> {
  const noteSpy = vi.spyOn(noteModule, "note").mockImplementation(() => {});
  try {
    await runDoctorConfigWithInput({
      config,
      run: loadAndMaybeMigrateDoctorConfig,
    });
    return noteSpy.mock.calls
      .filter((call) => call[1] === "Doctor warnings")
      .map((call) => String(call[0]));
  } finally {
    noteSpy.mockRestore();
  }
}

type DoctorFlowDeps = {
  telegramFetchModule: typeof import("../../extensions/telegram/src/fetch.js");
  telegramProxyModule: typeof import("../../extensions/telegram/src/proxy.js");
  commandSecretGatewayModule: typeof import("../cli/command-secret-gateway.js");
  noteModule: typeof import("../terminal/note.js");
  loadAndMaybeMigrateDoctorConfig: typeof import("./doctor-config-flow.js").loadAndMaybeMigrateDoctorConfig;
};

let cachedDoctorFlowDeps: Promise<DoctorFlowDeps> | undefined;

async function loadFreshDoctorFlowDeps(): Promise<DoctorFlowDeps> {
  if (!cachedDoctorFlowDeps) {
    vi.resetModules();
    cachedDoctorFlowDeps = (async () => {
      const telegramFetchModule = await import("../../extensions/telegram/src/fetch.js");
      const telegramProxyModule = await import("../../extensions/telegram/src/proxy.js");
      const freshCommandSecretGatewayModule = await import("../cli/command-secret-gateway.js");
      const freshNoteModule = await import("../terminal/note.js");
      const doctorFlowModule = await import("./doctor-config-flow.js");
      return {
        telegramFetchModule,
        telegramProxyModule,
        commandSecretGatewayModule: freshCommandSecretGatewayModule,
        noteModule: freshNoteModule,
        loadAndMaybeMigrateDoctorConfig: doctorFlowModule.loadAndMaybeMigrateDoctorConfig,
      };
    })();
  }
  return await cachedDoctorFlowDeps;
}

type DiscordGuildRule = {
  users: string[];
  roles: string[];
  channels: Record<string, { users: string[]; roles: string[] }>;
};

type DiscordAccountRule = {
  allowFrom?: string[];
  dm?: { allowFrom: string[]; groupChannels: string[] };
  execApprovals?: { approvers: string[] };
  guilds?: Record<string, DiscordGuildRule>;
};

type RepairedDiscordPolicy = {
  allowFrom?: string[];
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

  it("does not warn on mutable account allowlists when dangerous name matching is inherited", async () => {
    const doctorWarnings = await collectDoctorWarnings({
      channels: {
        slack: {
          dangerouslyAllowNameMatching: true,
          accounts: {
            work: {
              allowFrom: ["alice"],
            },
          },
        },
      },
    });
    expect(doctorWarnings.some((line) => line.includes("mutable allowlist"))).toBe(false);
  });

  it("does not warn about sender-based group allowlist for googlechat", async () => {
    const doctorWarnings = await collectDoctorWarnings({
      channels: {
        googlechat: {
          groupPolicy: "allowlist",
          accounts: {
            work: {
              groupPolicy: "allowlist",
            },
          },
        },
      },
    });

    expect(
      doctorWarnings.some(
        (line) => line.includes('groupPolicy is "allowlist"') && line.includes("groupAllowFrom"),
      ),
    ).toBe(false);
  });

  it("shows first-time Telegram guidance without the old groupAllowFrom warning", async () => {
    const doctorWarnings = await collectDoctorWarnings({
      channels: {
        telegram: {
          botToken: "123:abc",
          groupPolicy: "allowlist",
        },
      },
    });

    expect(
      doctorWarnings.some(
        (line) =>
          line.includes('channels.telegram.groupPolicy is "allowlist"') &&
          line.includes("groupAllowFrom"),
      ),
    ).toBe(false);
    expect(
      doctorWarnings.some(
        (line) =>
          line.includes("channels.telegram: Telegram is in first-time setup mode.") &&
          line.includes("DMs use pairing mode") &&
          line.includes("channels.telegram.groups"),
      ),
    ).toBe(true);
  });

  it("shows account-scoped first-time Telegram guidance without the old groupAllowFrom warning", async () => {
    const doctorWarnings = await collectDoctorWarnings({
      channels: {
        telegram: {
          accounts: {
            default: {
              botToken: "123:abc",
              groupPolicy: "allowlist",
            },
          },
        },
      },
    });

    expect(
      doctorWarnings.some(
        (line) =>
          line.includes('channels.telegram.accounts.default.groupPolicy is "allowlist"') &&
          line.includes("groupAllowFrom"),
      ),
    ).toBe(false);
    expect(
      doctorWarnings.some(
        (line) =>
          line.includes(
            "channels.telegram.accounts.default: Telegram is in first-time setup mode.",
          ) &&
          line.includes("DMs use pairing mode") &&
          line.includes("channels.telegram.accounts.default.groups"),
      ),
    ).toBe(true);
  });

  it("warns on mutable Zalouser group entries when dangerous name matching is disabled", async () => {
    const doctorWarnings = await collectDoctorWarnings({
      channels: {
        zalouser: {
          groups: {
            "Ops Room": { allow: true },
          },
        },
      },
    });

    expect(
      doctorWarnings.some(
        (line) =>
          line.includes("mutable allowlist") && line.includes("channels.zalouser.groups: Ops Room"),
      ),
    ).toBe(true);
  });

  it("does not warn on mutable Zalouser group entries when dangerous name matching is enabled", async () => {
    const doctorWarnings = await collectDoctorWarnings({
      channels: {
        zalouser: {
          dangerouslyAllowNameMatching: true,
          groups: {
            "Ops Room": { allow: true },
          },
        },
      },
    });

    expect(doctorWarnings.some((line) => line.includes("channels.zalouser.groups"))).toBe(false);
  });

  it("warns when imessage group allowlist is empty even if allowFrom is set", async () => {
    const doctorWarnings = await collectDoctorWarnings({
      channels: {
        imessage: {
          groupPolicy: "allowlist",
          allowFrom: ["+15551234567"],
        },
      },
    });

    expect(
      doctorWarnings.some(
        (line) =>
          line.includes('channels.imessage.groupPolicy is "allowlist"') &&
          line.includes("does not fall back to allowFrom"),
      ),
    ).toBe(true);
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

  it("migrates legacy browser extension profiles to existing-session on repair", async () => {
    const result = await runDoctorConfigWithInput({
      repair: true,
      config: {
        browser: {
          relayBindHost: "0.0.0.0",
          profiles: {
            chromeLive: {
              driver: "extension",
              color: "#00AA00",
            },
          },
        },
      },
      run: loadAndMaybeMigrateDoctorConfig,
    });

    const browser = (result.cfg as { browser?: Record<string, unknown> }).browser ?? {};
    expect(browser.relayBindHost).toBeUndefined();
    expect(
      ((browser.profiles as Record<string, { driver?: string }>)?.chromeLive ?? {}).driver,
    ).toBe("existing-session");
  });

  it("previews Matrix legacy sync-store migration in read-only mode", async () => {
    const noteSpy = vi.spyOn(noteModule, "note").mockImplementation(() => {});
    try {
      await withTempHome(async (home) => {
        const stateDir = path.join(home, ".openclaw");
        await fs.mkdir(path.join(stateDir, "matrix"), { recursive: true });
        await fs.writeFile(
          path.join(stateDir, "openclaw.json"),
          JSON.stringify({
            channels: {
              matrix: {
                homeserver: "https://matrix.example.org",
                userId: "@bot:example.org",
                accessToken: "tok-123",
              },
            },
          }),
        );
        await fs.writeFile(
          path.join(stateDir, "matrix", "bot-storage.json"),
          '{"next_batch":"s1"}',
        );
        await loadAndMaybeMigrateDoctorConfig({
          options: { nonInteractive: true },
          confirm: async () => false,
        });
      });

      const warning = noteSpy.mock.calls.find(
        (call) =>
          call[1] === "Doctor warnings" &&
          String(call[0]).includes("Matrix plugin upgraded in place."),
      );
      expect(warning?.[0]).toContain("Legacy sync store:");
      expect(warning?.[0]).toContain(
        'Run "openclaw doctor --fix" to migrate this Matrix state now.',
      );
    } finally {
      noteSpy.mockRestore();
    }
  });

  it("previews Matrix encrypted-state migration in read-only mode", async () => {
    const noteSpy = vi.spyOn(noteModule, "note").mockImplementation(() => {});
    try {
      await withTempHome(async (home) => {
        const stateDir = path.join(home, ".openclaw");
        const { rootDir: accountRoot } = resolveMatrixAccountStorageRoot({
          stateDir,
          homeserver: "https://matrix.example.org",
          userId: "@bot:example.org",
          accessToken: "tok-123",
        });
        await fs.mkdir(path.join(accountRoot, "crypto"), { recursive: true });
        await fs.writeFile(
          path.join(stateDir, "openclaw.json"),
          JSON.stringify({
            channels: {
              matrix: {
                homeserver: "https://matrix.example.org",
                userId: "@bot:example.org",
                accessToken: "tok-123",
              },
            },
          }),
        );
        await fs.writeFile(
          path.join(accountRoot, "crypto", "bot-sdk.json"),
          JSON.stringify({ deviceId: "DEVICE123" }),
        );
        await loadAndMaybeMigrateDoctorConfig({
          options: { nonInteractive: true },
          confirm: async () => false,
        });
      });

      const warning = noteSpy.mock.calls.find(
        (call) =>
          call[1] === "Doctor warnings" &&
          String(call[0]).includes("Matrix encrypted-state migration is pending"),
      );
      expect(warning?.[0]).toContain("Legacy crypto store:");
      expect(warning?.[0]).toContain("New recovery key file:");
    } finally {
      noteSpy.mockRestore();
    }
  });

  it("migrates Matrix legacy state on doctor repair", async () => {
    const noteSpy = vi.spyOn(noteModule, "note").mockImplementation(() => {});
    try {
      await withTempHome(async (home) => {
        const stateDir = path.join(home, ".openclaw");
        await fs.mkdir(path.join(stateDir, "matrix"), { recursive: true });
        await fs.writeFile(
          path.join(stateDir, "openclaw.json"),
          JSON.stringify({
            channels: {
              matrix: {
                homeserver: "https://matrix.example.org",
                userId: "@bot:example.org",
                accessToken: "tok-123",
              },
            },
          }),
        );
        await fs.writeFile(
          path.join(stateDir, "matrix", "bot-storage.json"),
          '{"next_batch":"s1"}',
        );
        await loadAndMaybeMigrateDoctorConfig({
          options: { nonInteractive: true, repair: true },
          confirm: async () => false,
        });

        const migratedRoot = path.join(
          stateDir,
          "matrix",
          "accounts",
          "default",
          "matrix.example.org__bot_example.org",
        );
        const migratedChildren = await fs.readdir(migratedRoot);
        expect(migratedChildren.length).toBe(1);
        expect(
          await fs
            .access(path.join(migratedRoot, migratedChildren[0] ?? "", "bot-storage.json"))
            .then(() => true)
            .catch(() => false),
        ).toBe(true);
        expect(
          await fs
            .access(path.join(stateDir, "matrix", "bot-storage.json"))
            .then(() => true)
            .catch(() => false),
        ).toBe(false);
      });

      expect(
        noteSpy.mock.calls.some(
          (call) =>
            call[1] === "Doctor changes" &&
            String(call[0]).includes("Matrix plugin upgraded in place."),
        ),
      ).toBe(true);
    } finally {
      noteSpy.mockRestore();
    }
  });

  it("creates a Matrix migration snapshot before doctor repair mutates Matrix state", async () => {
    await withTempHome(async (home) => {
      const stateDir = path.join(home, ".openclaw");
      await fs.mkdir(path.join(stateDir, "matrix"), { recursive: true });
      await fs.writeFile(
        path.join(stateDir, "openclaw.json"),
        JSON.stringify({
          channels: {
            matrix: {
              homeserver: "https://matrix.example.org",
              userId: "@bot:example.org",
              accessToken: "tok-123",
            },
          },
        }),
      );
      await fs.writeFile(path.join(stateDir, "matrix", "bot-storage.json"), '{"next_batch":"s1"}');

      await loadAndMaybeMigrateDoctorConfig({
        options: { nonInteractive: true, repair: true },
        confirm: async () => false,
      });

      const snapshotDir = path.join(home, "Backups", "openclaw-migrations");
      const snapshotEntries = await fs.readdir(snapshotDir);
      expect(snapshotEntries.some((entry) => entry.endsWith(".tar.gz"))).toBe(true);

      const marker = JSON.parse(
        await fs.readFile(path.join(stateDir, "matrix", "migration-snapshot.json"), "utf8"),
      ) as {
        archivePath: string;
      };
      expect(marker.archivePath).toContain(path.join("Backups", "openclaw-migrations"));
    });
  });

  it("warns when Matrix is installed from a stale custom path", async () => {
    const doctorWarnings = await collectDoctorWarnings({
      channels: {
        matrix: {
          homeserver: "https://matrix.example.org",
          accessToken: "tok-123",
        },
      },
      plugins: {
        installs: {
          matrix: {
            source: "path",
            sourcePath: "/tmp/openclaw-matrix-missing",
            installPath: "/tmp/openclaw-matrix-missing",
          },
        },
      },
    });

    expect(
      doctorWarnings.some(
        (line) => line.includes("custom path") && line.includes("/tmp/openclaw-matrix-missing"),
      ),
    ).toBe(true);
  });

  it("warns when Matrix is installed from an existing custom path", async () => {
    await withTempHome(async (home) => {
      const pluginPath = path.join(home, "matrix-plugin");
      await fs.mkdir(pluginPath, { recursive: true });

      const doctorWarnings = await collectDoctorWarnings({
        channels: {
          matrix: {
            homeserver: "https://matrix.example.org",
            accessToken: "tok-123",
          },
        },
        plugins: {
          installs: {
            matrix: {
              source: "path",
              sourcePath: pluginPath,
              installPath: pluginPath,
            },
          },
        },
      });

      expect(
        doctorWarnings.some((line) => line.includes("Matrix is installed from a custom path")),
      ).toBe(true);
      expect(
        doctorWarnings.some((line) => line.includes("will not automatically replace that plugin")),
      ).toBe(true);
    });
  });

  it("notes legacy browser extension migration changes", async () => {
    const noteSpy = vi.spyOn(noteModule, "note").mockImplementation(() => {});
    try {
      await runDoctorConfigWithInput({
        config: {
          browser: {
            relayBindHost: "127.0.0.1",
            profiles: {
              chromeLive: {
                driver: "extension",
                color: "#00AA00",
              },
            },
          },
        },
        run: loadAndMaybeMigrateDoctorConfig,
      });

      const messages = noteSpy.mock.calls
        .filter((call) => call[1] === "Doctor changes")
        .map((call) => String(call[0]));
      expect(
        messages.some((line) => line.includes('browser.profiles.chromeLive.driver "extension"')),
      ).toBe(true);
      expect(messages.some((line) => line.includes("browser.relayBindHost"))).toBe(true);
    } finally {
      noteSpy.mockRestore();
    }
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
    const globalFetch = vi.fn(async () => {
      throw new Error("global fetch should not be called");
    });
    const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      const u = input instanceof URL ? input.href : typeof input === "string" ? input : input.url;
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
    vi.stubGlobal("fetch", globalFetch);
    const {
      telegramFetchModule,
      telegramProxyModule,
      loadAndMaybeMigrateDoctorConfig: loadDoctorFlowFresh,
    } = await loadFreshDoctorFlowDeps();
    const resolveTelegramFetch = vi.spyOn(telegramFetchModule, "resolveTelegramFetch");
    const makeProxyFetch = vi.spyOn(telegramProxyModule, "makeProxyFetch");
    resolveTelegramFetch.mockReturnValue(fetchSpy as unknown as typeof fetch);
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
        run: loadDoctorFlowFresh,
      });

      const cfg = result.cfg as unknown as {
        channels: {
          telegram: {
            allowFrom?: string[];
            groupAllowFrom?: string[];
            groups: Record<
              string,
              { allowFrom: string[]; topics: Record<string, { allowFrom: string[] }> }
            >;
            accounts: Record<string, { allowFrom?: string[]; groupAllowFrom?: string[] }>;
          };
        };
      };
      expect(cfg.channels.telegram.allowFrom).toBeUndefined();
      expect(cfg.channels.telegram.groupAllowFrom).toBeUndefined();
      expect(cfg.channels.telegram.groups["-100123"].allowFrom).toEqual(["333"]);
      expect(cfg.channels.telegram.groups["-100123"].topics["99"].allowFrom).toEqual(["444"]);
      expect(cfg.channels.telegram.accounts.alerts.allowFrom).toEqual(["444"]);
      expect(cfg.channels.telegram.accounts.default.allowFrom).toEqual(["111"]);
      expect(cfg.channels.telegram.accounts.default.groupAllowFrom).toEqual(["222"]);
    } finally {
      makeProxyFetch.mockRestore();
      resolveTelegramFetch.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("does not crash when Telegram allowFrom repair sees unavailable SecretRef-backed credentials", async () => {
    const { noteModule: freshNoteModule, loadAndMaybeMigrateDoctorConfig: loadDoctorFlowFresh } =
      await loadFreshDoctorFlowDeps();
    const noteSpy = vi.spyOn(freshNoteModule, "note").mockImplementation(() => {});
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const result = await runDoctorConfigWithInput({
        repair: true,
        config: {
          secrets: {
            providers: {
              default: { source: "env" },
            },
          },
          channels: {
            telegram: {
              botToken: { source: "env", provider: "default", id: "TELEGRAM_BOT_TOKEN" },
              allowFrom: ["@testuser"],
            },
          },
        },
        run: loadDoctorFlowFresh,
      });

      const cfg = result.cfg as {
        channels?: {
          telegram?: {
            allowFrom?: string[];
            accounts?: Record<string, { allowFrom?: string[] }>;
          };
        };
      };
      const retainedAllowFrom =
        cfg.channels?.telegram?.accounts?.default?.allowFrom ?? cfg.channels?.telegram?.allowFrom;
      expect(retainedAllowFrom).toEqual(["@testuser"]);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(
        noteSpy.mock.calls.some((call) =>
          String(call[0]).includes(
            "configured Telegram bot credentials are unavailable in this command path",
          ),
        ),
      ).toBe(true);
    } finally {
      noteSpy.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("ignores custom Telegram apiRoot and proxy when repairing allowFrom usernames", async () => {
    const globalFetch = vi.fn(async () => {
      throw new Error("global fetch should not be called");
    });
    const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      const url = input instanceof URL ? input.href : typeof input === "string" ? input : input.url;
      expect(url).toBe("https://api.telegram.org/bottok/getChat?chat_id=%40testuser");
      return {
        ok: true,
        json: async () => ({ ok: true, result: { id: 12345 } }),
      };
    });
    vi.stubGlobal("fetch", globalFetch);
    const proxyFetch = vi.fn();
    const {
      telegramFetchModule,
      telegramProxyModule,
      commandSecretGatewayModule: freshCommandSecretGatewayModule,
      loadAndMaybeMigrateDoctorConfig: loadDoctorFlowFresh,
    } = await loadFreshDoctorFlowDeps();
    const resolveTelegramFetch = vi.spyOn(telegramFetchModule, "resolveTelegramFetch");
    const makeProxyFetch = vi.spyOn(telegramProxyModule, "makeProxyFetch");
    makeProxyFetch.mockReturnValue(proxyFetch as unknown as typeof fetch);
    resolveTelegramFetch.mockReturnValue(fetchSpy as unknown as typeof fetch);
    const resolveSecretsSpy = vi
      .spyOn(freshCommandSecretGatewayModule, "resolveCommandSecretRefsViaGateway")
      .mockResolvedValue({
        diagnostics: [],
        targetStatesByPath: {},
        hadUnresolvedTargets: false,
        resolvedConfig: {
          channels: {
            telegram: {
              accounts: {
                work: {
                  botToken: "tok",
                  apiRoot: "https://custom.telegram.test/root/",
                  proxy: "http://127.0.0.1:8888",
                  network: { autoSelectFamily: false, dnsResultOrder: "ipv4first" },
                  allowFrom: ["@testuser"],
                },
              },
            },
          },
        },
      });

    try {
      const result = await runDoctorConfigWithInput({
        repair: true,
        config: {
          channels: {
            telegram: {
              accounts: {
                work: {
                  botToken: "tok",
                  allowFrom: ["@testuser"],
                },
              },
            },
          },
        },
        run: loadDoctorFlowFresh,
      });

      const cfg = result.cfg as {
        channels?: {
          telegram?: {
            accounts?: Record<string, { allowFrom?: string[] }>;
          };
        };
      };
      expect(cfg.channels?.telegram?.accounts?.work?.allowFrom).toEqual(["12345"]);
      expect(makeProxyFetch).not.toHaveBeenCalled();
      expect(resolveTelegramFetch).toHaveBeenCalledWith(undefined, {
        network: { autoSelectFamily: false, dnsResultOrder: "ipv4first" },
      });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      makeProxyFetch.mockRestore();
      resolveTelegramFetch.mockRestore();
      resolveSecretsSpy.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("sanitizes config-derived doctor warnings and changes before logging", async () => {
    const {
      telegramFetchModule,
      noteModule: freshNoteModule,
      loadAndMaybeMigrateDoctorConfig: loadDoctorFlowFresh,
    } = await loadFreshDoctorFlowDeps();
    const noteSpy = vi.spyOn(freshNoteModule, "note").mockImplementation(() => {});
    const globalFetch = vi.fn(async () => {
      throw new Error("global fetch should not be called");
    });
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true, result: { id: 12345 } }),
    }));
    vi.stubGlobal("fetch", globalFetch);
    const resolveTelegramFetch = vi.spyOn(telegramFetchModule, "resolveTelegramFetch");
    resolveTelegramFetch.mockReturnValue(fetchSpy as unknown as typeof fetch);
    try {
      await runDoctorConfigWithInput({
        repair: true,
        config: {
          channels: {
            telegram: {
              accounts: {
                work: {
                  botToken: "tok",
                  allowFrom: ["@\u001b[31mtestuser"],
                },
              },
            },
            slack: {
              accounts: {
                work: {
                  allowFrom: ["alice\u001b[31m\nforged"],
                },
                "ops\u001b[31m\nopen": {
                  dmPolicy: "open",
                },
              },
            },
            whatsapp: {
              accounts: {
                "ops\u001b[31m\nempty": {
                  groupPolicy: "allowlist",
                },
              },
            },
          },
        },
        run: loadDoctorFlowFresh,
      });

      const outputs = noteSpy.mock.calls
        .filter((call) => call[1] === "Doctor warnings" || call[1] === "Doctor changes")
        .map((call) => String(call[0]));
      expect(outputs.filter((line) => line.includes("\u001b"))).toEqual([]);
      expect(outputs.filter((line) => line.includes("\nforged"))).toEqual([]);
      expect(outputs.some((line) => line.includes("resolved @testuser -> 12345"))).toBe(true);
      expect(
        outputs.some(
          (line) =>
            line.includes("channels.slack.accounts.work.allowFrom: aliceforged") &&
            line.includes("mutable allowlist"),
        ),
      ).toBe(true);
      expect(
        outputs.some(
          (line) =>
            line.includes('channels.slack.accounts.opsopen.allowFrom: set to ["*"]') &&
            line.includes('required by dmPolicy="open"'),
        ),
      ).toBe(true);
      expect(
        outputs.some(
          (line) =>
            line.includes('channels.whatsapp.accounts.opsempty.groupPolicy is "allowlist"') &&
            line.includes("groupAllowFrom"),
        ),
      ).toBe(true);
    } finally {
      resolveTelegramFetch.mockRestore();
      noteSpy.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("warns and continues when Telegram account inspection hits inactive SecretRef surfaces", async () => {
    const { noteModule: freshNoteModule, loadAndMaybeMigrateDoctorConfig: loadDoctorFlowFresh } =
      await loadFreshDoctorFlowDeps();
    const noteSpy = vi.spyOn(freshNoteModule, "note").mockImplementation(() => {});
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const result = await runDoctorConfigWithInput({
        repair: true,
        config: {
          secrets: {
            providers: {
              default: { source: "env" },
            },
          },
          channels: {
            telegram: {
              accounts: {
                inactive: {
                  enabled: false,
                  botToken: { source: "env", provider: "default", id: "TELEGRAM_BOT_TOKEN" },
                  allowFrom: ["@testuser"],
                },
              },
            },
          },
        },
        run: loadDoctorFlowFresh,
      });

      const cfg = result.cfg as {
        channels?: {
          telegram?: {
            accounts?: Record<string, { allowFrom?: string[] }>;
          };
        };
      };
      expect(cfg.channels?.telegram?.accounts?.inactive?.allowFrom).toEqual(["@testuser"]);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(
        noteSpy.mock.calls.some((call) =>
          String(call[0]).includes("Telegram account inactive: failed to inspect bot token"),
        ),
      ).toBe(true);
      expect(
        noteSpy.mock.calls.some((call) =>
          String(call[0]).includes(
            "Telegram allowFrom contains @username entries, but no Telegram bot token is configured",
          ),
        ),
      ).toBe(true);
    } finally {
      noteSpy.mockRestore();
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
        channels: {
          discord: Omit<RepairedDiscordPolicy, "allowFrom"> & {
            allowFrom?: string[];
            accounts: Record<string, DiscordAccountRule> & {
              default: { allowFrom: string[] };
              work: {
                allowFrom: string[];
                dm: { allowFrom: string[]; groupChannels: string[] };
                execApprovals: { approvers: string[] };
                guilds: Record<string, DiscordGuildRule>;
              };
            };
          };
        };
      };

      expect(cfg.channels.discord.allowFrom).toBeUndefined();
      expect(cfg.channels.discord.dm.allowFrom).toEqual(["456"]);
      expect(cfg.channels.discord.dm.groupChannels).toEqual(["789"]);
      expect(cfg.channels.discord.execApprovals.approvers).toEqual(["321"]);
      expect(cfg.channels.discord.guilds["100"].users).toEqual(["111"]);
      expect(cfg.channels.discord.guilds["100"].roles).toEqual(["222"]);
      expect(cfg.channels.discord.guilds["100"].channels.general.users).toEqual(["333"]);
      expect(cfg.channels.discord.guilds["100"].channels.general.roles).toEqual(["444"]);
      expect(cfg.channels.discord.accounts.default.allowFrom).toEqual(["123"]);
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

  it("does not restore top-level allowFrom when config is intentionally default-account scoped", async () => {
    const result = await runDoctorConfigWithInput({
      repair: true,
      config: {
        channels: {
          discord: {
            accounts: {
              default: { token: "discord-default-token", allowFrom: ["123"] },
              work: { token: "discord-work-token" },
            },
          },
        },
      },
      run: loadAndMaybeMigrateDoctorConfig,
    });

    const cfg = result.cfg as {
      channels: {
        discord: {
          allowFrom?: string[];
          accounts: Record<string, { allowFrom?: string[] }>;
        };
      };
    };

    expect(cfg.channels.discord.allowFrom).toBeUndefined();
    expect(cfg.channels.discord.accounts.default.allowFrom).toEqual(["123"]);
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

  it('repairs dmPolicy="allowlist" by restoring allowFrom from pairing store on repair', async () => {
    const result = await withTempHome(async (home) => {
      const configDir = path.join(home, ".openclaw");
      const credentialsDir = path.join(configDir, "credentials");
      await fs.mkdir(credentialsDir, { recursive: true });
      await fs.writeFile(
        path.join(configDir, "openclaw.json"),
        JSON.stringify(
          {
            channels: {
              telegram: {
                botToken: "fake-token",
                dmPolicy: "allowlist",
              },
            },
          },
          null,
          2,
        ),
        "utf-8",
      );
      await fs.writeFile(
        path.join(credentialsDir, "telegram-allowFrom.json"),
        JSON.stringify({ version: 1, allowFrom: ["12345"] }, null, 2),
        "utf-8",
      );
      return await loadAndMaybeMigrateDoctorConfig({
        options: { nonInteractive: true, repair: true },
        confirm: async () => false,
      });
    });

    const cfg = result.cfg as {
      channels: {
        telegram: {
          dmPolicy: string;
          allowFrom: string[];
        };
      };
    };
    expect(cfg.channels.telegram.dmPolicy).toBe("allowlist");
    expect(cfg.channels.telegram.allowFrom).toEqual(["12345"]);
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

  it("migrates top-level heartbeat into agents.defaults.heartbeat on repair", async () => {
    const result = await runDoctorConfigWithInput({
      repair: true,
      config: {
        heartbeat: {
          model: "anthropic/claude-3-5-haiku-20241022",
          every: "30m",
        },
      },
      run: loadAndMaybeMigrateDoctorConfig,
    });

    const cfg = result.cfg as {
      heartbeat?: unknown;
      agents?: {
        defaults?: {
          heartbeat?: {
            model?: string;
            every?: string;
          };
        };
      };
    };
    expect(cfg.heartbeat).toBeUndefined();
    expect(cfg.agents?.defaults?.heartbeat).toMatchObject({
      model: "anthropic/claude-3-5-haiku-20241022",
      every: "30m",
    });
  });

  it("migrates top-level heartbeat visibility into channels.defaults.heartbeat on repair", async () => {
    const result = await runDoctorConfigWithInput({
      repair: true,
      config: {
        heartbeat: {
          showOk: true,
          showAlerts: false,
        },
      },
      run: loadAndMaybeMigrateDoctorConfig,
    });

    const cfg = result.cfg as {
      heartbeat?: unknown;
      channels?: {
        defaults?: {
          heartbeat?: {
            showOk?: boolean;
            showAlerts?: boolean;
            useIndicator?: boolean;
          };
        };
      };
    };
    expect(cfg.heartbeat).toBeUndefined();
    expect(cfg.channels?.defaults?.heartbeat).toMatchObject({
      showOk: true,
      showAlerts: false,
    });
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
