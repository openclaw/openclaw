import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterAll, beforeAll, expect, test } from "vitest";
import { WebSocket } from "ws";
import { resetPreparedModelCatalogStateForTest } from "../agents/prepared-model-runtime.test-support.js";
import {
  captureRuntimeConfigAsyncReader,
  clearConfigCache,
  clearRuntimeConfigSnapshot,
  getRuntimeConfig,
} from "../config/config.js";
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
  trackConnectChallengeNonce,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

let gateway: Awaited<ReturnType<typeof startConnectedServerWithClient>>;

afterAll(async () => {
  gateway.ws.close();
  await gateway.server.close();
  // Minimal test gateways skip the skills close hook; retire their discovery worker here.
  await closeSkillsWatchers(true);
});

beforeAll(async () => {
  gateway = await startConnectedServerWithClient();
});

type ModelCatalogRpcEntry = { id: string; provider: string };

function configPath() {
  return expectDefined(
    process.env.OPENCLAW_CONFIG_PATH || undefined,
    "Missing OPENCLAW_CONFIG_PATH",
  );
}

const withModelsConfig = async <T>(config: unknown, run: () => Promise<T>): Promise<T> => {
  const file = configPath();
  const previousConfig = await fs.readFile(file, "utf-8");
  try {
    await fs.writeFile(file, JSON.stringify(config, null, 2), "utf-8");
    clearRuntimeConfigSnapshot();
    clearConfigCache();
    return await run();
  } finally {
    await fs.writeFile(file, previousConfig, "utf-8");
    clearRuntimeConfigSnapshot();
    clearConfigCache();
  }
};

type NodeGatewayEvent = {
  type: "event";
  event: string;
  payload?: Record<string, unknown> | null;
};

const voicewakeChanged = (socket: WebSocket) =>
  onceMessage<NodeGatewayEvent>(
    socket,
    (event) => event.type === "event" && event.event === "voicewake.changed",
  );

test("persists normalized voicewake triggers and broadcasts to operators and nodes", async () => {
  const { ws, port } = gateway;
  const nodeWs = new WebSocket(`ws://127.0.0.1:${port}`);
  trackConnectChallengeNonce(nodeWs);
  try {
    await once(nodeWs, "open");
    const firstEventP = voicewakeChanged(nodeWs);
    await connectOk(nodeWs, {
      role: "node",
      client: {
        id: GATEWAY_CLIENT_NAMES.NODE_HOST,
        version: "1.0.0",
        platform: "ios",
        mode: GATEWAY_CLIENT_MODES.NODE,
      },
    });
    const defaults = ["openclaw", "claude", "computer"];
    expect((await firstEventP).payload?.triggers).toEqual(defaults);
    const updates = [ws, nodeWs].map(voicewakeChanged);
    const set = await rpcReq(ws, "voicewake.set", { triggers: ["  hi  ", "", "there"] });
    expect(set).toMatchObject({ ok: true, payload: { triggers: ["hi", "there"] } });
    for (const update of await Promise.all(updates)) {
      expect(update).toMatchObject({
        event: "voicewake.changed",
        payload: { triggers: ["hi", "there"] },
      });
    }
    const after = await rpcReq<{ triggers: string[] }>(ws, "voicewake.get");
    expect(after).toMatchObject({ ok: true, payload: { triggers: ["hi", "there"] } });
  } finally {
    nodeWs.close();
  }
});

test("prepared agent read RPCs preserve explicit and system owners without live fallback", async () => {
  const { ws } = gateway;
  const listModels = (agentId?: string) =>
    rpcReq<{ models: ModelCatalogRpcEntry[] }>(ws, "models.list", {
      agentId,
      view: "configured",
      preparedOnly: true,
    });
  const authStatus = (agentId?: string) =>
    rpcReq<{ providers: Array<{ provider: string }> }>(ws, "models.authStatus", { agentId });
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
          models: startupModels.map(({ id, name }) => ({ id, name })),
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
  const rejectReads = async (params: { agentId?: string }) => {
    for (const method of readMethods) {
      expect(await rpcReq(ws, method, params), method).toMatchObject({
        ok: false,
        error: { code: "INVALID_REQUEST" },
      });
    }
  };

  await withModelsConfig(modelConfig, async () => {
    await publishPreparedOwners();
    const discoveryCallsAfterStartup = agentDiscoveryMock.discoverCalls;

    let discoveredDuringRequest = false;
    agentDiscoveryMock.models = [
      {
        id: "request-time-fallback",
        name: "Request-time fallback",
        get provider() {
          discoveredDuringRequest = true;
          return "fixture";
        },
      },
    ];
    try {
      const explicitReads = ["ops", "research"].map(async (agentId) => {
        const [models, auth] = await Promise.all([listModels(agentId), authStatus(agentId)]);
        expect([models.ok, auth.ok]).toEqual([true, true]);
        expect(models.payload?.models).toContainEqual(
          expect.objectContaining({ id: `${agentId}-model`, provider: "fixture" }),
        );
        expect(auth.payload?.providers).toContainEqual(
          expect.objectContaining({ provider: "fixture" }),
        );
      });
      const [models, auth, emptyAuth, skills, memory, health] = await Promise.all([
        listModels(),
        authStatus(),
        authStatus(""),
        rpcReq<{ agentId: string; workspaceDir: string }>(ws, "skills.status", {}),
        rpcReq<{ agentId: string }>(ws, "doctor.memory.status", {}),
        rpcReq<Record<string, unknown>>(ws, "health", { probe: true }),
        Promise.all(explicitReads),
      ]);
      expect(models.payload?.models).toEqual([
        expect.objectContaining({ id: "ops-model", provider: "fixture" }),
      ]);
      expect([auth.ok, emptyAuth.ok]).toEqual([true, true]);
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
    expect(discoveredDuringRequest).toBe(false);
    await rejectReads({ agentId: "missing" });
  });

  const noSystemAgentConfig = {
    ...modelConfig,
    agents: { ownership: modelConfig.agents.ownership, entries: modelConfig.agents.entries },
  };
  await withModelsConfig(noSystemAgentConfig, async () => {
    await publishPreparedOwners();

    await rejectReads({});
  });
});
