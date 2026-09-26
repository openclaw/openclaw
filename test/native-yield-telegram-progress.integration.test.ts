// Layered channel-boundary proof: the real SDK retained owner and publisher use real Telegram
// transport against loopback. Native dispatcher/yield composition is covered separately.
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
import { emitAgentEvent } from "../src/infra/agent-events.js";
import {
  registerAgentRunContext,
  clearAgentRunContext,
  resetAgentRunRegistryForTest,
} from "../src/infra/agent-run-registry.js";
import { createAgentHarnessTaskRuntime } from "../src/plugin-sdk/agent-harness-task-runtime.js";
import { resolveStorePath, upsertSessionEntry } from "../src/plugin-sdk/session-store-runtime.js";
import {
  closeOpenClawAgentDatabasesForTest,
  closeOpenClawStateDatabaseForTest,
} from "../src/plugin-sdk/sqlite-runtime-testing.js";
import { closePluginStateDatabase } from "../src/plugin-state/plugin-state-store.sqlite.js";
import { createPluginRecord } from "../src/plugins/loader-records.js";
import { getPluginInstance } from "../src/plugins/plugin-instance-scope.js";
import { createPluginRegistry } from "../src/plugins/registry.js";
import { setActivePluginRegistry, resetPluginRuntimeStateForTest } from "../src/plugins/runtime.js";
import { createPluginRuntime } from "../src/plugins/runtime/index.js";
import { resetGatewayWorkAdmission } from "../src/process/gateway-work-admission.js";
import { createAgentHarnessTaskRuntimeScope } from "../src/tasks/agent-harness-task-runtime-scope.js";
import { taskProgressBatches } from "../src/tasks/task-registry-state.js";
import { resetTaskRegistryForTests } from "../src/tasks/task-runtime.test-helpers.js";
import { loadBundledPluginFacade } from "../src/test-utils/bundled-plugin-public-surface.js";
import { createTestRegistry } from "../src/test-utils/channel-plugins.js";

const dirs: string[] = [];
const sessionKey = "agent:main:proof-session";
const origin = { channel: "telegram", accountId: "default", to: "-1001234567890", threadId: 42 };
let server: Server | undefined;
let captured: Array<{ method: string; body: Record<string, unknown> }>;
let onEdit: (() => Promise<void>) | undefined;
let cfg: OpenClawConfig;
let disposePlugin: (() => Promise<void>) | undefined;

beforeEach(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "native-yield-telegram-"));
  dirs.push(dir);
  vi.stubEnv("OPENCLAW_STATE_DIR", dir);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(dir, "openclaw.json"));
  resetGatewayWorkAdmission();
  resetAgentRunRegistryForTest();
  resetTaskRegistryForTests({ persist: false });
  captured = [];
  onEdit = undefined;
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      void (async () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        const method = request.url?.split("/").at(-1) ?? "";
        captured.push({ method, body });
        if (method === "editMessageText" && onEdit) {
          const revoke = onEdit;
          onEdit = undefined;
          await revoke();
          response.writeHead(503, { "Content-Type": "application/json", Connection: "close" });
          response.end(
            JSON.stringify({
              ok: false,
              error_code: 503,
              description: "synthetic retryable failure",
            }),
          );
          return;
        }
        response.writeHead(200, { "Content-Type": "application/json", Connection: "close" });
        response.end(
          JSON.stringify({
            ok: true,
            result: {
              message_id: 123,
              date: Math.floor(Date.now() / 1000),
              chat: { id: Number(origin.to), type: "supergroup", is_forum: true },
              message_thread_id: 42,
              text: body.text ?? "synthetic",
            },
          }),
        );
      })().catch((error: unknown) => {
        response.destroy(error instanceof Error ? error : new Error(String(error)));
      });
    });
  });
  await new Promise<void>((resolve) => {
    server!.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("No loopback port");
  }
  cfg = {
    channels: {
      telegram: {
        botToken: "123456:synthetic-loopback-only",
        apiRoot: `http://127.0.0.1:${address.port}`,
        streaming: { mode: "progress", progress: { toolProgress: true } },
      },
    },
    tools: { web: { search: { enabled: false } } },
  };
  const { telegramPlugin } = await loadBundledPluginFacade<{ telegramPlugin: ChannelPlugin }>({
    pluginId: "telegram",
    artifactBasename: "api.js",
  });
  const { setTelegramRuntime } = await loadBundledPluginFacade<
    typeof import("../extensions/telegram/runtime-api.js")
  >({ pluginId: "telegram", artifactBasename: "runtime-api.js" });
  const builder = createPluginRegistry({
    runtime: createPluginRuntime(),
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    activateGlobalSideEffects: false,
  });
  const record = createPluginRecord({
    id: "telegram",
    source: path.resolve("extensions/telegram/index.ts"),
    origin: "bundled",
    enabled: true,
    configSchema: true,
  });
  builder.registry.plugins.push(record);
  const api = builder.createApi(record, { config: cfg, registrationMode: "full" });
  const instance = getPluginInstance(record);
  if (!instance) {
    throw new Error("Missing Telegram plugin instance");
  }
  instance.run(() => {
    setTelegramRuntime(api.runtime);
    api.registerChannel({ plugin: telegramPlugin });
  });
  disposePlugin = async () => {
    expect((await instance.dispose()).errors).toEqual([]);
  };
  setActivePluginRegistry(builder.registry);
  setRuntimeConfigSnapshot(cfg, cfg);
});
afterEach(async () => {
  resetAgentRunRegistryForTest();
  resetTaskRegistryForTests({ persist: false });
  await disposePlugin?.();
  disposePlugin = undefined;
  closePluginStateDatabase();
  resetPluginRuntimeStateForTest();
  clearRuntimeConfigSnapshot();
  setActivePluginRegistry(createTestRegistry([]));
  vi.useRealTimers();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  if (server) {
    await new Promise<void>((resolve, reject) => {
      server!.close((error) => (error ? reject(error) : resolve()));
      server!.closeAllConnections();
    });
  }
  server = undefined;
});
afterAll(async () => {
  for (const dir of dirs) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

const edits = () => captured.filter(({ method }) => method === "editMessageText");
const settled = () =>
  vi.waitFor(
    () => expect([...taskProgressBatches.values()].every((batch) => !batch.publication)).toBe(true),
    { timeout: 15_000 },
  );
async function start() {
  const sessionId = "synthetic-requester";
  await upsertSessionEntry({
    agentId: "main",
    sessionKey,
    storePath: resolveStorePath(undefined, { agentId: "main" }),
    entry: { sessionId, updatedAt: Date.now(), lifecycleRevision: "original" },
  });
  const runtime = createAgentHarnessTaskRuntime({
    runtime: "subagent",
    taskKind: "synthetic-native",
    scope: createAgentHarnessTaskRuntimeScope({
      requesterSessionKey: sessionKey,
      requesterSessionId: sessionId,
      requesterLifecycleRevision: "original",
      requesterAgentId: "main",
      requesterOrigin: origin,
    }),
  });
  const task = runtime.createRunningTaskRun({
    runId: "synthetic-native-child",
    task: "private assignment",
    label: "Subagent",
    notifyPolicy: "silent",
    deliveryStatus: "not_applicable",
  });
  const owner = runtime.registerProgressOwner!({
    runIds: [task.runId!],
    agentId: "main",
    isCurrent: () => true,
    onStopped: () => {},
  });
  expect(owner).toBeDefined();
  const tool = async (name: string) => {
    emitAgentEvent({
      runId: task.runId!,
      stream: "tool",
      data: { phase: "start", name, toolCallId: name, args: { secret: "private-tool-args" } },
    });
    owner!.notify();
  };
  vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setTimeout", "clearTimeout"] });
  await tool("read");
  await vi.advanceTimersByTimeAsync(15_000);
  await vi.waitFor(
    () => expect(captured.some(({ method }) => method === "sendMessage")).toBe(true),
    { timeout: 25_000 },
  );
  await settled();
  const batch = [...taskProgressBatches.values()][0];
  expect(batch?.message?.target).toBeDefined();
  return {
    sessionId,
    tool,
    complete: () => {
      runtime.finalizeTaskRunByRunId({
        runId: task.runId!,
        status: "succeeded",
        endedAt: Date.now(),
        terminalSummary: "private terminal result",
      });
      owner!.notify();
    },
    waiting: async () => owner!.notify(),
    close: () => owner!.dispose(),
  };
}

it("edits the provider-observed topic receipt, rejecting foreign origin and unobserved messages", async () => {
  const native = await start();
  try {
    expect(captured).toMatchObject([
      { method: "sendMessage", body: { chat_id: origin.to, message_thread_id: 42 } },
    ]);
    // A live owner must really retry the same synthetic 503 used by the revocation cases.
    onEdit = async () => {};
    await native.tool("write");
    await vi.advanceTimersByTimeAsync(15_000);
    await vi.waitFor(() => expect(edits()).toHaveLength(2), { timeout: 25_000 });
    await settled();
    expect(edits()[0]).toMatchObject({
      body: {
        chat_id: origin.to,
        message_id: 123,
        text: expect.stringContaining("Subagent: running write"),
      },
    });
    const target = [...taskProgressBatches.values()][0]?.message?.target;
    expect(target).toBeDefined();
    expect(target?.requesterOrigin).toEqual(origin);
    const { editTaskProgressMessage } =
      await import("../src/tasks/task-registry-delivery-runtime.js");
    for (const change of [
      { requesterOrigin: { ...origin, accountId: "foreign" } },
      { requesterOrigin: { ...origin, to: "-1009999999999" } },
      { requesterOrigin: { ...origin, threadId: 43 } },
      { messageId: "124" },
    ]) {
      await expect(
        editTaskProgressMessage({
          ...target!,
          ...change,
          content: "must not reach Telegram",
          assertCurrent: () => {},
        }),
      ).rejects.toThrow("provider-observed binding");
      expect(edits()).toHaveLength(2);
    }
    native.complete();
    await vi.advanceTimersByTimeAsync(15_000);
    await vi.waitFor(() => expect(edits()).toHaveLength(3), { timeout: 25_000 });
    await settled();
    expect(edits()[2]).toMatchObject({
      body: { message_id: 123, text: expect.stringContaining("succeeded") },
    });
    expect(taskProgressBatches.size).toBe(0);
    expect(captured.filter(({ method }) => method === "sendMessage")).toHaveLength(1);
    expect(JSON.stringify(captured)).not.toContain("private terminal result");
    expect(JSON.stringify(captured)).not.toContain("must not reach Telegram");
    expect(JSON.stringify(captured)).not.toContain("private-tool-args");
    expect(JSON.stringify(captured)).not.toContain("private assignment");
    console.info("TELEGRAM_RETAINED_EDIT_PROOF", JSON.stringify(captured));
  } finally {
    native.close();
  }
}, 90_000);

it.each(["resume", "reset"] as const)(
  "revokes SDK ownership during the first edit HTTP failure before its retry (%s)",
  async (transition) => {
    const native = await start();
    try {
      // This callback runs after grammY has actually submitted the first edit request.
      onEdit = async () => {
        if (transition === "resume") {
          registerAgentRunContext("new-requester", {
            sessionKey,
            sessionId: native.sessionId,
            agentId: "main",
          });
          clearAgentRunContext("new-requester");
        } else {
          await upsertSessionEntry({
            agentId: "main",
            sessionKey,
            storePath: resolveStorePath(undefined, { agentId: "main" }),
            entry: {
              sessionId: "reset-proof-session",
              updatedAt: Date.now(),
              lifecycleRevision: "reset-proof",
            },
          });
        }
      };
      const batch = [...taskProgressBatches.values()][0]!;
      await native.tool("write");
      await vi.advanceTimersByTimeAsync(15_000);
      await vi.waitFor(() => expect(edits()).toHaveLength(1), { timeout: 25_000 });
      // Wait for the actual in-flight publisher, even after its owner removes the batch.
      await vi.waitFor(() => expect(batch.publication).toBeUndefined(), { timeout: 15_000 });
      expect(taskProgressBatches.size).toBe(0);
      expect(edits()).toHaveLength(1);
      await native.tool("after-retirement");
      await native.waiting();
      expect(taskProgressBatches.size).toBe(0);
      expect(captured.filter(({ method }) => method === "sendMessage")).toHaveLength(1);
      expect(edits()).toHaveLength(1);
      console.info(
        "TELEGRAM_RETRY_REVOKED",
        JSON.stringify({
          transition,
          requests: captured.map(({ method }) => method),
          retainedBatches: taskProgressBatches.size,
        }),
      );
    } finally {
      native.close();
    }
  },
  90_000,
);
