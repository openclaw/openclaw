import fs from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../src/channels/plugins/types.public.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../src/config/runtime-snapshot.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import {
  claimAgentRunContext,
  registerAgentRunContext,
  clearAgentRunContext,
} from "../src/infra/agent-run-registry.js";
import { createAgentHarnessTaskRuntime } from "../src/plugin-sdk/agent-harness-task-runtime.js";
import { resolveStorePath, upsertSessionEntry } from "../src/plugin-sdk/session-store-runtime.js";
import { setActivePluginRegistry } from "../src/plugins/runtime.js";
import { resetGatewayWorkAdmission } from "../src/process/gateway-work-admission.js";
import { closeOpenClawStateDatabaseAsync } from "../src/state/openclaw-state-db.js";
import { createAgentHarnessTaskRuntimeScope } from "../src/tasks/agent-harness-task-runtime-scope.js";
import { listTaskRecords } from "../src/tasks/runtime-internal.js";
import { taskProgressBatches } from "../src/tasks/task-registry-state.js";
import { resetTaskRegistryForTests } from "../src/tasks/task-runtime.test-helpers.js";
import { loadBundledPluginFacade } from "../src/test-utils/bundled-plugin-public-surface.js";
import { createTestRegistry } from "../src/test-utils/channel-plugins.js";
import { captureNativeYieldDispatchScope } from "./native-yield-dispatch.test-support.js";

const codexTestApi = await loadBundledPluginFacade<
  typeof import("../extensions/codex/test-api.js")
>({ pluginId: "codex", artifactBasename: "test-api.js" });
const fixture = await codexTestApi.loadNativeYieldChannelProofFixture();
const dirs: string[] = [];
let server: Server | undefined;
let captured: Array<{ method: string; path: string; body: unknown }>;
const sessionKey = "agent:main:proof-session";
const origin = { channel: "discord", accountId: "default", to: "channel:123456789012345678" };
const cfg: OpenClawConfig = {
  channels: {
    discord: {
      token: "synthetic-loopback-only",
      groupPolicy: "allowlist",
      guilds: { "323456789012345678": { channels: { "123456789012345678": { enabled: true } } } },
      streaming: { mode: "progress", progress: { toolProgress: true } },
    },
  },
  tools: { web: { search: { enabled: false } } },
};

beforeEach(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "native-yield-composed-"));
  dirs.push(dir);
  vi.stubEnv("OPENCLAW_STATE_DIR", dir);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(dir, "openclaw.json"));
  resetGatewayWorkAdmission();
  resetTaskRegistryForTests({ persist: false });
  captured = [];
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      captured.push({
        method: request.method ?? "",
        path: request.url ?? "",
        body: body ? JSON.parse(body) : null,
      });
      response.writeHead(200, { "Content-Type": "application/json", Connection: "close" });
      response.end(
        JSON.stringify(
          request.method === "GET"
            ? request.url?.includes("/guilds/")
              ? { id: "323456789012345678", name: "synthetic-guild" }
              : {
                  id: "123456789012345678",
                  type: 0,
                  guild_id: "323456789012345678",
                  name: "synthetic-proof",
                }
            : { id: "223456789012345678", channel_id: "123456789012345678", content: "synthetic" },
        ),
      );
    });
  });
  await new Promise<void>((resolve) => {
    server!.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("No loopback port");
  }
  vi.stubEnv("DISCORD_API_URL", `http://127.0.0.1:${address.port}/api/v10`);
  const { discordPlugin } = await loadBundledPluginFacade<{ discordPlugin: ChannelPlugin }>({
    pluginId: "discord",
    artifactBasename: "channel-plugin-api.js",
  });
  setActivePluginRegistry(
    createTestRegistry([
      { pluginId: "discord", plugin: discordPlugin, source: "synthetic", origin: "bundled" },
    ]),
  );
  setRuntimeConfigSnapshot(cfg, cfg);
});
fixture.setupNativeYieldChannelProofHooks();
afterEach(async () => {
  // Retire async SQLite owners before synchronous registry reset invalidates their admission.
  await closeOpenClawStateDatabaseAsync();
  resetTaskRegistryForTests({ persist: false });
  clearRuntimeConfigSnapshot();
  setActivePluginRegistry(createTestRegistry([]));
  vi.useRealTimers();
  if (server) {
    await new Promise<void>((resolve, reject) => {
      server!.close((error) => (error ? reject(error) : resolve()));
      server!.closeIdleConnections();
    });
  }
  server = undefined;
});
afterAll(async () => {
  for (const dir of dirs) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

const effects = () => captured.filter(({ method }) => method === "POST" || method === "PATCH");

it.each([
  { replacement: "session", sessionId: "replacement-session" },
  { replacement: "revision", sessionId: "proof-session" },
] as const)(
  "rejects a $replacement replacement between scope issuance and progress registration before HTTP send",
  async ({ sessionId }) => {
    const storePath = resolveStorePath(undefined, { agentId: "main" });
    await upsertSessionEntry({
      agentId: "main",
      sessionKey,
      storePath,
      entry: { sessionId: "proof-session", lifecycleRevision: "original", updatedAt: Date.now() },
    });
    const scope = createAgentHarnessTaskRuntimeScope({
      requesterSessionKey: sessionKey,
      requesterSessionId: "proof-session",
      requesterLifecycleRevision: "original",
      requesterAgentId: "main",
      requesterOrigin: origin,
    });
    await upsertSessionEntry({
      agentId: "main",
      sessionKey,
      storePath,
      entry: { sessionId, lifecycleRevision: "replacement", updatedAt: Date.now() },
    });
    const runtime = createAgentHarnessTaskRuntime({
      runtime: "subagent",
      taskKind: "codex-native",
      scope,
    });
    const task = runtime.createRunningTaskRun({
      runId: "synthetic-stale-native-child",
      task: "synthetic task",
      label: "Subagent",
      notifyPolicy: "silent",
      deliveryStatus: "not_applicable",
    });
    const onStopped = vi.fn();
    const owner = runtime.registerProgressOwner!({
      runIds: [task.runId!],
      agentId: "main",
      isCurrent: () => true,
      onStopped,
    });
    expect(owner).toBeDefined();
    try {
      vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setTimeout", "clearTimeout"] });
      owner!.notify();
      await vi.advanceTimersByTimeAsync(15_000);
      await vi.waitFor(() => expect(onStopped).toHaveBeenCalledOnce(), { timeout: 25_000 });
      expect(effects()).toHaveLength(0);
    } finally {
      owner?.dispose();
    }
  },
  60_000,
);

it("composes successful native yield through real publisher and Discord HTTP send/edit", async () => {
  const native = await fixture.createNativeYieldChannelProof({
    scope: await captureNativeYieldDispatchScope({
      workspaceDir: path.join(dirs[dirs.length - 1]!, "dispatch-workspace"),
      config: cfg,
      sessionKey,
      messageProvider: origin.channel,
      agentAccountId: origin.accountId,
      messageTo: origin.to,
    }),
    config: cfg,
  });
  try {
    await native.tool("read");
    expect(effects()).toHaveLength(0);
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setTimeout", "clearTimeout"] });
    await native.yield();
    await vi.advanceTimersByTimeAsync(15_000);
    const foreignKey = "agent:main:foreign-proof";
    await upsertSessionEntry({
      agentId: "main",
      sessionKey: foreignKey,
      storePath: resolveStorePath(undefined, { agentId: "main" }),
      entry: { sessionId: "foreign-proof", updatedAt: Date.now() },
    });
    const foreignStopped = vi.fn();
    const foreign = createAgentHarnessTaskRuntime({
      runtime: "subagent",
      taskKind: "codex-native",
      scope: createAgentHarnessTaskRuntimeScope({
        requesterSessionKey: foreignKey,
        requesterSessionId: "foreign-proof",
        requesterLifecycleRevision: "foreign-revision",
        requesterAgentId: "main",
        requesterOrigin: { ...origin, to: "channel:423456789012345678" },
      }),
    });
    const foreignOwner = foreign.registerProgressOwner!({
      runIds: listTaskRecords().flatMap((task) => (task.runId ? [task.runId] : [])),
      agentId: "main",
      isCurrent: () => true,
      onStopped: foreignStopped,
    });
    try {
      expect(foreign.listTaskRecords()).toEqual([]);
      foreignOwner?.notify();
      expect(foreignStopped).toHaveBeenCalledOnce();
      expect(effects()).toHaveLength(0);
    } finally {
      foreignOwner?.dispose();
    }
    expect(
      listTaskRecords().some(
        (task) => task.requesterSessionKey === sessionKey && task.notifyPolicy === "silent",
      ),
    ).toBe(true);
    await vi.waitFor(() => expect(effects()).toHaveLength(1), { timeout: 25_000, interval: 50 });
    expect(effects()[0]).toMatchObject({
      method: "POST",
      path: "/api/v10/channels/123456789012345678/messages",
      body: { content: expect.stringContaining("Subagent: running bash") },
    });
    await vi.waitFor(
      () =>
        expect([...taskProgressBatches.values()].every((batch) => !batch.publication)).toBe(true),
      { timeout: 10_000 },
    );
    await native.tool("write");
    await vi.advanceTimersByTimeAsync(15_000);
    await vi.waitFor(() => expect(effects()).toHaveLength(2), { timeout: 25_000, interval: 50 });
    expect(effects()[1]).toMatchObject({
      method: "PATCH",
      path: "/api/v10/channels/123456789012345678/messages/223456789012345678",
      body: { content: expect.stringContaining("Subagent: running bash") },
    });
    console.info("COMPOSED_PROOF", JSON.stringify(effects()));
  } finally {
    native.close();
  }
}, 90_000);

it.each([
  { transition: "resume", effect: "send" },
  { transition: "reset", effect: "send" },
  { transition: "reclaim", effect: "send" },
  { transition: "revision", effect: "send" },
  { transition: "resume", effect: "edit" },
  { transition: "reset", effect: "edit" },
  { transition: "reclaim", effect: "edit" },
  { transition: "revision", effect: "edit" },
] as const)(
  "revokes composed native progress after $transition before $effect",
  async ({ transition, effect }) => {
    if (transition === "reclaim") {
      registerAgentRunContext("same-id-parent-turn", {
        sessionKey,
        sessionId: "proof-session",
        agentId: "main",
      });
    }
    const native = await fixture.createNativeYieldChannelProof({
      scope: createAgentHarnessTaskRuntimeScope({
        requesterSessionKey: sessionKey,
        requesterSessionId: "proof-session",
        requesterLifecycleRevision: "proof-revision",
        requesterAgentId: "main",
        requesterOrigin: origin,
      }),
      config: cfg,
    });
    try {
      await native.tool("read");
      vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setTimeout", "clearTimeout"] });
      await native.yield();
      if (effect === "edit") {
        await vi.advanceTimersByTimeAsync(15_000);
        await vi.waitFor(() => expect(effects()).toHaveLength(1), {
          timeout: 25_000,
          interval: 50,
        });
        await vi.waitFor(
          () =>
            expect([...taskProgressBatches.values()].every((batch) => !batch.publication)).toBe(
              true,
            ),
          { timeout: 10_000 },
        );
        await native.tool("write");
      }
      const previousEffects = effects().length;
      expect(taskProgressBatches.size).toBe(1);
      if (transition === "reclaim") {
        claimAgentRunContext("same-id-parent-turn", {
          sessionKey,
          sessionId: native.sessionId,
          agentId: "main",
        });
      } else if (transition === "resume") {
        registerAgentRunContext("new-native-parent-turn", {
          sessionKey,
          sessionId: native.sessionId,
          agentId: "main",
        });
        clearAgentRunContext("new-native-parent-turn");
      } else {
        await upsertSessionEntry({
          agentId: "main",
          sessionKey,
          storePath: resolveStorePath(undefined, { agentId: "main" }),
          entry: {
            sessionId: transition === "revision" ? native.sessionId : "reset-proof-session",
            updatedAt: Date.now(),
            lifecycleRevision: transition === "revision" ? "replaced-revision" : "reset-proof",
          },
        });
      }
      // Revocation removes the real queued batch and timer, not merely a mocked send callback.
      await vi.waitFor(() => expect(taskProgressBatches.size).toBe(0));
      await native.tool("after-retirement");
      await native.waiting();
      expect(taskProgressBatches.size).toBe(0);
      expect(effects()).toHaveLength(previousEffects);
      console.info(
        "COMPOSED_DENIED",
        JSON.stringify({
          transition,
          effect,
          requestsBefore: previousEffects,
          requestsAfter: effects().length,
          retainedBatches: taskProgressBatches.size,
        }),
      );
    } finally {
      native.close();
    }
  },
  90_000,
);
