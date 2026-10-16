import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prepareSharedAuthStoreOwnership } from "../agents/auth-profiles/path-resolve.js";
import { noteRuntimeAuthProfileStorePersistedMutation } from "../agents/auth-profiles/runtime-snapshots.js";
import { resolveApiKeyForProviderCore } from "../agents/model-auth-provider.js";
import { getRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { streamSimple } from "../llm/stream.js";
import type { Model } from "../llm/types.js";
import {
  activateSecretsRuntimeSnapshot as activatePreparedSecretsRuntimeSnapshot,
  getActiveSecretsRuntimeSnapshot,
  preflightActiveSecretsRuntimeSnapshotRefresh,
  refreshActiveProviderAuthRuntimeSnapshot,
  refreshActiveSecretsRuntimeSnapshotForConfig,
} from "./runtime.js";
import { asConfig, setupSecretsRuntimeSnapshotTestHooks } from "./runtime.test-support.ts";

const storeMocks = vi.hoisted(() => ({
  readValue: vi.fn(),
}));

vi.mock("./store/secret-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./store/secret-store.js")>();
  return { ...actual, readSecretStoreValue: storeMocks.readValue };
});

const roots: string[] = [];
const { prepareSecretsRuntimeSnapshot } = setupSecretsRuntimeSnapshotTestHooks();

beforeEach(() => {
  storeMocks.readValue.mockReset().mockResolvedValue({
    ok: false,
    error: {
      code: "SECRET_STORE_NOT_FOUND",
      message: "Secret store entry was not found.",
    },
  });
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function waitForFile(filePath: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (
      await fs.stat(filePath).then(
        () => true,
        () => false,
      )
    ) {
      return;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  throw new Error("Timed out waiting for the synthetic provider barrier.");
}

async function waitForCondition(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  throw new Error("Timed out waiting for synthetic store resolution.");
}

describe("store SecretRef runtime degradation", () => {
  it("drops a stale config-refresh preflight cache after a newer secrets publication", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-config-refresh-race-"));
    roots.push(root);
    const config = (port: number) =>
      asConfig({
        gateway: { mode: "local", port },
        agents: { entries: { main: {} } },
        models: {
          providers: {
            synthetic: {
              baseUrl: "https://provider.example.invalid/v1",
              apiKey: { source: "store", provider: "default", id: "SYNTHETIC_API_KEY" },
              models: [],
            },
          },
        },
      });
    const env = { OPENCLAW_STATE_DIR: path.join(root, "state"), PATH: process.env.PATH ?? "" };
    const prepare = (nextConfig: ReturnType<typeof config>) =>
      prepareSecretsRuntimeSnapshot({
        config: nextConfig,
        env,
        agentDirs: [root],
        includeAuthStoreRefs: false,
        allowUnavailableSecretOwners: true,
        loadablePluginOrigins: new Map(),
      });
    let currentStoreValue = { ok: true as const, value: "synthetic-key-a" };
    storeMocks.readValue.mockImplementation(async () => currentStoreValue);

    activatePreparedSecretsRuntimeSnapshot(await prepare(config(18789)));
    const nextConfig = config(19001);
    const preflightResult = await preflightActiveSecretsRuntimeSnapshotRefresh({
      sourceConfig: nextConfig,
      includeAuthStoreRefs: false,
    });

    currentStoreValue = { ok: true, value: "synthetic-key-b" };
    activatePreparedSecretsRuntimeSnapshot(await prepare(nextConfig));
    await expect(
      refreshActiveSecretsRuntimeSnapshotForConfig({
        sourceConfig: nextConfig,
        includeAuthStoreRefs: false,
        preflightResult,
      }),
    ).resolves.toBe(true);

    const providerAuth = await resolveApiKeyForProviderCore({
      cfg: getRuntimeConfigSnapshot() ?? undefined,
      provider: "synthetic",
      agentDir: root,
      store: { version: 1, profiles: {} },
    });
    expect(providerAuth.apiKey).toBe("synthetic-key-b");
  });

  it.each(["config refresh", "provider auth refresh"] as const)(
    "bounds %s after repeated auth revisions while resolving an exec SecretRef once",
    async (refreshKind) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-secrets-refresh-conflicts-"));
      roots.push(root);
      const callLogPath = path.join(root, "exec-calls.log");
      const providerScript = [
        'const fs = require("node:fs");',
        "process.stdin.resume();",
        'process.stdin.on("end", () => {',
        `  fs.appendFileSync(${JSON.stringify(callLogPath)}, "call\\n");`,
        '  process.stdout.write(JSON.stringify({ protocolVersion: 1, values: { "models/synthetic": "synthetic-key" } }));',
        "});",
      ].join("\n");
      const config = (port: number) =>
        asConfig({
          gateway: { mode: "local", port },
          secrets: {
            providers: {
              vault: {
                source: "exec",
                command: process.execPath,
                args: ["-e", providerScript],
                passEnv: ["PATH"],
                timeoutMs: 5_000,
                noOutputTimeoutMs: 5_000,
              },
            },
          },
          models: {
            providers: {
              synthetic: {
                baseUrl: "https://provider.example.invalid/v1",
                apiKey: { source: "exec", provider: "vault", id: "models/synthetic" },
                models: [],
              },
            },
          },
        });
      const calls = async () =>
        (await fs.readFile(callLogPath, "utf8").catch(() => "")).split("\n").filter(Boolean).length;
      let revisionConflictsRemaining = 0;
      const loadAuthStore = () => {
        if (revisionConflictsRemaining > 0) {
          revisionConflictsRemaining -= 1;
          noteRuntimeAuthProfileStorePersistedMutation(undefined, {
            credentialsChanged: true,
            stateChanged: false,
            profileIds: [],
          });
        }
        return { version: 1, profiles: {} };
      };
      const initialConfig = config(18_789);
      const refreshConfig = config(19_001);
      const env = {
        PATH: process.env.PATH ?? "",
      };
      await prepareSharedAuthStoreOwnership();
      activatePreparedSecretsRuntimeSnapshot(
        await prepareSecretsRuntimeSnapshot({
          config: initialConfig,
          env,
          agentDirs: [root],
          includeAuthStoreRefs: true,
          loadAuthStore,
          loadablePluginOrigins: new Map(),
        }),
      );
      const initialCalls = await calls();
      revisionConflictsRemaining = 20;

      const refresh =
        refreshKind === "config refresh"
          ? refreshActiveSecretsRuntimeSnapshotForConfig({
              sourceConfig: refreshConfig,
              includeAuthStoreRefs: true,
            })
          : refreshActiveProviderAuthRuntimeSnapshot();
      await expect(refresh).rejects.toThrow(/could not activate after 4 attempts/);
      expect(revisionConflictsRemaining).toBeLessThanOrEqual(16);
      expect((await calls()) - initialCalls).toBe(1);
    },
  );

  it.each([
    {
      name: "rotation",
      latestValue: { ok: true as const, value: "synthetic-key-b" },
      expectedAuthorization: "Bearer synthetic-key-b",
    },
    {
      name: "removal",
      latestValue: {
        ok: false as const,
        error: {
          code: "SECRET_STORE_NOT_FOUND" as const,
          message: "Secret store entry was not found.",
        },
      },
      expectedAuthorization: undefined,
    },
  ])(
    "does not restore a superseded credential after a secrets reload completes during refresh ($name)",
    async ({ latestValue, expectedAuthorization }) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-store-refresh-race-"));
      roots.push(root);
      const providerStartedPath = path.join(root, "provider-started");
      const providerReleasePath = path.join(root, "provider-release");
      const providerScript = [
        'const fs = require("node:fs");',
        "const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));",
        "process.stdin.resume();",
        'process.stdin.on("end", async () => {',
        '  if (process.env.SYNTHETIC_PROVIDER_WAIT === "1") {',
        '    fs.writeFileSync(process.env.SYNTHETIC_PROVIDER_STARTED, "started");',
        "    while (!fs.existsSync(process.env.SYNTHETIC_PROVIDER_RELEASE)) await pause(10);",
        "  }",
        '  process.stdout.write(JSON.stringify({ protocolVersion: 1, values: { "models/delay": "synthetic-delay-key" } }));',
        "});",
      ].join("\n");
      const serverAuthorizations: Array<string | undefined> = [];
      const server = createServer((request, response) => {
        serverAuthorizations.push(request.headers.authorization);
        response.writeHead(200, { "content-type": "text/event-stream" });
        const common = {
          id: "synthetic-credential-proof",
          object: "chat.completion.chunk",
          created: 1,
          model: "synthetic-model",
        };
        for (const row of [
          {
            ...common,
            choices: [
              {
                index: 0,
                delta: { role: "assistant", content: "OK" },
                finish_reason: null,
              },
            ],
          },
          {
            ...common,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          },
        ]) {
          response.write(`data: ${JSON.stringify(row)}\n\n`);
        }
        response.end("data: [DONE]\n\n");
      });
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("The synthetic request server did not bind a TCP port.");
      }
      const syntheticBaseUrl = `http://127.0.0.1:${address.port}/v1`;
      const config = asConfig({
        gateway: { mode: "local", port: 18789 },
        agents: { entries: { main: {} } },
        secrets: {
          providers: {
            vault: {
              source: "exec",
              command: process.execPath,
              args: ["-e", providerScript],
              passEnv: [
                "PATH",
                "SYNTHETIC_PROVIDER_WAIT",
                "SYNTHETIC_PROVIDER_STARTED",
                "SYNTHETIC_PROVIDER_RELEASE",
              ],
              timeoutMs: 10_000,
              noOutputTimeoutMs: 10_000,
            },
          },
        },
        models: {
          providers: {
            synthetic: {
              baseUrl: syntheticBaseUrl,
              api: "openai-completions",
              apiKey: { source: "store", provider: "default", id: "SYNTHETIC_API_KEY" },
              models: [
                {
                  id: "synthetic-model",
                  name: "Synthetic model",
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 4096,
                  maxTokens: 1024,
                },
              ],
            },
            delay: {
              baseUrl: "https://delay.example.invalid/v1",
              apiKey: { source: "exec", provider: "vault", id: "models/delay" },
              models: [],
            },
          },
        },
      });
      const env = (waitForProvider: boolean) => ({
        OPENCLAW_STATE_DIR: path.join(root, "state"),
        PATH: process.env.PATH ?? "",
        SYNTHETIC_PROVIDER_WAIT: waitForProvider ? "1" : "0",
        SYNTHETIC_PROVIDER_STARTED: providerStartedPath,
        SYNTHETIC_PROVIDER_RELEASE: providerReleasePath,
      });
      let currentStoreValue:
        | {
            ok: true;
            value: string;
          }
        | {
            ok: false;
            error: { code: "SECRET_STORE_NOT_FOUND"; message: string };
          } = { ok: true, value: "synthetic-key-a" };
      storeMocks.readValue.mockImplementation(async () => currentStoreValue);
      const prepare = (waitForProvider: boolean, forceColdRefKeys?: ReadonlySet<string>) =>
        prepareSecretsRuntimeSnapshot({
          config,
          env: env(waitForProvider),
          agentDirs: [root],
          includeAuthStoreRefs: false,
          allowUnavailableSecretOwners: true,
          ...(forceColdRefKeys ? { forceColdRefKeys } : {}),
          loadablePluginOrigins: new Map(),
        });

      try {
        const initial = await prepare(false);
        activatePreparedSecretsRuntimeSnapshot(initial);

        const blockedPublication = prepare(true);
        await waitForFile(providerStartedPath);
        await fs.writeFile(providerReleasePath, "release");
        activatePreparedSecretsRuntimeSnapshot(await blockedPublication);
        await fs.rm(providerStartedPath, { force: true });
        await fs.rm(providerReleasePath, { force: true });

        const previousStoreReads = storeMocks.readValue.mock.calls.length;
        const pendingRefresh = refreshActiveProviderAuthRuntimeSnapshot();
        await waitForFile(providerStartedPath);
        await waitForCondition(() => storeMocks.readValue.mock.calls.length > previousStoreReads);

        currentStoreValue = latestValue;
        const forceCold = expectedAuthorization
          ? undefined
          : new Set(["store:default:SYNTHETIC_API_KEY"]);
        activatePreparedSecretsRuntimeSnapshot(await prepare(false, forceCold));
        await fs.writeFile(providerReleasePath, "release");
        await expect(pendingRefresh).resolves.toBe(true);

        const activeConfig = getRuntimeConfigSnapshot();
        if (expectedAuthorization) {
          const providerAuth = await resolveApiKeyForProviderCore({
            cfg: activeConfig ?? undefined,
            provider: "synthetic",
            agentDir: root,
            store: { version: 1, profiles: {} },
            modelApi: "openai-completions",
            modelBaseUrl: syntheticBaseUrl,
          });
          expect(providerAuth.apiKey).toBe("synthetic-key-b");
          const model: Model<"openai-completions"> = {
            id: "synthetic-model",
            name: "Synthetic model",
            provider: "synthetic",
            api: "openai-completions",
            baseUrl: syntheticBaseUrl,
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 4096,
            maxTokens: 1024,
          };
          const completion = await streamSimple(
            model,
            { messages: [{ role: "user", content: "credential rotation proof", timestamp: 0 }] },
            { apiKey: providerAuth.apiKey },
          ).result();
          expect(completion.errorMessage).toBeUndefined();
          expect(serverAuthorizations).toEqual([expectedAuthorization]);
          return;
        }

        await expect(
          resolveApiKeyForProviderCore({
            cfg: activeConfig ?? undefined,
            provider: "synthetic",
            agentDir: root,
            store: { version: 1, profiles: {} },
            modelApi: "openai-completions",
            modelBaseUrl: syntheticBaseUrl,
          }),
        ).rejects.toThrow();
        expect(serverAuthorizations).toEqual([]);
        expect(
          getActiveSecretsRuntimeSnapshot()?.config.models?.providers?.synthetic?.apiKey,
        ).toEqual({ source: "store", provider: "default", id: "SYNTHETIC_API_KEY" });
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
        });
      }
    },
  );

  it("isolates a missing store-backed skill instead of failing gateway startup", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-runtime-store-"));
    roots.push(root);
    const ref = { source: "store", provider: "default", id: "MISSING_SKILL_API_KEY" } as const;
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        agents: { entries: { main: {} } },
        skills: { entries: { unavailable: { apiKey: ref } } },
      }),
      env: { OPENCLAW_STATE_DIR: path.join(root, "state") },
      includeAuthStoreRefs: false,
      allowUnavailableSecretOwners: true,
      loadablePluginOrigins: new Map(),
    });

    expect(snapshot.config.skills?.entries?.unavailable?.apiKey).toEqual(ref);
    expect(snapshot.degradedOwners).toMatchObject([
      {
        ownerKind: "capability",
        ownerId: "skill:unavailable",
        state: "unavailable",
        reason: "secret reference was not found",
      },
    ]);
  });

  it.each(["missing", "redacted"])(
    "makes a %s store ref cold instead of retaining its value",
    async (failure) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-runtime-store-"));
      roots.push(root);
      const ref = { source: "store", provider: "default", id: "SERVICE_API_KEY" } as const;
      const config = asConfig({
        agents: { entries: { main: {} } },
        skills: { entries: { service: { apiKey: ref } } },
      });
      const runtimeOptions = {
        config,
        env: { OPENCLAW_STATE_DIR: path.join(root, "state") },
        includeAuthStoreRefs: false,
        allowUnavailableSecretOwners: true,
        loadablePluginOrigins: new Map(),
      } as const;

      storeMocks.readValue.mockResolvedValue({ ok: true, value: "previous-secret" });
      const active = await prepareSecretsRuntimeSnapshot(runtimeOptions);
      const { activateSecretsRuntimeSnapshot } = await import("./runtime.js");
      activateSecretsRuntimeSnapshot(active);
      expect(active.config.skills?.entries?.service?.apiKey).toBe("previous-secret");

      storeMocks.readValue.mockResolvedValue(
        failure === "redacted"
          ? { ok: true, value: "__OPENCLAW_REDACTED__" }
          : {
              ok: false,
              error: {
                code: "SECRET_STORE_NOT_FOUND",
                message: "Secret store entry was not found.",
              },
            },
      );
      const refreshed = await prepareSecretsRuntimeSnapshot({
        ...runtimeOptions,
        ...(failure === "missing"
          ? { forceColdRefKeys: new Set(["store:default:SERVICE_API_KEY"]) }
          : {}),
      });

      expect(refreshed.config.skills?.entries?.service?.apiKey).toEqual(ref);
      expect(refreshed.degradedOwners).toMatchObject([
        {
          ownerKind: "capability",
          ownerId: "skill:service",
          degradationState: "cold",
        },
      ]);
      expect(JSON.stringify(refreshed)).not.toContain("previous-secret");
    },
  );
});
