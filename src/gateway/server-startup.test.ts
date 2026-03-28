import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { loadSessionStore, saveSessionStore } from "../config/sessions/store.js";

const ensureOpenClawModelsJsonMock = vi.fn<
  (config: unknown, agentDir: unknown) => Promise<{ agentDir: string; wrote: boolean }>
>(async () => ({ agentDir: "/tmp/agent", wrote: false }));
const resolveModelAsyncMock = vi.fn<
  (
    provider: unknown,
    modelId: unknown,
    agentDir: unknown,
    cfg: unknown,
    options?: unknown,
  ) => Promise<{ model: { id: string; provider: string; api: string } }>
>(async () => ({
  model: {
    id: "gpt-5.4",
    provider: "openai-codex",
    api: "openai-codex-responses",
  },
}));

vi.mock("../agents/agent-paths.js", () => ({
  resolveOpenClawAgentDir: () => "/tmp/agent",
}));

vi.mock("../agents/models-config.js", () => ({
  ensureOpenClawModelsJson: (config: unknown, agentDir: unknown) =>
    ensureOpenClawModelsJsonMock(config, agentDir),
}));

vi.mock("../agents/pi-embedded-runner/model.js", () => ({
  resolveModelAsync: (
    provider: unknown,
    modelId: unknown,
    agentDir: unknown,
    cfg: unknown,
    options?: unknown,
  ) => resolveModelAsyncMock(provider, modelId, agentDir, cfg, options),
}));

describe("gateway startup primary model warmup", () => {
  beforeEach(() => {
    ensureOpenClawModelsJsonMock.mockClear();
    resolveModelAsyncMock.mockClear();
  });

  it("prewarms an explicit configured primary model", async () => {
    const { __testing } = await import("./server-startup.js");
    const cfg = {
      agents: {
        defaults: {
          model: {
            primary: "openai-codex/gpt-5.4",
          },
        },
      },
    } as OpenClawConfig;

    await __testing.prewarmConfiguredPrimaryModel({
      cfg,
      log: { warn: vi.fn() },
    });

    expect(ensureOpenClawModelsJsonMock).toHaveBeenCalledWith(cfg, "/tmp/agent");
    expect(resolveModelAsyncMock).toHaveBeenCalledWith(
      "openai-codex",
      "gpt-5.4",
      "/tmp/agent",
      cfg,
      {
        retryTransientProviderRuntimeMiss: true,
      },
    );
  });

  it("skips warmup when no explicit primary model is configured", async () => {
    const { __testing } = await import("./server-startup.js");

    await __testing.prewarmConfiguredPrimaryModel({
      cfg: {} as OpenClawConfig,
      log: { warn: vi.fn() },
    });

    expect(ensureOpenClawModelsJsonMock).not.toHaveBeenCalled();
    expect(resolveModelAsyncMock).not.toHaveBeenCalled();
  });
});

describe("gateway startup session recovery", () => {
  it("reconciles persisted running sessions left behind by an earlier process", async () => {
    const { __testing } = await import("./server-startup.js");
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-startup-"));
    const sessionsDir = path.join(stateDir, "agents", "main", "sessions");
    const storePath = path.join(sessionsDir, "sessions.json");
    const nowMs = 1_700_000_000_000;
    const warn = vi.fn();

    try {
      await fs.mkdir(sessionsDir, { recursive: true });
      await saveSessionStore(storePath, {
        "session:running": {
          sessionId: "session-running",
          updatedAt: nowMs - 20_000,
          status: "running",
          startedAt: nowMs - 90_000,
        },
        "session:already-aborted": {
          sessionId: "session-aborted",
          updatedAt: nowMs - 10_000,
          status: "running",
          startedAt: nowMs - 30_000,
          abortedLastRun: true,
        },
        "session:done": {
          sessionId: "session-done",
          updatedAt: nowMs - 5_000,
          status: "done",
          startedAt: nowMs - 40_000,
          endedAt: nowMs - 5_000,
          runtimeMs: 35_000,
        },
      });

      await expect(
        __testing.reconcilePersistedRunningSessionsOnStartup({
          stateDir,
          nowMs,
          log: { warn },
        }),
      ).resolves.toEqual({
        storesChecked: 1,
        sessionsReconciled: 2,
      });

      const store = loadSessionStore(storePath, { skipCache: true });
      expect(store["session:running"]).toMatchObject({
        status: "killed",
        endedAt: nowMs,
        runtimeMs: 90_000,
        updatedAt: nowMs,
      });
      expect(store["session:running"]?.abortedLastRun).toBeUndefined();
      expect(store["session:already-aborted"]).toMatchObject({
        status: "killed",
        abortedLastRun: true,
        endedAt: nowMs,
        runtimeMs: 30_000,
        updatedAt: nowMs,
      });
      expect(store["session:done"]).toMatchObject({
        status: "done",
        endedAt: nowMs - 5_000,
        runtimeMs: 35_000,
      });
      expect(warn).toHaveBeenCalledWith(
        `reconciled 2 stale running sessions on startup: ${storePath}`,
      );
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("reconciles running sessions from a configured custom store path", async () => {
    const { __testing } = await import("./server-startup.js");
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-startup-custom-store-"));
    const customStorePath = path.join(stateDir, "custom", "sessions.json");
    const nowMs = 1_700_000_100_000;

    try {
      await fs.mkdir(path.dirname(customStorePath), { recursive: true });
      await saveSessionStore(customStorePath, {
        "session:custom-running": {
          sessionId: "session-custom-running",
          updatedAt: nowMs - 10_000,
          status: "running",
          startedAt: nowMs - 20_000,
        },
      });

      await expect(
        __testing.reconcilePersistedRunningSessionsOnStartup({
          stateDir,
          configuredStore: customStorePath,
          nowMs,
          log: { warn: vi.fn() },
        }),
      ).resolves.toEqual({
        storesChecked: 1,
        sessionsReconciled: 1,
      });

      const store = loadSessionStore(customStorePath, { skipCache: true });
      expect(store["session:custom-running"]).toMatchObject({
        status: "killed",
        endedAt: nowMs,
        runtimeMs: 20_000,
        updatedAt: nowMs,
      });
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("continues reconciliation when one candidate store cannot be loaded", async () => {
    const { __testing } = await import("./server-startup.js");
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-startup-partial-store-"));
    const sessionsDir = path.join(stateDir, "agents", "main", "sessions");
    const validStorePath = path.join(sessionsDir, "sessions.json");
    const blockedDir = path.join(stateDir, "blocked-store-dir");
    const blockedStorePath = path.join(blockedDir, "sessions.json");
    const nowMs = 1_700_000_200_000;
    const warn = vi.fn();

    try {
      await fs.mkdir(sessionsDir, { recursive: true });
      await saveSessionStore(validStorePath, {
        "session:running": {
          sessionId: "session-running",
          updatedAt: nowMs - 5_000,
          status: "running",
          startedAt: nowMs - 30_000,
        },
      });
      await fs.mkdir(blockedDir, { recursive: true });
      await fs.chmod(blockedDir, 0o000);

      await expect(
        __testing.reconcilePersistedRunningSessionsOnStartup({
          stateDir,
          configuredStore: blockedStorePath,
          nowMs,
          log: { warn },
        }),
      ).resolves.toEqual({
        storesChecked: 1,
        sessionsReconciled: 1,
      });

      const store = loadSessionStore(validStorePath, { skipCache: true });
      expect(store["session:running"]).toMatchObject({
        status: "killed",
        endedAt: nowMs,
        runtimeMs: 30_000,
        updatedAt: nowMs,
      });
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("skipping session startup recovery"),
      );
    } finally {
      await fs.chmod(blockedDir, 0o700).catch(() => {});
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("expands templated configured stores for configured agent IDs", async () => {
    const { __testing } = await import("./server-startup.js");
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-startup-template-store-"));
    const storeTemplate = path.join(stateDir, "custom-stores", "{agentId}", "sessions.json");
    const workerStorePath = path.join(stateDir, "custom-stores", "worker", "sessions.json");
    const nowMs = 1_700_000_300_000;

    try {
      await fs.mkdir(path.dirname(workerStorePath), { recursive: true });
      await saveSessionStore(workerStorePath, {
        "session:worker-running": {
          sessionId: "session-worker-running",
          updatedAt: nowMs - 10_000,
          status: "running",
          startedAt: nowMs - 25_000,
        },
      });

      await expect(
        __testing.reconcilePersistedRunningSessionsOnStartup({
          stateDir,
          configuredStore: storeTemplate,
          configuredAgentIds: ["main", "worker"],
          nowMs,
          log: { warn: vi.fn() },
        }),
      ).resolves.toEqual({
        storesChecked: 1,
        sessionsReconciled: 1,
      });

      const store = loadSessionStore(workerStorePath, { skipCache: true });
      expect(store["session:worker-running"]).toMatchObject({
        status: "killed",
        endedAt: nowMs,
        runtimeMs: 25_000,
        updatedAt: nowMs,
      });
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });
});
