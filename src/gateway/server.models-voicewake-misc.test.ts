// Covers prepared model catalogs and voicewake RPC/event delivery.
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { WebSocket } from "ws";
import { resetPreparedModelCatalogStateForTest } from "../agents/prepared-model-runtime.test-support.js";
import {
  captureRuntimeConfigAsyncReader,
  clearConfigCache,
  clearRuntimeConfigSnapshot,
  getRuntimeConfig,
} from "../config/config.js";
import { resolveStateDir } from "../config/state-dir.js";
import type { GatewayAgentRuntime } from "../shared/session-types.js";
import { closeSkillsWatchers, refreshSkillsDiscovery } from "../skills/runtime/refresh.js";
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

installGatewayTestHooks({ scope: "suite" });

let server: Awaited<ReturnType<typeof startServerWithClient>>["server"];
let ws: WebSocket;
let port: number;
let stateDir: string;

afterAll(async () => {
  ws.close();
  await server.close();
  // Minimal test gateways skip the skills close hook; retire their discovery worker here.
  await closeSkillsWatchers(true);
});

beforeAll(async () => {
  const started = await startConnectedServerWithClient();
  server = started.server;
  ws = started.ws;
  port = started.port;
  stateDir = resolveStateDir();
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

const NODE_CLIENT = {
  id: GATEWAY_CLIENT_NAMES.NODE_HOST,
  version: "1.0.0",
  platform: "ios",
  mode: GATEWAY_CLIENT_MODES.NODE,
};

describe("gateway server models + voicewake", () => {
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

  type NodeGatewayEvent = {
    type: "event";
    event: string;
    payload?: Record<string, unknown> | null;
  };

  const withConnectedNodeEvent = async <T>(
    eventName: string,
    run: (nodeWs: WebSocket, firstEvent: NodeGatewayEvent) => Promise<T>,
  ): Promise<T> => {
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
      return await run(nodeWs, await firstEventP);
    } finally {
      nodeWs.close();
    }
  };

  test("persists normalized voicewake triggers and broadcasts to operators and nodes", async () => {
    await withConnectedNodeEvent("voicewake.changed", async (nodeWs, first) => {
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
        fs.readFile(path.join(stateDir, "settings", "voicewake.json"), "utf8"),
      ).rejects.toThrow(/ENOENT/u);
    });
  });

  test("prepared agent read RPCs preserve explicit and system owners without live fallback", async () => {
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
      await publishConfiguredModelRuntimeSnapshots({
        cfg: await captureRuntimeConfigAsyncReader()(),
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
        const opsWorkspace = path.join(workspaceRoot, "ops-workspace");
        const skillsRoot = path.join(opsWorkspace, "skills");
        const hotSkillDir = path.join(skillsRoot, "hot-status");
        const hotSkillFile = path.join(hotSkillDir, "SKILL.md");
        await fs.mkdir(hotSkillDir, { recursive: true });
        await fs.writeFile(
          hotSkillFile,
          "---\nname: hot-status\ndescription: Hot status fixture\n---\n",
          "utf8",
        );
        await refreshSkillsDiscovery({
          workspaceDir: opsWorkspace,
          config: getRuntimeConfig(),
        });
        const refreshed = await rpcReq<{
          skills?: Array<{ name?: string; eligible?: boolean }>;
        }>(ws, "skills.status", {});
        expect(
          refreshed.payload?.skills?.some(
            (skill) => skill.name === "hot-status" && skill.eligible === true,
          ),
        ).toBe(true);
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
});
