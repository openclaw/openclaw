/** Tests runtime SecretRef resolution across core config and auth-profile surfaces. */
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.ts";
import { redactSensitiveText } from "../logging/redact.js";
import { resetSecretRedactionRegistryForTest } from "../logging/secret-redaction-registry.test-support.js";
import { asConfig, setupSecretsRuntimeSnapshotTestHooks } from "./runtime.test-support.ts";

const EMPTY_LOADABLE_PLUGIN_ORIGINS = new Map();
const BUNDLED_CODEX_PLUGIN_ORIGINS = new Map([["codex", "bundled" as const]]);
const { prepareSecretsRuntimeSnapshot } = setupSecretsRuntimeSnapshotTestHooks();
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const APP_REF = {
  source: "env",
  provider: "default",
  id: "CODEX_APP_SERVER_TOKEN",
} as const;

afterEach(() => {
  resetSecretRedactionRegistryForTest();
});

const TTS_REF = {
  source: "env",
  provider: "default",
  id: "ELEVENLABS_API_KEY",
} as const;

function expectWarning(
  snapshot: Awaited<ReturnType<typeof prepareSecretsRuntimeSnapshot>>,
  expected: { code: string; path: string },
): void {
  const warning = snapshot.warnings.find(
    (entry) => entry.code === expected.code && entry.path === expected.path,
  );
  if (!warning) {
    throw new Error(`Expected warning ${expected.code} ${expected.path}`);
  }
}

describe("secrets runtime snapshot", () => {
  it("registers required and optional resolved values for exact redaction", async () => {
    const reqSecret = "test-req-secret";
    const optSecret = "test-opt-secret";
    await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        talk: {
          apiKey: { source: "env", provider: "default", id: "TALK_API_KEY" },
        },
        messages: {
          tts: {
            providers: {
              elevenlabs: {
                apiKey: TTS_REF,
              },
            },
          },
        },
      }),
      env: {
        TALK_API_KEY: reqSecret,
        ELEVENLABS_API_KEY: optSecret,
      },
      includeAuthStoreRefs: false,
      loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
    });

    expect(redactSensitiveText(`resolved ${reqSecret}`, { mode: "off" })).toBe(
      "resolved test-r…cret",
    );
    expect(redactSensitiveText(`resolved ${optSecret}`, { mode: "off" })).toBe(
      "resolved test-o…cret",
    );
  });

  it("resolves sandbox ssh secret refs for active ssh backends", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        agents: {
          defaults: {
            sandbox: {
              mode: "all",
              backend: "ssh",
              ssh: {
                target: "peter@example.com:22",
                identityData: { source: "env", provider: "default", id: "SSH_IDENTITY_DATA" },
                certificateData: {
                  source: "env",
                  provider: "default",
                  id: "SSH_CERTIFICATE_DATA",
                },
                knownHostsData: {
                  source: "env",
                  provider: "default",
                  id: "SSH_KNOWN_HOSTS_DATA",
                },
              },
            },
          },
        },
      }),
      env: {
        SSH_IDENTITY_DATA: "PRIVATE KEY",
        SSH_CERTIFICATE_DATA: "SSH CERT",
        SSH_KNOWN_HOSTS_DATA: "example.com ssh-ed25519 AAAATEST",
      },
      includeAuthStoreRefs: false,
      loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
    });

    const ssh = snapshot.config.agents?.defaults?.sandbox?.ssh;
    expect(ssh?.identityData).toBe("PRIVATE KEY");
    expect(ssh?.certificateData).toBe("SSH CERT");
    expect(ssh?.knownHostsData).toBe("example.com ssh-ed25519 AAAATEST");
  });

  it("treats sandbox ssh secret refs as inactive when ssh backend is not selected", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        agents: {
          defaults: {
            sandbox: {
              mode: "all",
              backend: "docker",
              ssh: {
                identityData: { source: "env", provider: "default", id: "SSH_IDENTITY_DATA" },
              },
            },
          },
        },
      }),
      env: {},
      includeAuthStoreRefs: false,
      loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
    });

    expect(snapshot.config.agents?.defaults?.sandbox?.ssh?.identityData).toEqual({
      source: "env",
      provider: "default",
      id: "SSH_IDENTITY_DATA",
    });
    expectWarning(snapshot, {
      code: "SECRETS_REF_IGNORED_INACTIVE_SURFACE",
      path: "agents.defaults.sandbox.ssh.identityData",
    });
  });

  it("resolves active bundled Codex app-server plugin SecretRefs", async () => {
    const authToken = "redacted";
    const sessToken = "redacted";
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        plugins: {
          entries: {
            codex: {
              enabled: true,
              config: {
                appServer: {
                  transport: "websocket",
                  url: "wss://codex-app-server.example.internal/ws",
                  authToken: APP_REF,
                  headers: {
                    Authorization: "Bearer literal-token",
                    "x-codex-client-session-token": "${CODEX_CLIENT_SESSION_TOKEN}",
                  },
                },
              },
            },
          },
        },
      }),
      env: {
        CODEX_APP_SERVER_TOKEN: authToken,
        CODEX_CLIENT_SESSION_TOKEN: sessToken,
      },
      includeAuthStoreRefs: false,
      loadablePluginOrigins: BUNDLED_CODEX_PLUGIN_ORIGINS,
    });

    expect(snapshot.config.plugins?.entries?.codex?.config).toMatchObject({
      appServer: {
        authToken,
        headers: {
          Authorization: "Bearer literal-token",
          "x-codex-client-session-token": sessToken,
        },
      },
    });
  });

  it("fails active bundled Codex app-server plugin SecretRefs when env is missing", async () => {
    await expect(
      prepareSecretsRuntimeSnapshot({
        config: asConfig({
          plugins: {
            entries: {
              codex: {
                enabled: true,
                config: {
                  appServer: {
                    transport: "websocket",
                    url: "wss://codex-app-server.example.internal/ws",
                    authToken: APP_REF,
                    headers: {
                      "x-codex-client-session-token": "${CODEX_CLIENT_SESSION_TOKEN}",
                    },
                  },
                },
              },
            },
          },
        }),
        env: {
          CODEX_CLIENT_SESSION_TOKEN: "test-codex-client-session-token",
        },
        includeAuthStoreRefs: false,
        loadablePluginOrigins: BUNDLED_CODEX_PLUGIN_ORIGINS,
      }),
    ).rejects.toThrow('Environment variable "CODEX_APP_SERVER_TOKEN" is missing or empty.');
  });

  it("fails closed for missing optional TTS SecretRefs by default", async () => {
    await expect(
      prepareSecretsRuntimeSnapshot({
        config: asConfig({
          messages: {
            tts: {
              providers: {
                elevenlabs: {
                  apiKey: TTS_REF,
                },
              },
            },
          },
        }),
        env: {},
        includeAuthStoreRefs: false,
        loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
      }),
    ).rejects.toThrow('Environment variable "ELEVENLABS_API_KEY" is missing or empty.');
  });

  it("degrades optional TTS provider SecretRefs when cold-start policy is enabled", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        messages: {
          tts: {
            providers: {
              elevenlabs: {
                apiKey: TTS_REF,
              },
            },
          },
        },
      }),
      env: {},
      includeAuthStoreRefs: false,
      allowUnavailableOptionalSecrets: true,
      loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
    });

    expect(snapshot.config.messages?.tts?.providers?.elevenlabs?.apiKey).toBeUndefined();
    expectWarning(snapshot, {
      code: "SECRETS_REF_UNAVAILABLE_OPTIONAL",
      path: "messages.tts.providers.elevenlabs.apiKey",
    });
    expect(snapshot.warnings[0]?.message).toContain(
      'Environment variable "ELEVENLABS_API_KEY" is missing or empty.',
    );
  });

  it("degrades optional TTS provider SecretRefs when a file value is absent", async () => {
    if (process.platform === "win32") {
      return;
    }
    const root = tempDirs.make("openclaw-tts-secretref-missing-");
    const secretsPath = path.join(root, "secrets.json");
    await fs.writeFile(secretsPath, JSON.stringify({ providers: {} }, null, 2), "utf8");
    await fs.chmod(secretsPath, 0o600);

    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        secrets: {
          providers: {
            ttsfile: {
              source: "file",
              path: secretsPath,
              mode: "json",
            },
          },
        },
        messages: {
          tts: {
            providers: {
              elevenlabs: {
                apiKey: {
                  source: "file",
                  provider: "ttsfile",
                  id: "/providers/elevenlabs/apiKey",
                },
              },
            },
          },
        },
      }),
      env: {},
      includeAuthStoreRefs: false,
      allowUnavailableOptionalSecrets: true,
      loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
    });

    expect(snapshot.config.messages?.tts?.providers?.elevenlabs?.apiKey).toBeUndefined();
    expectWarning(snapshot, {
      code: "SECRETS_REF_UNAVAILABLE_OPTIONAL",
      path: "messages.tts.providers.elevenlabs.apiKey",
    });
    expect(snapshot.warnings[0]?.message).toContain(
      'JSON pointer segment "elevenlabs" does not exist.',
    );
  });

  it("keeps optional TTS SecretRef provider policy failures fail-closed", async () => {
    await expect(
      prepareSecretsRuntimeSnapshot({
        config: asConfig({
          secrets: {
            providers: {
              default: {
                source: "env",
                allowlist: ["OTHER_API_KEY"],
              },
            },
          },
          messages: {
            tts: {
              providers: {
                elevenlabs: {
                  apiKey: TTS_REF,
                },
              },
            },
          },
        }),
        env: {
          ELEVENLABS_API_KEY: "test-elevenlabs-api-key",
        },
        includeAuthStoreRefs: false,
        allowUnavailableOptionalSecrets: true,
        loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
      }),
    ).rejects.toThrow(
      'Environment variable "ELEVENLABS_API_KEY" is not allowlisted in secrets.providers.default.allowlist.',
    );
  });

  it("keeps invalid optional TTS SecretRef ids fail-closed", async () => {
    await expect(
      prepareSecretsRuntimeSnapshot({
        config: asConfig({
          messages: {
            tts: {
              providers: {
                elevenlabs: {
                  apiKey: { source: "env", provider: "default", id: "elevenlabs_api_key" },
                },
              },
            },
          },
        }),
        env: {
          elevenlabs_api_key: "test-elevenlabs-api-key",
        },
        includeAuthStoreRefs: false,
        allowUnavailableOptionalSecrets: true,
        loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
      }),
    ).rejects.toThrow("Env secret reference id must match");
  });

  it("keeps optional TTS SecretRefs that resolve to non-strings fail-closed", async () => {
    if (process.platform === "win32") {
      return;
    }
    const root = tempDirs.make("openclaw-tts-secretref-object-");
    const secretsPath = path.join(root, "secrets.json");
    await fs.writeFile(
      secretsPath,
      JSON.stringify(
        {
          providers: {
            elevenlabs: {
              apiKey: { value: "not-a-string" },
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    await fs.chmod(secretsPath, 0o600);

    await expect(
      prepareSecretsRuntimeSnapshot({
        config: asConfig({
          secrets: {
            providers: {
              ttsfile: {
                source: "file",
                path: secretsPath,
                mode: "json",
              },
            },
          },
          messages: {
            tts: {
              providers: {
                elevenlabs: {
                  apiKey: {
                    source: "file",
                    provider: "ttsfile",
                    id: "/providers/elevenlabs/apiKey",
                  },
                },
              },
            },
          },
        }),
        env: {},
        includeAuthStoreRefs: false,
        allowUnavailableOptionalSecrets: true,
        loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
      }),
    ).rejects.toThrow(
      "messages.tts.providers.elevenlabs.apiKey resolved to a non-string or empty value.",
    );
  });

  it("still fails required gateway auth SecretRefs when env is missing", async () => {
    await expect(
      prepareSecretsRuntimeSnapshot({
        config: asConfig({
          gateway: {
            auth: {
              mode: "token",
              token: { source: "env", provider: "default", id: "GATEWAY_TOKEN_REF" },
            },
          },
        }),
        env: {},
        includeAuthStoreRefs: false,
        loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
      }),
    ).rejects.toThrow('Environment variable "GATEWAY_TOKEN_REF" is missing or empty.');
  });

  it("fails when an active exec ref id contains traversal segments", async () => {
    await expect(
      prepareSecretsRuntimeSnapshot({
        config: asConfig({
          talk: {
            apiKey: { source: "exec", provider: "vault", id: "a/../b" },
          },
          secrets: {
            providers: {
              vault: {
                source: "exec",
                command: process.execPath,
              },
            },
          },
        }),
        env: {},
        includeAuthStoreRefs: false,
        agentDirs: ["/tmp/openclaw-agent-main"],
        loadAuthStore: () => ({ version: 1, profiles: {} }),
        loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
      }),
    ).rejects.toThrow(/must not include "\." or "\.\." path segments/i);
  });
});
