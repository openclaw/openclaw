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

type ModelCatalogRpcEntry = { id: string; provider: string };

function configPath() {
  const value = process.env.OPENCLAW_CONFIG_PATH;
  if (!value) {
    throw new Error("Missing OPENCLAW_CONFIG_PATH");
  }
  return value;
}

describe("gateway server models + voicewake", () => {
  const withModelsConfig = async <T>(config: unknown, run: () => Promise<T>): Promise<T> => {
    const file = configPath();
    let previousConfig: string | undefined;
    try {
      previousConfig = await fs.readFile(file, "utf-8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code !== "ENOENT") {
        throw err;
      }
    }

    try {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, JSON.stringify(config, null, 2), "utf-8");
      clearRuntimeConfigSnapshot();
      clearConfigCache();
      return await run();
    } finally {
      if (previousConfig === undefined) {
        await fs.rm(file, { force: true });
      } else {
        await fs.writeFile(file, previousConfig, "utf-8");
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
        client: {
          id: GATEWAY_CLIENT_NAMES.NODE_HOST,
          version: "1.0.0",
          platform: "ios",
          mode: GATEWAY_CLIENT_MODES.NODE,
        },
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
    const workspaceRoot = path.dirname(configPath());
    const agentEntry = (agentId: string) => ({
      workspace: path.join(workspaceRoot, `${agentId}-workspace`),
      model: { primary: `fixture/${agentId}-model` },
      modelPolicy: { allow: [`fixture/${agentId}-model`] },
    });
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
          ops: agentEntry("ops"),
          research: agentEntry("research"),
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
        const explicitReads = ["ops", "research"].map(async (agentId) => {
          const [models, auth] = await Promise.all([
            rpcReq<{ models: ModelCatalogRpcEntry[] }>(ws, "models.list", {
              agentId,
              view: "configured",
              preparedOnly: true,
            }),
            rpcReq<{ providers: Array<{ provider: string }> }>(ws, "models.authStatus", {
              agentId,
            }),
          ]);
          expect(models.ok, JSON.stringify(models)).toBe(true);
          expect(auth.ok, JSON.stringify(auth)).toBe(true);
          expect(models.payload?.models).toContainEqual(
            expect.objectContaining({ id: `${agentId}-model`, provider: "fixture" }),
          );
          expect(auth.payload?.providers).toContainEqual(
            expect.objectContaining({ provider: "fixture" }),
          );
        });
        const [models, auth, emptyAuth, skills, memory, health] = await Promise.all([
          rpcReq<{ models: ModelCatalogRpcEntry[] }>(ws, "models.list", {
            view: "configured",
            preparedOnly: true,
          }),
          rpcReq(ws, "models.authStatus", {}),
          rpcReq(ws, "models.authStatus", { agentId: "" }),
          rpcReq<{ agentId: string; workspaceDir: string }>(ws, "skills.status", {}),
          rpcReq<{ agentId: string }>(ws, "doctor.memory.status", {}),
          rpcReq<Record<string, unknown>>(ws, "health", { probe: true }),
          Promise.all(explicitReads),
        ]);
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
        const hotSkillDir = path.join(opsWorkspace, "skills", "hot-status");
        await fs.mkdir(hotSkillDir, { recursive: true });
        await fs.writeFile(
          path.join(hotSkillDir, "SKILL.md"),
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
        expect(refreshed.payload?.skills).toContainEqual(
          expect.objectContaining({ name: "hot-status", eligible: true }),
        );
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
