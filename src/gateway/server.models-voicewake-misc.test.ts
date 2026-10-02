// Covers prepared model catalogs and voicewake RPC/event delivery.
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { WebSocket } from "ws";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import { resetPreparedModelCatalogStateForTest } from "../agents/prepared-model-runtime.test-support.js";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../config/config.js";
import type { GatewayAgentRuntime } from "../shared/session-types.js";
import { closeSkillsWatchers, registerSkillsChangeListener } from "../skills/runtime/refresh.js";
import { createSkillsWatcherMock } from "../skills/runtime/refresh.watcher.test-support.js";
import { withEnvAsync } from "../test-utils/env.js";
import { createTempHomeEnv } from "../test-utils/temp-home.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { publishConfiguredModelRuntimeSnapshots } from "./server-startup-model-runtime.js";
import {
  connectOk,
  installGatewayTestHooks,
  onceMessage,
  agentDiscoveryMock,
  rpcReq,
  startConnectedServerWithClient,
  startServerWithClient,
  trackConnectChallengeNonce,
} from "./test-helpers.js";

const watchMock = vi.hoisted(() => vi.fn<typeof import("@openclaw/fs-safe/watch").watch>());
vi.mock("@openclaw/fs-safe/watch", () => ({ watch: watchMock }));
const skillsObserver = createSkillsWatcherMock();

installGatewayTestHooks({ scope: "suite" });

let server: Awaited<ReturnType<typeof startServerWithClient>>["server"];
let ws: WebSocket;
let port: number;

afterAll(async () => {
  ws.close();
  await server.close();
  // Minimal test gateways skip the skills close hook; skills.status watchers stay open otherwise.
  await closeSkillsWatchers(true);
});

beforeAll(async () => {
  watchMock.mockImplementation(skillsObserver.watchMock);
  await skillsObserver.trackPlanning();
  const started = await startConnectedServerWithClient();
  server = started.server;
  ws = started.ws;
  port = started.port;
});

type ModelCatalogRpcEntry = {
  id: string;
  name: string;
  provider: string;
  alias?: string;
  available?: boolean;
  contextWindow?: number;
  input?: string[];
  reasoning?: boolean;
  supportsTools?: boolean;
  tags?: string[];
  agentRuntime?: GatewayAgentRuntime;
};

type AgentCatalogFixtureEntry = {
  id: string;
  provider: string;
  name: string;
  contextWindow?: number;
};

const OPENCLAW_DEVICE_PLACEMENT: NonNullable<GatewayAgentRuntime["devicePlacement"]> = {
  requiredNodeCommands: [],
  consumesWorkerSlot: true,
};

const buildAgentCatalogFixture = (): AgentCatalogFixtureEntry[] => [
  { id: "gpt-test-z", name: "", provider: "openai", contextWindow: 0 },
  {
    id: "gpt-test-a",
    name: "A-Model",
    provider: "openai",
    contextWindow: 8000,
  },
  {
    id: "claude-test-b",
    name: "B-Model",
    provider: "anthropic",
    contextWindow: 1000,
  },
  {
    id: "claude-test-a",
    name: "A-Model",
    provider: "anthropic",
    contextWindow: 200_000,
  },
];

const expectedSortedCatalog = (gptTestZTags?: string[]): ModelCatalogRpcEntry[] => [
  {
    id: "claude-test-a",
    name: "A-Model",
    provider: "anthropic",
    available: false,
    contextWindow: 200_000,
  },
  {
    id: "claude-test-b",
    name: "B-Model",
    provider: "anthropic",
    available: false,
    contextWindow: 1000,
  },
  {
    id: "gpt-test-a",
    name: "A-Model",
    provider: "openai",
    agentRuntime: {
      id: "openclaw",
      cloudPlacementSupported: true,
      cloudPlacementExecutionMode: "worker-turn",
      devicePlacement: OPENCLAW_DEVICE_PLACEMENT,
      devicePlacementSupported: true,
      source: "implicit",
    },
    available: false,
    contextWindow: 8000,
  },
  {
    id: "gpt-test-z",
    name: "gpt-test-z",
    provider: "openai",
    agentRuntime: {
      id: "openclaw",
      cloudPlacementSupported: true,
      cloudPlacementExecutionMode: "worker-turn",
      devicePlacement: OPENCLAW_DEVICE_PLACEMENT,
      devicePlacementSupported: true,
      source: "implicit",
    },
    available: false,
    ...(gptTestZTags ? { tags: gptTestZTags } : {}),
  },
];

const NODE_CLIENT = {
  id: GATEWAY_CLIENT_NAMES.NODE_HOST,
  version: "1.0.0",
  platform: "ios",
  mode: GATEWAY_CLIENT_MODES.NODE,
};

const fullCatalogProviderConfig = () => ({
  models: {
    providers: Object.fromEntries(
      ["anthropic", "openai"].map((provider) => [
        provider,
        {
          baseUrl: `https://${provider}.example.com/v1`,
          apiKey: {
            source: "env",
            provider: "default",
            id: "MODEL_CATALOG_TEST_MISSING_KEY",
          },
          models: buildAgentCatalogFixture()
            .filter((entry) => entry.provider === provider)
            .map(({ provider: _provider, ...model }) => model),
        },
      ]),
    ),
  },
});

describe("gateway server models + voicewake", () => {
  const listModels = async (params?: {
    view?: "default" | "configured" | "all";
    preparedOnly?: boolean;
  }) =>
    withEnvAsync(
      {
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        CODEX_API_KEY: undefined,
        OPENAI_API_KEY: undefined,
        OPENAI_OAUTH_TOKEN: undefined,
        CHATGPT_OAUTH_TOKEN: undefined,
      },
      async () =>
        params
          ? await rpcReq<{ models: ModelCatalogRpcEntry[] }>(ws, "models.list", params)
          : await rpcReq<{ models: ModelCatalogRpcEntry[] }>(ws, "models.list"),
    );

  const setAgentCatalog = async (entries: AgentCatalogFixtureEntry[]) => {
    agentDiscoveryMock.enabled = true;
    agentDiscoveryMock.models = entries;
    await resetPreparedModelCatalogStateForTest();
    const [
      { refreshPreparedModelRuntimeSnapshots },
      { clearRuntimeConfigSnapshot: clearIoRuntimeConfigSnapshot, getRuntimeConfig },
    ] = await Promise.all([
      import("../agents/prepared-model-runtime.js"),
      import("../config/io.js"),
    ]);
    clearIoRuntimeConfigSnapshot();
    const publishedConfig = getRuntimeConfig();
    await refreshPreparedModelRuntimeSnapshots(publishedConfig, { gatewayLifecycle: true });
  };

  const seedAgentModelCatalog = async () => {
    await setAgentCatalog(buildAgentCatalogFixture());
  };

  const withModelsConfig = async <T>(config: unknown, run: () => Promise<T>): Promise<T> => {
    const configPath = process.env.OPENCLAW_CONFIG_PATH;
    if (!configPath) {
      throw new Error("Missing OPENCLAW_CONFIG_PATH");
    }
    let previousConfig: string | undefined;
    try {
      previousConfig = await fs.readFile(configPath, "utf-8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code !== "ENOENT") {
        throw err;
      }
    }

    try {
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(configPath, JSON.stringify(config, null, 2), "utf-8");
      clearRuntimeConfigSnapshot();
      clearConfigCache();
      return await run();
    } finally {
      if (previousConfig === undefined) {
        await fs.rm(configPath, { force: true });
      } else {
        await fs.writeFile(configPath, previousConfig, "utf-8");
      }
      clearRuntimeConfigSnapshot();
      clearConfigCache();
    }
  };

  const withTempHome = async <T>(fn: (homeDir: string) => Promise<T>): Promise<T> => {
    const tempHome = await createTempHomeEnv("openclaw-home-");
    try {
      return await fn(tempHome.home);
    } finally {
      await tempHome.restore();
    }
  };

  type NodeGatewayEvent = {
    type: "event";
    event: string;
    payload?: Record<string, unknown> | null;
  };

  const withConnectedNodeEvent = async <T>(
    eventName: string,
    run: (nodeWs: WebSocket, firstEvent: NodeGatewayEvent, homeDir: string) => Promise<T>,
  ): Promise<T> =>
    withTempHome(async (homeDir) => {
      const nodeWs = new WebSocket(`ws://127.0.0.1:${port}`);
      trackConnectChallengeNonce(nodeWs);
      try {
        await new Promise<void>((resolve) => {
          nodeWs.once("open", resolve);
        });
        const firstEventP = onceMessage<NodeGatewayEvent>(
          nodeWs,
          (o) => o.type === "event" && o.event === eventName,
        );
        await connectOk(nodeWs, {
          role: "node",
          client: NODE_CLIENT,
        });
        return await run(nodeWs, await firstEventP, homeDir);
      } finally {
        nodeWs.close();
      }
    });

  test("persists normalized voicewake triggers and broadcasts to operators and nodes", async () => {
    await withConnectedNodeEvent("voicewake.changed", async (nodeWs, first, homeDir) => {
      const defaults = ["openclaw", "claude", "computer"];
      expect(first.payload?.triggers).toEqual(defaults);
      const initial = await rpcReq<{ triggers: string[] }>(ws, "voicewake.get");
      expect(initial.ok).toBe(true);
      expect(initial.payload?.triggers).toEqual(defaults);

      const updates = [ws, nodeWs].map((client) =>
        onceMessage<NodeGatewayEvent>(
          client,
          (event) => event.type === "event" && event.event === "voicewake.changed",
        ),
      );
      const set = await rpcReq(ws, "voicewake.set", { triggers: ["  hi  ", "", "there"] });
      expect(set.ok).toBe(true);
      expect(set.payload?.triggers).toEqual(["hi", "there"]);
      for (const update of await Promise.all(updates)) {
        expect(update.event).toBe("voicewake.changed");
        expect(update.payload?.triggers).toEqual(["hi", "there"]);
      }
      const after = await rpcReq<{ triggers: string[] }>(ws, "voicewake.get");
      expect(after.ok).toBe(true);
      expect(after.payload?.triggers).toEqual(["hi", "there"]);
      await expect(
        fs.readFile(path.join(homeDir, ".openclaw", "settings", "voicewake.json"), "utf8"),
      ).rejects.toThrow(/ENOENT/u);
    });
  });

  test("voicewake.routing.get returns the default routing", async () => {
    const result = await rpcReq<{
      config?: { version?: number; defaultTarget?: unknown; routes?: unknown[] };
    }>(ws, "voicewake.routing.get");

    expect(result.ok).toBe(true);
    expect(result.payload?.config).toMatchObject({
      version: 1,
      defaultTarget: { mode: "current" },
      routes: [],
    });
  });

  test("prepared agent read RPCs preserve explicit and system owners without live fallback", async ({
    signal,
  }) => {
    const configPath = process.env.OPENCLAW_CONFIG_PATH;
    if (!configPath) {
      throw new Error("Missing OPENCLAW_CONFIG_PATH");
    }
    const workspaceRoot = path.dirname(configPath);
    const startupModels = [
      { id: "ops-model", name: "Ops Model", provider: "fixture" },
      { id: "research-model", name: "Research Model", provider: "fixture" },
    ];
    const modelConfig = {
      models: {
        providers: {
          fixture: {
            api: "openai-completions",
            apiKey: "test-fixture-key",
            baseUrl: "https://fixture.example.com/v1",
            models: [
              { id: "ops-model", name: "Ops Model" },
              { id: "research-model", name: "Research Model" },
            ],
          },
        },
      },
      agents: {
        ownership: "explicit",
        defaults: { systemAgent: { agentId: "ops" } },
        entries: {
          ops: {
            workspace: path.join(workspaceRoot, "ops-workspace"),
            model: { primary: "fixture/ops-model" },
            modelPolicy: { allow: ["fixture/ops-model"] },
          },
          research: {
            workspace: path.join(workspaceRoot, "research-workspace"),
            model: { primary: "fixture/research-model" },
            modelPolicy: { allow: ["fixture/research-model"] },
          },
        },
      },
    };
    const publishPreparedOwners = async () => {
      await resetPreparedModelCatalogStateForTest();
      agentDiscoveryMock.enabled = true;
      agentDiscoveryMock.models = startupModels;
      const { getRuntimeConfig } = await import("../config/io.js");
      await publishConfiguredModelRuntimeSnapshots({
        cfg: getRuntimeConfig(),
      });
    };
    const readMethods = [
      "models.list",
      "models.authStatus",
      "skills.status",
      "doctor.memory.status",
    ] as const;

    await withModelsConfig(modelConfig, async () => {
      await publishPreparedOwners();
      const discoveryCallsAfterStartup = agentDiscoveryMock.discoverCalls;

      let blockedRequestFallback = false;
      agentDiscoveryMock.models = [
        {
          id: "request-time-fallback",
          name: "Request-time fallback",
          get provider() {
            if (!blockedRequestFallback) {
              blockedRequestFallback = true;
              // A prepared-only miss used to run synchronous catalog discovery on the Gateway
              // thread. Make that operator-visible as event-loop starvation, not only a call count.
              Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 750);
            }
            return "fixture";
          },
        },
      ];
      try {
        const [
          opsModels,
          researchModels,
          opsAuth,
          researchAuth,
          models,
          auth,
          emptyAuth,
          skills,
          memory,
          health,
        ] = await Promise.all([
          rpcReq<{ models: ModelCatalogRpcEntry[] }>(ws, "models.list", {
            agentId: "ops",
            view: "configured",
            preparedOnly: true,
          }),
          rpcReq<{ models: ModelCatalogRpcEntry[] }>(ws, "models.list", {
            agentId: "research",
            view: "configured",
            preparedOnly: true,
          }),
          rpcReq<{ providers: Array<{ provider: string }> }>(ws, "models.authStatus", {
            agentId: "ops",
          }),
          rpcReq<{ providers: Array<{ provider: string }> }>(ws, "models.authStatus", {
            agentId: "research",
          }),
          rpcReq<{ models: ModelCatalogRpcEntry[] }>(ws, "models.list", {
            view: "configured",
            preparedOnly: true,
          }),
          rpcReq(ws, "models.authStatus", {}),
          rpcReq(ws, "models.authStatus", { agentId: "" }),
          rpcReq<{ agentId: string; workspaceDir: string }>(ws, "skills.status", {}),
          rpcReq<{ agentId: string }>(ws, "doctor.memory.status", {}),
          rpcReq<Record<string, unknown>>(ws, "health", { probe: true }),
        ]);

        expect(opsModels.ok, JSON.stringify(opsModels)).toBe(true);
        expect(researchModels.ok, JSON.stringify(researchModels)).toBe(true);
        expect(opsModels.payload?.models).toContainEqual(
          expect.objectContaining({ id: "ops-model", provider: "fixture" }),
        );
        expect(researchModels.payload?.models).toContainEqual(
          expect.objectContaining({ id: "research-model", provider: "fixture" }),
        );
        expect(opsAuth.ok, JSON.stringify(opsAuth)).toBe(true);
        expect(researchAuth.ok, JSON.stringify(researchAuth)).toBe(true);
        expect(opsAuth.payload?.providers).toContainEqual(
          expect.objectContaining({ provider: "fixture" }),
        );
        expect(researchAuth.payload?.providers).toContainEqual(
          expect.objectContaining({ provider: "fixture" }),
        );
        expect(models.payload?.models).toEqual([
          expect.objectContaining({ id: "ops-model", provider: "fixture" }),
        ]);
        expect(auth.ok, JSON.stringify(auth)).toBe(true);
        expect(emptyAuth.ok, JSON.stringify(emptyAuth)).toBe(true);
        expect(skills.payload).toMatchObject({
          agentId: "ops",
          workspaceDir: path.join(workspaceRoot, "ops-workspace"),
        });
        await withinTest(skillsObserver.readyAll(), signal);
        const opsWorkspace = path.join(workspaceRoot, "ops-workspace");
        const skillsRoot = path.join(opsWorkspace, "skills");
        const hotSkillDir = path.join(skillsRoot, "hot-status");
        const hotSkillFile = path.join(hotSkillDir, "SKILL.md");
        const published = createDeferred();
        const unsubscribe = registerSkillsChangeListener((event) => {
          if (
            event.workspaceDir === opsWorkspace &&
            event.reason === "watch" &&
            event.changedPath === hotSkillFile
          ) {
            published.resolve();
          }
        });
        try {
          await fs.mkdir(hotSkillDir, { recursive: true });
          await fs.writeFile(
            hotSkillFile,
            "---\nname: hot-status\ndescription: Hot status fixture\n---\n",
            "utf8",
          );
          // Drive only observation; the real Skills owner must publish before the RPC reads it.
          skillsObserver.forRoot(skillsRoot).change(hotSkillFile);
          await withinTest(published.promise, signal);
          const refreshed = await rpcReq<{
            skills?: Array<{ name?: string; eligible?: boolean }>;
          }>(ws, "skills.status", {});
          expect(
            refreshed.payload?.skills?.some(
              (skill) => skill.name === "hot-status" && skill.eligible === true,
            ),
          ).toBe(true);
        } finally {
          unsubscribe();
        }
        expect(memory.payload).toMatchObject({ agentId: "ops" });
        expect(health.ok, JSON.stringify(health)).toBe(true);
      } finally {
        agentDiscoveryMock.models = startupModels;
      }

      expect(agentDiscoveryMock.discoverCalls).toBe(discoveryCallsAfterStartup);
      expect(blockedRequestFallback).toBe(false);
      for (const method of readMethods) {
        const response = await rpcReq(ws, method, { agentId: "missing" });
        expect(response.ok, method).toBe(false);
        expect(response.error).toMatchObject({ code: "INVALID_REQUEST" });
      }
    });

    const noSystemAgentConfig = {
      ...modelConfig,
      agents: { ownership: modelConfig.agents.ownership, entries: modelConfig.agents.entries },
    };
    await withModelsConfig(noSystemAgentConfig, async () => {
      await publishPreparedOwners();

      for (const method of readMethods) {
        const response = await rpcReq(ws, method, {});
        expect(response.ok, method).toBe(false);
        expect(response.error).toMatchObject({ code: "INVALID_REQUEST" });
      }
    });
  });

  test("models.list applies explicit policy only to configured views", async () => {
    await withModelsConfig(
      {
        ...fullCatalogProviderConfig(),
        agents: {
          defaults: {
            model: { primary: "openai/gpt-test-z" },
            models: {
              "openai/gpt-test-z": {},
            },
            modelPolicy: { allow: ["openai/gpt-test-z"] },
          },
        },
      },
      async () => {
        await seedAgentModelCatalog();
        const discoverCallsBefore = agentDiscoveryMock.discoverCalls;
        const expected = expectedSortedCatalog(["default", "configured"]);
        for (const view of ["default", "configured", "all"] as const) {
          const result = await listModels({ view, preparedOnly: true });
          expect(result.ok, view).toBe(true);
          expect(result.payload?.models, view).toEqual(
            view === "all" ? [expected[3], ...expected.slice(0, 3)] : [expected[3]],
          );
        }
        expect(agentDiscoveryMock.discoverCalls).toBe(discoverCallsBefore);
      },
    );
  });

  test("models.list projects configured metadata onto a synthetic allowlist entry", async () => {
    await withModelsConfig(
      {
        agents: {
          defaults: {
            model: { primary: "nvidia/moonshotai/kimi-k2.5" },
            models: { "nvidia/moonshotai/kimi-k2.5": { alias: "Kimi (NVIDIA)" } },
            modelPolicy: { allow: ["nvidia/moonshotai/kimi-k2.5"] },
          },
        },
        models: {
          providers: {
            nvidia: {
              baseUrl: "https://nvidia.example.com",
              models: [
                {
                  id: "moonshotai/kimi-k2.5",
                  name: "Configured Kimi",
                  contextWindow: 32_000,
                  compat: { supportsTools: false },
                },
              ],
            },
          },
        },
      },
      async () => {
        await seedAgentModelCatalog();
        const result = await listModels();
        expect(result.ok).toBe(true);
        expect(result.payload?.models).toHaveLength(1);
        expect(result.payload?.models[0]).toMatchObject({
          id: "moonshotai/kimi-k2.5",
          name: "Configured Kimi",
          provider: "nvidia",
          alias: "Kimi (NVIDIA)",
          contextWindow: 32_000,
          supportsTools: false,
          tags: ["default", "configured"],
        });
      },
    );
  });

  test("models.list rejects unknown params", async () => {
    agentDiscoveryMock.enabled = true;
    agentDiscoveryMock.models = [{ id: "gpt-test-a", name: "A", provider: "openai" }];

    const res = await rpcReq(ws, "models.list", { extra: true });
    expect(res.ok).toBe(false);
    expect(res.error?.message ?? "").toMatch(/invalid models\.list params/i);
  });
});
