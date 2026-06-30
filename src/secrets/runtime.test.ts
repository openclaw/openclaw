/** Tests runtime SecretRef resolution across core config and auth-profile surfaces. */
import { describe, expect, it } from "vitest";
import { asConfig, setupSecretsRuntimeSnapshotTestHooks } from "./runtime.test-support.ts";

const EMPTY_LOADABLE_PLUGIN_ORIGINS = new Map();
const BUNDLED_CODEX_PLUGIN_ORIGINS = new Map([["codex", "bundled" as const]]);
const { prepareSecretsRuntimeSnapshot } = setupSecretsRuntimeSnapshotTestHooks();

const CODEX_APP_SERVER_TOKEN_REF = {
  source: "env",
  provider: "default",
  id: "CODEX_APP_SERVER_TOKEN",
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
  it("resolves sandbox docker env secret refs for active docker backends", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        agents: {
          defaults: {
            sandbox: {
              mode: "all",
              backend: "docker",
              docker: {
                env: {
                  LANG: "C.UTF-8",
                  DATABASE_URL: { source: "env", provider: "default", id: "DATABASE_URL" },
                },
              },
            },
          },
          list: [
            {
              id: "worker",
              sandbox: {
                mode: "all",
                backend: "docker",
                docker: {
                  env: {
                    API_TOKEN: {
                      source: "env",
                      provider: "default",
                      id: "WORKER_API_TOKEN",
                    },
                  },
                },
              },
            },
          ],
        },
      }),
      env: {
        DATABASE_URL: "postgres://sandbox-db",
        WORKER_API_TOKEN: "worker-token",
      },
      includeAuthStoreRefs: false,
      loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
    });

    expect(snapshot.config.agents?.defaults?.sandbox?.docker?.env).toMatchObject({
      LANG: "C.UTF-8",
      DATABASE_URL: "postgres://sandbox-db",
    });
    expect(snapshot.config.agents?.list?.[0]?.sandbox?.docker?.env).toMatchObject({
      API_TOKEN: "worker-token",
    });
  });

  it("treats sandbox docker env secret refs as inactive when Docker sandbox is not selected", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        agents: {
          defaults: {
            sandbox: {
              mode: "off",
              backend: "docker",
              docker: {
                env: {
                  DATABASE_URL: { source: "env", provider: "default", id: "DATABASE_URL" },
                },
              },
            },
          },
          list: [
            {
              id: "worker",
              sandbox: {
                mode: "all",
                backend: "ssh",
                docker: {
                  env: {
                    API_TOKEN: {
                      source: "env",
                      provider: "default",
                      id: "WORKER_API_TOKEN",
                    },
                  },
                },
              },
            },
          ],
        },
      }),
      env: {},
      includeAuthStoreRefs: false,
      loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
    });

    expect(snapshot.config.agents?.defaults?.sandbox?.docker?.env?.DATABASE_URL).toEqual({
      source: "env",
      provider: "default",
      id: "DATABASE_URL",
    });
    expect(snapshot.config.agents?.list?.[0]?.sandbox?.docker?.env?.API_TOKEN).toEqual({
      source: "env",
      provider: "default",
      id: "WORKER_API_TOKEN",
    });
    expectWarning(snapshot, {
      code: "SECRETS_REF_IGNORED_INACTIVE_SURFACE",
      path: "agents.defaults.sandbox.docker.env.DATABASE_URL",
    });
    expectWarning(snapshot, {
      code: "SECRETS_REF_IGNORED_INACTIVE_SURFACE",
      path: "agents.list.0.sandbox.docker.env.API_TOKEN",
    });
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
