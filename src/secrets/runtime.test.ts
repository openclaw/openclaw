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

const CODEX_APP_SERVER_TOKEN_REF = {
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
  it("registers every resolved value for exact redaction", async () => {
    const secret = "runtime-registration-secret";
    await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        talk: {
          apiKey: { source: "env", provider: "default", id: "TALK_API_KEY" },
        },
      }),
      env: { TALK_API_KEY: secret },
      includeAuthStoreRefs: false,
      loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
    });

    expect(redactSensitiveText(`resolved ${secret}`, { mode: "off" })).toBe("resolved runtim…cret");
  });

  it("registers resolved TTS values for exact redaction", async () => {
    const secret = "test-secret";
    await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        messages: {
          tts: { providers: { elevenlabs: { apiKey: TTS_REF } } },
        },
      }),
      env: { ELEVENLABS_API_KEY: secret },
      includeAuthStoreRefs: false,
      loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
    });

    expect(redactSensitiveText(`resolved ${secret}`, { mode: "off" })).toBe("resolved ***");
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
                  authToken: CODEX_APP_SERVER_TOKEN_REF,
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
        CODEX_APP_SERVER_TOKEN: "resolved-app-server-token",
        CODEX_CLIENT_SESSION_TOKEN: "resolved-session-token",
      },
      includeAuthStoreRefs: false,
      loadablePluginOrigins: BUNDLED_CODEX_PLUGIN_ORIGINS,
    });

    expect(snapshot.config.plugins?.entries?.codex?.config).toMatchObject({
      appServer: {
        authToken: "resolved-app-server-token",
        headers: {
          Authorization: "Bearer literal-token",
          "x-codex-client-session-token": "resolved-session-token",
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
                    authToken: CODEX_APP_SERVER_TOKEN_REF,
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
          CODEX_CLIENT_SESSION_TOKEN: "resolved-session-token",
        },
        includeAuthStoreRefs: false,
        loadablePluginOrigins: BUNDLED_CODEX_PLUGIN_ORIGINS,
      }),
    ).rejects.toThrow('Environment variable "CODEX_APP_SERVER_TOKEN" is missing or empty.');
  });

  it("fails closed for missing TTS SecretRefs outside cold-start isolation", async () => {
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

  it("isolates the TTS owner when its SecretRef is missing during cold startup", async () => {
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
      allowUnavailableSecretOwners: true,
      loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
    });

    expect(snapshot.config.messages?.tts?.providers?.elevenlabs?.apiKey).toEqual(TTS_REF);
    expectWarning(snapshot, {
      code: "SECRETS_OWNER_UNAVAILABLE",
      path: "messages.tts.providers.elevenlabs.apiKey",
    });
    expect(snapshot.degradedOwners).toMatchObject([
      {
        ownerKind: "capability",
        ownerId: "tts",
        state: "unavailable",
        paths: ["messages.tts.providers.elevenlabs.apiKey"],
        reason: "secret reference was not found",
      },
    ]);
    expect(snapshot.warnings[0]?.message).not.toContain("ELEVENLABS_API_KEY");
  });

  it("isolates the TTS owner when a file value is absent", async () => {
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
      allowUnavailableSecretOwners: true,
      loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
    });

    expect(snapshot.config.messages?.tts?.providers?.elevenlabs?.apiKey).toEqual({
      source: "file",
      provider: "ttsfile",
      id: "/providers/elevenlabs/apiKey",
    });
    expectWarning(snapshot, {
      code: "SECRETS_OWNER_UNAVAILABLE",
      path: "messages.tts.providers.elevenlabs.apiKey",
    });
    expect(snapshot.warnings[0]?.message).toContain("secret reference was not found");
  });

  it("isolates known owners after provider policy failures", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
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
      allowUnavailableSecretOwners: true,
      loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
    });
    expect(snapshot.degradedOwners).toMatchObject([
      {
        ownerKind: "capability",
        ownerId: "tts",
        reason: "secret provider policy denied resolution",
      },
    ]);
  });

  it("reuses provider-scoped failures across isolated owners", async () => {
    if (process.platform === "win32") {
      return;
    }
    const root = tempDirs.make("openclaw-owner-secret-provider-failure-");
    const callLogPath = path.join(root, "calls.log");
    const commandPath = path.join(root, "provider.sh");
    await fs.writeFile(
      commandPath,
      `#!/bin/sh\nprintf 'call\\n' >> ${JSON.stringify(callLogPath)}\nexit 1\n`,
      { encoding: "utf8", mode: 0o700 },
    );
    const input = {
      modelRef: { source: "exec" as const, provider: "shared", id: "models/openai" },
      ttsRef: { source: "exec" as const, provider: "shared", id: "tts/elevenlabs" },
    };

    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        secrets: {
          providers: {
            shared: { source: "exec", command: commandPath, passEnv: ["PATH"] },
          },
        },
        models: {
          providers: {
            openai: {
              baseUrl: "https://api.openai.com/v1",
              apiKey: input.modelRef,
              models: [],
            },
          },
        },
        messages: {
          tts: { providers: { elevenlabs: { apiKey: input.ttsRef } } },
        },
      }),
      env: { PATH: process.env.PATH ?? "" },
      includeAuthStoreRefs: false,
      allowUnavailableSecretOwners: true,
      loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
    });

    expect(snapshot.config.models?.providers?.openai?.apiKey).toEqual(input.modelRef);
    expect(snapshot.config.messages?.tts?.providers?.elevenlabs?.apiKey).toEqual(input.ttsRef);
    expect(snapshot.degradedOwners).toMatchObject([
      { ownerKind: "provider", ownerId: "openai", reason: "secret provider failed" },
      { ownerKind: "capability", ownerId: "tts", reason: "secret provider failed" },
    ]);
    expect((await fs.readFile(callLogPath, "utf8")).trim().split("\n")).toHaveLength(1);
  });

  it("keeps invalid TTS SecretRef ids fail-closed", async () => {
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
        allowUnavailableSecretOwners: true,
        loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
      }),
    ).rejects.toThrow("Env secret reference id must match");
  });

  it("keeps provider resolution limit violations fail-closed", async () => {
    await expect(
      prepareSecretsRuntimeSnapshot({
        config: asConfig({
          secrets: {
            resolution: { maxRefsPerProvider: 1 },
          },
          models: {
            providers: {
              openai: {
                apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
                baseUrl: "https://api.openai.com/v1",
                models: [],
              },
            },
          },
          messages: {
            tts: {
              providers: {
                elevenlabs: { apiKey: TTS_REF },
              },
            },
          },
        }),
        env: {
          OPENAI_API_KEY: "test-openai-api-key",
          ELEVENLABS_API_KEY: "test-elevenlabs-api-key",
        },
        includeAuthStoreRefs: false,
        allowUnavailableSecretOwners: true,
        loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
      }),
    ).rejects.toThrow('Secret provider "default" exceeded maxRefsPerProvider (1).');
  });

  it("keeps unconfigured SecretRef provider aliases fail-closed", async () => {
    await expect(
      prepareSecretsRuntimeSnapshot({
        config: asConfig({
          messages: {
            tts: {
              providers: {
                elevenlabs: {
                  apiKey: { source: "env", provider: "missing", id: "ELEVENLABS_API_KEY" },
                },
              },
            },
          },
        }),
        env: {},
        includeAuthStoreRefs: false,
        allowUnavailableSecretOwners: true,
        loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
      }),
    ).rejects.toThrow('Secret provider "missing" is not configured');
  });

  it("keeps TTS SecretRefs that resolve to non-strings fail-closed", async () => {
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
        allowUnavailableSecretOwners: true,
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
        allowUnavailableSecretOwners: true,
        loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
      }),
    ).rejects.toThrow('Environment variable "GATEWAY_TOKEN_REF" is missing or empty.');
  });

  it("isolates an unavailable model provider without applying another credential source", async () => {
    const ref = { source: "env", provider: "default", id: "MISSING_PROVIDER_KEY" } as const;
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        models: {
          providers: {
            example: {
              apiKey: ref,
              baseUrl: "https://example.invalid/v1",
              models: [{ id: "example-model", name: "Example" }],
            },
          },
        },
      }),
      env: { EXAMPLE_API_KEY: "placeholder" },
      includeAuthStoreRefs: false,
      allowUnavailableSecretOwners: true,
      loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
    });

    expect(snapshot.config.models?.providers?.example?.apiKey).toEqual(ref);
    expect(snapshot.degradedOwners).toMatchObject([
      {
        ownerKind: "provider",
        ownerId: "example",
        state: "unavailable",
        paths: ["models.providers.example.apiKey"],
      },
    ]);
  });

  it("refuses cold-start isolation when an assignment owner is unknown", async () => {
    await expect(
      prepareSecretsRuntimeSnapshot({
        config: asConfig({
          cron: {
            webhookToken: { source: "env", provider: "default", id: "MISSING_WEBHOOK_TOKEN" },
          },
        }),
        env: {},
        includeAuthStoreRefs: false,
        allowUnavailableSecretOwners: true,
        loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
      }),
    ).rejects.toThrow('Environment variable "MISSING_WEBHOOK_TOKEN" is missing or empty.');
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
