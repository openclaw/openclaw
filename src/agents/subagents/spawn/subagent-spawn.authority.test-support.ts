import { promises as fs } from "node:fs";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import * as config from "../../../config/config.js";
import { callGateway } from "../../../gateway/call.js";
import { registerChatAbortController } from "../../../gateway/chat-abort.js";
import type { GatewayRecoveryRuntime } from "../../../gateway/server-instance-runtime.types.js";
import { createChatAbortContext } from "../../../gateway/server-methods/chat.abort.test-helpers.js";
import type { GatewayRequestContext } from "../../../gateway/server-methods/types.js";
import {
  registerSessionBindingAdapter,
  unregisterSessionBindingAdapter,
  type SessionBindingAdapter,
  type SessionBindingRecord,
} from "../../../infra/outbound/session-binding-service.js";
import * as privateStores from "../../../infra/private-file-store.js";
import { flushLogger, resetLogger } from "../../../logging/logger.js";
import * as plugins from "../../../plugins/runtime.js";
import { bindGatewayContextResolver } from "../../../plugins/runtime/gateway-request-scope.js";
import { getActiveGatewayRootWorkCount } from "../../../process/gateway-work-admission.js";
import { captureSessionTarget } from "../../../sessions/session-controller.lifecycle.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../../test-utils/channel-plugins.js";
import { captureEnv, setTestEnvValue } from "../../../test-utils/env.js";
import { cleanupSessionStateForTest } from "../../../test-utils/session-state-cleanup.js";
import * as runContext from "../../admitted-run-context.js";
import { loadAgentRuntimePluginRegistryHandle } from "../../runtime-plugins.js";
import { subagentRuns } from "../registry/subagent-registry-memory.js";
import { subscribeSubagentRunChanges } from "../registry/subagent-registry-publication.js";
import {
  settleSubagentRegistryPersistenceWork,
  writeSubagentSessionEntry,
} from "../registry/subagent-registry.persistence.test-support.js";
import { resetSubagentRegistryForTests } from "../registry/subagent-registry.test-helpers.js";
import type { SubagentRunRecord } from "../registry/subagent-registry.types.js";
import { isSameSubagentRun } from "../registry/subagent-run-generation.js";
import { testing as schedulerTesting } from "../swarm/swarm-scheduler.test-support.js";
import { testing as spawnTesting } from "./subagent-spawn.test-support.js";

vi.mock("../../runtime-plugins.js", () => ({
  loadAgentRuntimePluginRegistryHandle:
    vi.fn<typeof import("../../runtime-plugins.js").loadAgentRuntimePluginRegistryHandle>(),
}));
vi.mock("../../../gateway/call.js", { spy: true });

export function observeSubagentRun(
  runId: string,
  matches: (entry: SubagentRunRecord) => boolean = () => true,
) {
  const completed = createDeferred<SubagentRunRecord>();
  const inspect = () => {
    const current = subagentRuns.get(runId);
    if (current && matches(current)) {
      completed.resolve(current);
    }
  };
  const stop = subscribeSubagentRunChanges("persistence", inspect);
  inspect();
  return { promise: completed.promise, stop };
}

export async function waitForSubagentCleanupCompleted(entry: SubagentRunRecord) {
  const observed = observeSubagentRun(
    entry.runId,
    (current) =>
      isSameSubagentRun(current, entry) && typeof current.cleanupCompletedAt === "number",
  );
  try {
    await observed.promise;
  } finally {
    observed.stop();
  }
}

export function installSpawnThreadBindingFixture(
  onBound?: (binding: SessionBindingRecord) => Promise<void>,
) {
  const plugin = {
    ...createChannelTestPluginBase({ id: "matrix" }),
    conversationBindings: { defaultTopLevelPlacement: "child" },
  };
  plugins.setActivePluginRegistry(
    createTestRegistry([{ pluginId: "matrix", source: "test", plugin }]),
  );
  const bindings: SessionBindingRecord[] = [];
  const bind = vi.fn<NonNullable<SessionBindingAdapter["bind"]>>(async (input) => {
    const binding: SessionBindingRecord = {
      bindingId: "synthetic-thread",
      targetSessionKey: input.targetSessionKey,
      targetKind: input.targetKind,
      status: "active",
      boundAt: Date.now(),
      conversation: {
        ...input.conversation,
        conversationId: "child-thread",
        parentConversationId: "parent",
      },
    };
    bindings.push(binding);
    await onBound?.(binding);
    return binding;
  });
  const adapter: SessionBindingAdapter = {
    channel: "matrix",
    accountId: "default",
    bind,
    capabilities: { placements: ["child"] },
    listBySession: (key) => bindings.filter((binding) => binding.targetSessionKey === key),
    resolveByConversation: (ref) =>
      bindings.find((binding) => binding.conversation.conversationId === ref.conversationId) ??
      null,
    unbind: async (input) => {
      const removed = bindings.filter(
        (binding) =>
          input.targetSessionKey === binding.targetSessionKey ||
          input.bindingId === binding.bindingId,
      );
      for (const binding of removed) {
        bindings.splice(bindings.indexOf(binding), 1);
      }
      return removed;
    },
  };
  registerSessionBindingAdapter(adapter);
  return {
    bind,
    bindings,
    unregister: () =>
      unregisterSessionBindingAdapter({ channel: "matrix", accountId: "default", adapter }),
  };
}

export function installSpawnAttachmentFixture(params: {
  stateDir: string;
  admitted: Parameters<typeof runContext.getAdmittedRunDelegatedAuthority>[0];
  pauseAt?: "directory" | "files";
  entered: () => void | Promise<void>;
  release: Promise<void>;
}) {
  const root = path.join(params.stateDir, "attachments", "subagents", "main");
  const lateWrites: string[] = [];
  const attachmentDirs: string[] = [];
  const recordWrite = (kind: string) => {
    if (!runContext.getAdmittedRunDelegatedAuthority(params.admitted)) {
      lateWrites.push(kind);
    }
  };
  const pause = async () => {
    await params.entered();
    await params.release;
  };
  const mkdir = fs.mkdir;
  const mkdirSpy = vi.spyOn(fs, "mkdir").mockImplementation(async (...args) => {
    const result = await mkdir(...args);
    if (typeof args[0] === "string" && path.dirname(path.dirname(args[0])) === root) {
      attachmentDirs.push(args[0]);
      recordWrite("directory");
      if (params.pauseAt === "directory") {
        await pause();
      }
    }
    return result;
  });
  const createStore = privateStores.privateFileStore;
  const storeSpy = vi.spyOn(privateStores, "privateFileStore").mockImplementation((rootDir) => {
    const store = createStore(rootDir);
    if (path.dirname(rootDir) !== root) {
      return store;
    }
    return {
      ...store,
      writeText: async (...args) => {
        const attachmentDir = path.join(rootDir, args[0].split("/")[0] ?? "");
        if (!attachmentDirs.includes(attachmentDir)) {
          attachmentDirs.push(attachmentDir);
        }
        recordWrite("content");
        const result = await store.writeText(...args);
        expect(await fs.readFile(path.join(rootDir, args[0]), "utf8")).toBe("synthetic attachment");
        if (params.pauseAt === "directory" || params.pauseAt === "files") {
          await pause();
        }
        return result;
      },
      writeJson: async (...args) => {
        recordWrite("manifest");
        return await store.writeJson(...args);
      },
    };
  });
  return {
    lateWrites,
    attachmentDirs,
    restore: () => {
      mkdirSpy.mockRestore();
      storeSpy.mockRestore();
    },
  };
}

export function installSpawnAuthorityFixture() {
  const parentSessionKey = "agent:main:main";
  const parentRunId = "pending-spawn-parent";
  const groupId = "pending-spawn";
  const env = captureEnv(["OPENCLAW_STATE_DIR", "OPENCLAW_CONFIG_PATH"]);
  let stateDir = "";
  let pluginSnapshot: ReturnType<typeof plugins.captureActivePluginRegistrySnapshot>;
  const settle = () => settleSubagentRegistryPersistenceWork();
  const writeSession = (key: string, id: string, agentId = "main", revision?: string) =>
    writeSubagentSessionEntry({
      stateDir,
      agentId,
      sessionKey: key,
      defaultSessionId: id,
      lifecycleRevision: revision,
    });
  async function configure(cfg: ReturnType<typeof config.getRuntimeConfig>) {
    await writeFile(path.join(stateDir, "openclaw.json"), JSON.stringify(cfg));
    config.clearConfigCache();
    config.clearRuntimeConfigSnapshot();
    await config.captureRuntimeConfigAsyncReader()();
  }

  beforeEach(async () => {
    // Failed cleanup retains the prior owner instead of replacing its live stores.
    if (stateDir) {
      throw new Error("Previous spawn authority fixture cleanup is incomplete");
    }
    pluginSnapshot = plugins.captureActivePluginRegistrySnapshot();
    stateDir = await realpath(await mkdtemp(path.join(os.tmpdir(), "openclaw-spawn-authority-")));
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    setTestEnvValue("OPENCLAW_CONFIG_PATH", path.join(stateDir, "openclaw.json"));
    await configure({
      logging: { audit: { enabled: false } },
      tools: {
        swarm: { enabled: true, maxConcurrent: 1 },
        sessions_spawn: { attachments: { enabled: true } },
      },
      agents: {
        defaults: { workspace: stateDir, model: { primary: "openai/gpt-5.4" } },
        entries: { main: { workspace: stateDir } },
      },
    });
    await resetSubagentRegistryForTests({ persist: false });
    vi.mocked(loadAgentRuntimePluginRegistryHandle).mockImplementation(
      () => plugins.getActivePluginRegistry() ?? createTestRegistry([]),
    );
    vi.mocked(callGateway).mockImplementation(async (request) => {
      if (request.method !== "agent.wait") {
        throw new Error(`Unexpected registry RPC ${request.method}`);
      }
      return await new Promise<never>(() => {});
    });
  });

  afterEach(async () => {
    const failures: unknown[] = [];
    const recordFailure = (error: unknown) => {
      failures.push(error);
    };
    await settle().catch(recordFailure);
    // Settled delivery failures still permit cleanup; live roots retain their stores.
    if (getActiveGatewayRootWorkCount() === 0) {
      try {
        await resetSubagentRegistryForTests({ persist: false });
        schedulerTesting.reset();
        await cleanupSessionStateForTest({ stateDir });
        vi.mocked(loadAgentRuntimePluginRegistryHandle).mockReset();
        vi.mocked(callGateway).mockReset();
        spawnTesting.setDepsForTest();
        config.clearRuntimeConfigSnapshot();
        config.clearConfigCache();
        await flushLogger();
        resetLogger();
        // Resource cleanup finished; removal failure must not retain a retired owner.
        await rm(stateDir, { recursive: true, force: true }).catch(recordFailure);
        plugins.restoreActivePluginRegistrySnapshot(pluginSnapshot);
        env.restore();
        stateDir = "";
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) {
      throw failures[0];
    }
    if (failures.length > 1) {
      throw new AggregateError(failures, "Spawn authority fixture cleanup failed");
    }
  });

  async function createBoundParent(runtime: "embedded" | "plugin-harness" = "embedded") {
    const cfg = config.getRuntimeConfig();
    const storePath = await writeSession(parentSessionKey, "parent-session");
    const unexpectedRecovery = async () => {
      throw new Error("Unexpected fixture recovery operation");
    };
    const context = createChatAbortContext({
      getRuntimeConfig: () => cfg,
      getSessionEventSubscriberConnIds: () => new Set(),
      broadcastToConnIds: vi.fn(),
      recoveryRuntime: {
        prepareRestartRecovery: () => undefined,
        waitForAgent: async () => await new Promise<never>(() => {}),
        dispatchAgent: unexpectedRecovery,
        dispatchSessionMethod: unexpectedRecovery,
        sendRecoveryNotice: unexpectedRecovery,
        resumeChatInput: unexpectedRecovery,
      } satisfies GatewayRecoveryRuntime,
    });
    const admission = runContext.prepareSystemAgentRunAdmission(
      cfg,
      parentRunId,
      "main",
      "spawn-authority-test",
    );
    const parent = registerChatAbortController({
      target: captureSessionTarget({
        storeScope: storePath,
        sessionKey: parentSessionKey,
        incarnation: "parent-session",
        agentId: "main",
      }),
      runId: parentRunId,
      sessionKey: parentSessionKey,
      sessionId: "parent-session",
      agentId: "main",
      ownerConnId: "owner-connection",
      timeoutMs: 60_000,
      operationalRunInstance: admission.operationalRunInstance,
    });
    const admitted = await admission.admit(runtime);
    // Match agent-run-execution-phase: bind the admitted owner before tools run.
    bindGatewayContextResolver(admitted, () => context as unknown as GatewayRequestContext);
    const authority = runContext.getAdmittedRunDelegatedAuthority(admitted)!;
    parent.bindAgentRunDelegatedAuthority(authority);
    expect(parent.entry?.adapter.operationalRunInstance).toBe(admitted.operationalRunInstance);
    expect(parent.entry?.adapter.agentRunDelegatedAuthority).toBe(authority);
    expect(admitted.executionIdentityToken).toBeUndefined();

    return { cfg, storePath, context, admission, parent, admitted, authority };
  }

  return {
    settle,
    parentSessionKey,
    parentRunId,
    groupId,
    createBoundParent,
    configure,
    writeSession,
    get stateDir() {
      return stateDir;
    },
  };
}
