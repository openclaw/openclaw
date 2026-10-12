/** Tests Discord secret surfaces in runtime preparation. */
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTestDir } from "../test-helpers/temp-dir.js";
import "./runtime-discord.test-support.ts";
import {
  asConfig,
  loadAuthStoreWithProfiles,
  setupSecretsRuntimeSnapshotTestHooks,
} from "./runtime.test-support.ts";

const { prepareSecretsRuntimeSnapshot } = setupSecretsRuntimeSnapshotTestHooks();

function envRef(id: string) {
  return { source: "env", provider: "default", id } as const;
}

function voiceTts(id: string, options: { enabled?: boolean } = {}) {
  return { ...options, tts: { providers: { openai: { apiKey: envRef(id) } } } };
}

describe("secrets runtime snapshot discord surface", () => {
  it("resolves active Discord token refs for the default account", async () => {
    const topLevelSnapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        channels: {
          discord: {
            token: envRef("DISCORD_BOT_TOKEN"),
          },
        },
      }),
      env: {
        DISCORD_BOT_TOKEN: "base-token",
      },
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () => loadAuthStoreWithProfiles({}),
    });
    expect(topLevelSnapshot.config.channels?.discord?.token).toBe("base-token");

    const accountSnapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        channels: {
          discord: {
            token: envRef("DISCORD_BOT_TOKEN"),
            accounts: {
              default: {
                enabled: true,
                token: envRef("DISCORD_DEFAULT_ACCOUNT_TOKEN"),
              },
            },
          },
        },
      }),
      env: {
        DISCORD_BOT_TOKEN: "base-token",
        DISCORD_DEFAULT_ACCOUNT_TOKEN: "default-account-token",
      },
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () => loadAuthStoreWithProfiles({}),
    });

    expect(accountSnapshot.config.channels?.discord?.token).toEqual(envRef("DISCORD_BOT_TOKEN"));
    expect(accountSnapshot.config.channels?.discord?.accounts?.default?.token).toBe(
      "default-account-token",
    );
  });

  it.skipIf(process.platform === "win32")(
    "resolves the implicit default token when named Discord accounts are added",
    async () => {
      await withTestDir({ prefix: "openclaw-discord-secrets-" }, async (root) => {
        const secretsPath = path.join(root, "secrets.json");
        await fs.writeFile(
          secretsPath,
          JSON.stringify({
            discord: {
              defaultToken: "default-account-token",
              secondToken: "second-account-token",
            },
          }),
          "utf8",
        );
        await fs.chmod(secretsPath, 0o600);

        const snapshot = await prepareSecretsRuntimeSnapshot({
          config: asConfig({
            secrets: {
              providers: {
                discord_file: {
                  source: "file",
                  path: secretsPath,
                  mode: "json",
                },
              },
            },
            channels: {
              discord: {
                token: {
                  source: "file",
                  provider: "discord_file",
                  id: "/discord/defaultToken",
                },
                accounts: {
                  second: {
                    enabled: true,
                    token: {
                      source: "file",
                      provider: "discord_file",
                      id: "/discord/secondToken",
                    },
                  },
                },
              },
            },
          }),
          agentDirs: ["/tmp/openclaw-agent-main"],
          loadAuthStore: () => loadAuthStoreWithProfiles({}),
        });

        expect(snapshot.config.channels?.discord?.token).toBe("default-account-token");
        expect(snapshot.config.channels?.discord?.accounts?.second?.token).toBe(
          "second-account-token",
        );
        expect(snapshot.warnings.map((warning) => warning.path)).not.toContain(
          "channels.discord.token",
        );
      });
    },
  );

  it("keeps inherited refs active for an env-backed implicit default", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        channels: {
          discord: {
            pluralkit: {
              token: envRef("DISCORD_DEFAULT_PK_TOKEN"),
            },
            accounts: {
              second: {
                pluralkit: {
                  token: envRef("DISCORD_SECOND_PK_TOKEN"),
                },
              },
            },
          },
        },
      }),
      env: {
        DISCORD_BOT_TOKEN: "env-default-token",
        DISCORD_DEFAULT_PK_TOKEN: "default-pk-token",
        DISCORD_SECOND_PK_TOKEN: "second-pk-token",
      },
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () => loadAuthStoreWithProfiles({}),
    });

    expect(snapshot.config.channels?.discord?.pluralkit?.token).toBe("default-pk-token");
    expect(snapshot.config.channels?.discord?.accounts?.second?.pluralkit?.token).toBe(
      "second-pk-token",
    );
    expect(snapshot.warnings).toStrictEqual([]);
  });

  it("fails when non-default Discord account inherits an unresolved top-level token ref", async () => {
    await expect(
      prepareSecretsRuntimeSnapshot({
        config: asConfig({
          channels: {
            discord: {
              token: envRef("MISSING_DISCORD_BASE_TOKEN"),
              accounts: {
                work: {
                  enabled: true,
                },
              },
            },
          },
        }),
        env: {},
        agentDirs: ["/tmp/openclaw-agent-main"],
        loadAuthStore: () => loadAuthStoreWithProfiles({}),
      }),
    ).rejects.toThrow('Environment variable "MISSING_DISCORD_BASE_TOKEN" is missing or empty.');
  });

  it("isolates one unresolved Discord account token while resolving its sibling", async () => {
    const env = Object.fromEntries([["DISCORD_HEALTHY_TOKEN", "fixture-value"]]);
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        channels: {
          discord: {
            accounts: {
              broken: {
                enabled: true,
                token: envRef("MISSING_DISCORD_BROKEN_TOKEN"),
              },
              healthy: {
                enabled: true,
                token: envRef("DISCORD_HEALTHY_TOKEN"),
              },
            },
          },
        },
      }),
      env,
      allowUnavailableSecretOwners: true,
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () => loadAuthStoreWithProfiles({}),
    });

    expect(snapshot.config.channels?.discord?.accounts?.broken?.token).toEqual(
      envRef("MISSING_DISCORD_BROKEN_TOKEN"),
    );
    expect(snapshot.config.channels?.discord?.accounts?.healthy?.token).toBe("fixture-value");
    expect(snapshot.degradedOwners).toMatchObject([
      {
        ownerKind: "account",
        ownerId: "discord:broken",
        state: "unavailable",
        paths: ["channels.discord.accounts.broken.token"],
        reason: "secret reference was not found",
      },
    ]);
  });

  it("treats top-level Discord token refs as inactive when account token is explicitly blank", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        channels: {
          discord: {
            token: envRef("MISSING_DISCORD_DEFAULT_TOKEN"),
            accounts: {
              default: {
                enabled: true,
                token: "",
              },
            },
          },
        },
      }),
      env: {},
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () => loadAuthStoreWithProfiles({}),
    });

    expect(snapshot.config.channels?.discord?.token).toEqual(
      envRef("MISSING_DISCORD_DEFAULT_TOKEN"),
    );
    expect(snapshot.warnings.map((warning) => warning.path)).toContain("channels.discord.token");
  });

  it("treats Discord PluralKit token refs as inactive when PluralKit is disabled", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        channels: {
          discord: {
            pluralkit: {
              enabled: false,
              token: envRef("MISSING_DISCORD_PLURALKIT_TOKEN"),
            },
          },
        },
      }),
      env: {},
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () => loadAuthStoreWithProfiles({}),
    });

    expect(snapshot.config.channels?.discord?.pluralkit?.token).toEqual(
      envRef("MISSING_DISCORD_PLURALKIT_TOKEN"),
    );
    expect(snapshot.warnings.map((warning) => warning.path)).toContain(
      "channels.discord.pluralkit.token",
    );
  });

  it.each([true, false])(
    "resolves Discord persona refs with root inheritance=%s",
    async (inheritsRoot) => {
      const voice = (id: string, enabled = true) => ({
        enabled,
        mode: "stt-tts",
        tts: {
          persona: "reader.uk",
          personas: { "reader.uk": { providers: { mock: { apiKey: envRef(id) } } } },
        },
        realtime: { providers: { openai: { apiKey: envRef(`${id}_REALTIME`) } } },
      });
      const snapshot = await prepareSecretsRuntimeSnapshot({
        config: asConfig({
          channels: {
            discord: {
              voice: voice("TEST_TTS_DISCORD_ROOT"),
              accounts: {
                ...(inheritsRoot ? { inherited: {} } : {}),
                work: { voice: voice("TEST_TTS_DISCORD_WORK") },
                disabled: { enabled: false, voice: voice("TEST_TTS_DISCORD_DISABLED") },
                muted: { voice: voice("TEST_TTS_DISCORD_MUTED", false) },
              },
            },
          },
        }),
        env: {
          ...(inheritsRoot ? { TEST_TTS_DISCORD_ROOT: "root-fixture-key" } : {}),
          TEST_TTS_DISCORD_WORK: "work-fixture-key",
        },
        includeAuthStoreRefs: false,
        agentDirs: ["/tmp/openclaw-agent-main"],
      });
      const discord = snapshot.config.channels?.discord;
      expect(discord?.voice?.tts?.personas?.["reader.uk"]?.providers?.mock?.apiKey).toEqual(
        inheritsRoot ? "root-fixture-key" : envRef("TEST_TTS_DISCORD_ROOT"),
      );
      expect(
        discord?.accounts?.work?.voice?.tts?.personas?.["reader.uk"]?.providers?.mock?.apiKey,
      ).toBe("work-fixture-key");
      const inactivePaths = snapshot.warnings
        .filter((warning) => warning.code === "SECRETS_REF_IGNORED_INACTIVE_SURFACE")
        .map((warning) => warning.path);
      for (const [accountId, id] of [
        ["disabled", "TEST_TTS_DISCORD_DISABLED"],
        ["muted", "TEST_TTS_DISCORD_MUTED"],
      ] as const) {
        expect(
          discord?.accounts?.[accountId]?.voice?.tts?.personas?.["reader.uk"]?.providers?.mock
            ?.apiKey,
        ).toEqual(envRef(id));
        expect(inactivePaths).toContain(
          `channels.discord.accounts.${accountId}.voice.tts.personas["reader.uk"].providers.mock.apiKey`,
        );
      }
      expect(
        inactivePaths.includes(
          'channels.discord.voice.tts.personas["reader.uk"].providers.mock.apiKey',
        ),
      ).toBe(!inheritsRoot);
      expect(discord?.accounts?.work?.voice?.realtime?.providers?.openai?.apiKey).toEqual(
        envRef("TEST_TTS_DISCORD_WORK_REALTIME"),
      );
      expect(inactivePaths).toContain(
        "channels.discord.accounts.work.voice.realtime.providers.openai.apiKey",
      );
      expect(snapshot.degradedOwners).toEqual([]);
    },
  );

  it("treats Discord voice TTS refs as inactive when voice is disabled", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        channels: {
          discord: {
            voice: voiceTts("MISSING_DISCORD_VOICE_TTS_OPENAI", { enabled: false }),
            accounts: {
              work: {
                enabled: true,
                voice: voiceTts("MISSING_DISCORD_WORK_VOICE_TTS_OPENAI", { enabled: false }),
              },
            },
          },
        },
      }),
      env: {},
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () => loadAuthStoreWithProfiles({}),
    });

    expect(snapshot.config.channels?.discord?.voice?.tts?.providers?.openai?.apiKey).toEqual(
      envRef("MISSING_DISCORD_VOICE_TTS_OPENAI"),
    );
    expect(
      snapshot.config.channels?.discord?.accounts?.work?.voice?.tts?.providers?.openai?.apiKey,
    ).toEqual(envRef("MISSING_DISCORD_WORK_VOICE_TTS_OPENAI"));
    const warningPaths = snapshot.warnings.map((warning) => warning.path);
    expect(warningPaths).toContain("channels.discord.voice.tts.providers.openai.apiKey");
    expect(warningPaths).toContain(
      "channels.discord.accounts.work.voice.tts.providers.openai.apiKey",
    );
  });

  it("handles Discord nested inheritance for enabled and disabled accounts", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        channels: {
          discord: {
            voice: voiceTts("DISCORD_BASE_TTS_OPENAI"),
            pluralkit: {
              token: envRef("DISCORD_BASE_PK_TOKEN"),
            },
            accounts: {
              enabledInherited: {
                enabled: true,
              },
              enabledOverride: {
                enabled: true,
                voice: voiceTts("DISCORD_ENABLED_OVERRIDE_TTS_OPENAI"),
              },
              disabledOverride: {
                enabled: false,
                voice: voiceTts("DISCORD_DISABLED_OVERRIDE_TTS_OPENAI"),
                pluralkit: {
                  token: envRef("DISCORD_DISABLED_OVERRIDE_PK_TOKEN"),
                },
              },
            },
          },
        },
      }),
      env: {
        DISCORD_BASE_TTS_OPENAI: "base-tts-openai",
        DISCORD_BASE_PK_TOKEN: "base-pk-token",
        DISCORD_ENABLED_OVERRIDE_TTS_OPENAI: "enabled-override-tts-openai",
      },
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () => loadAuthStoreWithProfiles({}),
    });

    expect(snapshot.config.channels?.discord?.voice?.tts?.providers?.openai?.apiKey).toBe(
      "base-tts-openai",
    );
    expect(snapshot.config.channels?.discord?.pluralkit?.token).toBe("base-pk-token");
    expect(
      snapshot.config.channels?.discord?.accounts?.enabledOverride?.voice?.tts?.providers?.openai
        ?.apiKey,
    ).toBe("enabled-override-tts-openai");
    expect(
      snapshot.config.channels?.discord?.accounts?.disabledOverride?.voice?.tts?.providers?.openai
        ?.apiKey,
    ).toEqual(envRef("DISCORD_DISABLED_OVERRIDE_TTS_OPENAI"));
    expect(snapshot.config.channels?.discord?.accounts?.disabledOverride?.pluralkit?.token).toEqual(
      envRef("DISCORD_DISABLED_OVERRIDE_PK_TOKEN"),
    );
    const warningPaths = snapshot.warnings.map((warning) => warning.path);
    expect(warningPaths).toContain(
      "channels.discord.accounts.disabledOverride.voice.tts.providers.openai.apiKey",
    );
    expect(warningPaths).toContain("channels.discord.accounts.disabledOverride.pluralkit.token");
  });

  it("skips top-level Discord voice refs when all enabled accounts override nested voice config", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        channels: {
          discord: {
            voice: voiceTts("DISCORD_UNUSED_BASE_TTS_OPENAI"),
            accounts: {
              enabledOverride: {
                enabled: true,
                voice: voiceTts("DISCORD_ENABLED_ONLY_TTS_OPENAI"),
              },
              disabledInherited: {
                enabled: false,
              },
            },
          },
        },
      }),
      env: {
        DISCORD_ENABLED_ONLY_TTS_OPENAI: "enabled-only-tts-openai",
      },
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () => loadAuthStoreWithProfiles({}),
    });

    expect(
      snapshot.config.channels?.discord?.accounts?.enabledOverride?.voice?.tts?.providers?.openai
        ?.apiKey,
    ).toBe("enabled-only-tts-openai");
    expect(snapshot.config.channels?.discord?.voice?.tts?.providers?.openai?.apiKey).toEqual(
      envRef("DISCORD_UNUSED_BASE_TTS_OPENAI"),
    );
    expect(snapshot.warnings.map((warning) => warning.path)).toContain(
      "channels.discord.voice.tts.providers.openai.apiKey",
    );
  });

  it("degrades an enabled Discord account override with an unresolved nested TTS ref", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        channels: {
          discord: {
            voice: voiceTts("DISCORD_BASE_TTS_OK"),
            accounts: {
              enabledOverride: {
                enabled: true,
                voice: voiceTts("DISCORD_ENABLED_OVERRIDE_TTS_MISSING"),
              },
            },
          },
        },
      }),
      env: {
        DISCORD_BASE_TTS_OK: "base-tts-openai",
      },
      allowUnavailableSecretOwners: true,
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () => loadAuthStoreWithProfiles({}),
    });

    expect(snapshot.config.channels?.discord?.voice?.tts?.providers?.openai?.apiKey).toEqual(
      envRef("DISCORD_BASE_TTS_OK"),
    );
    expect(
      snapshot.config.channels?.discord?.accounts?.enabledOverride?.voice?.tts?.providers?.openai
        ?.apiKey,
    ).toEqual(envRef("DISCORD_ENABLED_OVERRIDE_TTS_MISSING"));
    expect(snapshot.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "SECRETS_OWNER_UNAVAILABLE",
          path: "channels.discord.accounts.enabledOverride.voice.tts.providers.openai.apiKey",
        }),
      ]),
    );
    const ownerWarning = snapshot.warnings.find(
      (warning) => warning.code === "SECRETS_OWNER_UNAVAILABLE",
    );
    expect(ownerWarning?.message).toContain("secret reference was not found");
  });
});
