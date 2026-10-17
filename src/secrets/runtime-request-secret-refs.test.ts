/** Tests request-scoped secret ref resolution for runtime operations. */
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { setRuntimeAuthProfileStoreSnapshot } from "../agents/auth-profiles/runtime-snapshots.js";
import { getRuntimeConfigSnapshotRefreshHandler } from "../config/runtime-snapshot.js";
import { activateSecretsRuntimeSnapshot, getActiveSecretsRuntimeSnapshot } from "./runtime.js";
import {
  asConfig,
  loadAuthStoreWithProfiles,
  setupSecretsRuntimeSnapshotTestHooks,
} from "./runtime.test-support.ts";

const { prepareSecretsRuntimeSnapshot } = setupSecretsRuntimeSnapshotTestHooks();
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function envRef(id: string) {
  return { source: "env", provider: "default", id } as const;
}

function prepareSnapshot(
  config: unknown,
  options: Omit<Parameters<typeof prepareSecretsRuntimeSnapshot>[0], "config"> = {},
) {
  return prepareSecretsRuntimeSnapshot({
    agentDirs: ["/tmp/openclaw-agent-main"],
    loadAuthStore: () => ({ version: 1, profiles: {} }),
    ...options,
    config: asConfig(config),
  });
}

function bearer(token: ReturnType<typeof envRef>) {
  return { mode: "authorization-bearer", token } as const;
}

function proxy(ca: ReturnType<typeof envRef>) {
  return { mode: "explicit-proxy", url: "http://proxy.example:8080", tls: { ca } } as const;
}

describe("secrets runtime snapshot request secret refs", () => {
  it("refreshes the current roster without retaining removed agents or losing explicit stores", async () => {
    const stateDir = tempDirs.make("openclaw-refresh-roster-");
    const explicitDir = path.join(stateDir, "explicit");
    const departingDir = path.join(stateDir, "agents", "departing", "agent");
    const config = asConfig({ agents: { entries: { main: {}, departing: {} } } });
    const loadAuthStore = vi.fn(() => loadAuthStoreWithProfiles({}));
    activateSecretsRuntimeSnapshot(
      await prepareSnapshot(config, {
        env: { OPENCLAW_STATE_DIR: stateDir },
        agentDirs: [explicitDir],
        loadAuthStore,
      }),
    );
    const refresh = getRuntimeConfigSnapshotRefreshHandler()!;
    await expect(refresh.refresh({ sourceConfig: config })).resolves.toBe(true);
    expect(loadAuthStore).toHaveBeenCalledWith(departingDir);
    loadAuthStore.mockClear();

    const sourceConfig = asConfig({ agents: { entries: { main: {} } } });
    const preflightResult = await refresh.preflight!({ sourceConfig });
    await expect(refresh.refresh({ sourceConfig, preflightResult })).resolves.toBe(true);
    expect(loadAuthStore).toHaveBeenCalledWith(explicitDir);
    expect(loadAuthStore).not.toHaveBeenCalledWith(departingDir);
  });

  it("can skip auth-profile SecretRef resolution during active runtime refresh", async () => {
    const initialEnvVar = `OPENCLAW_INITIAL_AUTH_PROFILE_SECRET_${Date.now()}`;
    const missingEnvVar = `OPENCLAW_MISSING_AUTH_PROFILE_SECRET_${Date.now()}`;
    delete process.env[missingEnvVar];

    let useMissingProfileRef = false;
    let loadAuthStoreCalls = 0;
    const loadAuthStore = () => {
      loadAuthStoreCalls += 1;
      return loadAuthStoreWithProfiles({
        "custom:token": {
          type: "token",
          provider: "custom",
          tokenRef: envRef(useMissingProfileRef ? missingEnvVar : initialEnvVar),
        },
      });
    };

    const snapshot = await prepareSnapshot(
      {},
      {
        env: { [initialEnvVar]: "sk-initial" },
        loadAuthStore,
      },
    );
    activateSecretsRuntimeSnapshot(snapshot);
    expect(loadAuthStoreCalls).toBe(1);
    setRuntimeAuthProfileStoreSnapshot(
      loadAuthStoreWithProfiles({
        "custom:token": { type: "token", provider: "custom", token: "sk-live" },
      }),
      "/tmp/openclaw-agent-main",
    );

    useMissingProfileRef = true;
    const refreshHandler = getRuntimeConfigSnapshotRefreshHandler();
    if (!refreshHandler) {
      throw new Error("Expected active runtime refresh handler");
    }
    await expect(
      refreshHandler.refresh({
        sourceConfig: asConfig({ gateway: { port: 19001 } }),
        includeAuthStoreRefs: false,
      }),
    ).resolves.toBe(true);
    expect(loadAuthStoreCalls).toBe(1);
    const profile = getActiveSecretsRuntimeSnapshot()?.authStores[0]?.store.profiles[
      "custom:token"
    ] as { token?: string } | undefined;
    expect(profile?.token).toBe("sk-live");
  });

  it.skipIf(process.platform === "win32")(
    "reuses preflighted exec SecretRef snapshots during active runtime refresh",
    async () => {
      const root = tempDirs.make("openclaw-runtime-exec-preflight-");
      const execLogPath = path.join(root, "exec-calls.log");
      const execScriptPath = path.join(root, "resolver.sh");
      await fs.writeFile(
        execScriptPath,
        [
          "#!/bin/sh",
          `printf 'x\\n' >> ${JSON.stringify(execLogPath)}`,
          "cat >/dev/null",
          'printf \'{"protocolVersion":1,"values":{"gateway/token":"exec-gateway-token"}}\'',
        ].join("\n"),
        { encoding: "utf8", mode: 0o700 },
      );
      await fs.chmod(execScriptPath, 0o700);

      const config = asConfig({
        secrets: {
          providers: {
            execmain: {
              source: "exec",
              command: execScriptPath,
              jsonOnly: true,
              timeoutMs: 20_000,
              noOutputTimeoutMs: 10_000,
            },
          },
        },
        gateway: {
          auth: {
            mode: "token",
            token: { source: "exec", provider: "execmain", id: "gateway/token" },
          },
        },
      });
      const snapshot = await prepareSnapshot(config, {
        agentDirs: [path.join(root, "agent")],
      });
      activateSecretsRuntimeSnapshot(snapshot);
      await fs.writeFile(execLogPath, "", "utf8");

      const refreshHandler = getRuntimeConfigSnapshotRefreshHandler();
      if (!refreshHandler?.preflight) {
        throw new Error("Expected active runtime refresh preflight handler");
      }
      const preflightResult = await refreshHandler.preflight({ sourceConfig: config });
      await expect(refreshHandler.refresh({ sourceConfig: config, preflightResult })).resolves.toBe(
        true,
      );

      const execCalls = (await fs.readFile(execLogPath, "utf8")).split("\n").filter(Boolean);
      expect(execCalls).toHaveLength(1);
      expect(getActiveSecretsRuntimeSnapshot()?.config.gateway?.auth?.token).toBe(
        "exec-gateway-token",
      );
    },
  );

  it("resolves model provider request secret refs for headers, auth, and tls material", async () => {
    const config = asConfig({
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            request: {
              headers: { "X-Tenant": envRef("OPENAI_PROVIDER_TENANT") },
              auth: bearer(envRef("OPENAI_PROVIDER_TOKEN")),
              proxy: proxy(envRef("OPENAI_PROVIDER_PROXY_CA")),
              tls: {
                cert: envRef("OPENAI_PROVIDER_CERT"),
                key: envRef("OPENAI_PROVIDER_KEY"),
              },
            },
            models: [],
          },
        },
      },
    });

    const snapshot = await prepareSnapshot(config, {
      env: {
        OPENAI_PROVIDER_TENANT: "tenant-acme",
        OPENAI_PROVIDER_TOKEN: "sk-provider-runtime", // pragma: allowlist secret
        OPENAI_PROVIDER_PROXY_CA: "proxy-ca",
        OPENAI_PROVIDER_CERT: "client-cert",
        OPENAI_PROVIDER_KEY: "client-key",
      },
    });

    expect(snapshot.config.models?.providers?.openai?.request).toEqual({
      headers: { "X-Tenant": "tenant-acme" },
      auth: { mode: "authorization-bearer", token: "sk-provider-runtime" },
      proxy: {
        mode: "explicit-proxy",
        url: "http://proxy.example:8080",
        tls: { ca: "proxy-ca" },
      },
      tls: { cert: "client-cert", key: "client-key" },
    });
  });

  it("resolves media request secret refs for provider headers, auth, and tls material", async () => {
    const snapshot = await prepareSnapshot(
      {
        tools: {
          media: {
            models: [
              {
                provider: "openai",
                model: "gpt-4o-mini-transcribe",
                capabilities: ["audio"],
                request: {
                  headers: { "X-Shared-Tenant": envRef("MEDIA_SHARED_TENANT") },
                  auth: {
                    mode: "header",
                    headerName: "x-shared-key",
                    value: envRef("MEDIA_SHARED_MODEL_KEY"),
                  },
                },
              },
              {
                provider: "deepgram",
                capabilities: ["audio"],
                request: {
                  auth: {
                    mode: "header",
                    headerName: "x-api-key",
                    value: envRef("MEDIA_AUDIO_MODEL_KEY"),
                  },
                  proxy: proxy(envRef("MEDIA_AUDIO_PROXY_CA")),
                },
              },
            ],
            audio: {
              enabled: true,
              request: {
                headers: { "X-Tenant": envRef("MEDIA_AUDIO_TENANT") },
                auth: bearer(envRef("MEDIA_AUDIO_TOKEN")),
                tls: { cert: envRef("MEDIA_AUDIO_CERT") },
              },
            },
          },
        },
      },
      {
        env: {
          MEDIA_SHARED_TENANT: "tenant-shared",
          MEDIA_SHARED_MODEL_KEY: "shared-model-key", // pragma: allowlist secret
          MEDIA_AUDIO_TENANT: "tenant-acme",
          MEDIA_AUDIO_TOKEN: "audio-token", // pragma: allowlist secret
          MEDIA_AUDIO_CERT: "client-cert",
          MEDIA_AUDIO_MODEL_KEY: "model-key", // pragma: allowlist secret
          MEDIA_AUDIO_PROXY_CA: "proxy-ca",
        },
      },
    );

    expect(snapshot.config.tools?.media?.audio?.request?.headers?.["X-Tenant"]).toBe("tenant-acme");
    expect(snapshot.config.tools?.media?.audio?.request?.auth).toEqual({
      mode: "authorization-bearer",
      token: "audio-token",
    });
    expect(snapshot.config.tools?.media?.audio?.request?.tls).toEqual({ cert: "client-cert" });
    expect(snapshot.config.tools?.media?.models?.[0]?.request).toEqual({
      headers: { "X-Shared-Tenant": "tenant-shared" },
      auth: { mode: "header", headerName: "x-shared-key", value: "shared-model-key" },
    });
    expect(snapshot.config.tools?.media?.models?.[1]?.request).toEqual({
      auth: { mode: "header", headerName: "x-api-key", value: "model-key" },
      proxy: {
        mode: "explicit-proxy",
        url: "http://proxy.example:8080",
        tls: { ca: "proxy-ca" },
      },
    });
  });
});
