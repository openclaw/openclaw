// Storage readiness tests cover write/fsync/delete probes and TTL recovery.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  createStorageReadinessChecker,
  resolveGatewayStorageReadinessRoots,
  STORAGE_READINESS_FAILURE,
  type WritableProbeFileHandle,
  type WritableProbeFs,
} from "./storage-readiness.js";

function createProbeFs(
  overrides: Partial<WritableProbeFs> = {},
  handleOverrides: Partial<WritableProbeFileHandle> = {},
) {
  const handle = {
    close: vi.fn(async () => undefined),
    sync: vi.fn(async () => undefined),
    writeFile: vi.fn(async () => undefined),
    ...handleOverrides,
  };
  const probeFs = {
    mkdir: vi.fn(async () => undefined),
    open: vi.fn(async () => handle),
    unlink: vi.fn(async () => undefined),
    ...overrides,
  };
  return { handle, probeFs };
}

async function expectPathMissing(target: string) {
  await expect(fs.stat(target)).rejects.toMatchObject({ code: "ENOENT" });
}

describe("createStorageReadinessChecker", () => {
  it("probes each distinct writable root with a small fsynced file", async () => {
    const { handle, probeFs } = createProbeFs();
    const stateRoot = path.resolve("/state");
    const workspaceRoot = path.resolve("/workspace");
    let probeIndex = 0;
    const checker = createStorageReadinessChecker({
      getWritableRoots: () => ["/state", "/workspace", "/state"],
      fs: probeFs as unknown as WritableProbeFs,
      now: () => 1_000,
      createProbeFileName: () => `.probe-${++probeIndex}`,
      autoStart: false,
    });

    await expect(checker.refresh()).resolves.toEqual({ ready: true, failing: [] });
    expect(checker()).toEqual({ ready: true, failing: [] });
    expect(probeFs.mkdir).toHaveBeenNthCalledWith(1, stateRoot, {
      recursive: true,
    });
    expect(probeFs.mkdir).toHaveBeenNthCalledWith(2, workspaceRoot, {
      recursive: true,
    });
    expect(probeFs.open).toHaveBeenNthCalledWith(1, path.join(stateRoot, ".probe-1"), "wx", 0o600);
    expect(probeFs.open).toHaveBeenNthCalledWith(
      2,
      path.join(workspaceRoot, ".probe-2"),
      "wx",
      0o600,
    );
    expect(handle.writeFile).toHaveBeenCalledTimes(2);
    expect(handle.sync).toHaveBeenCalledTimes(2);
    expect(handle.close).toHaveBeenCalledTimes(2);
    expect(probeFs.unlink).toHaveBeenCalledTimes(2);
  });

  it("does not let one slow root block probes for other roots", async () => {
    const slowRoot = path.resolve("/slow");
    const fastRoot = path.resolve("/fast");
    let releaseSlowRoot: (() => void) | undefined;
    let probeIndex = 0;
    const { probeFs } = createProbeFs({
      mkdir: vi.fn((root: string) => {
        if (root === slowRoot) {
          return new Promise<unknown>((resolve) => {
            releaseSlowRoot = () => resolve(undefined);
          });
        }
        return Promise.resolve(undefined);
      }),
    });
    const checker = createStorageReadinessChecker({
      getWritableRoots: () => [slowRoot, fastRoot],
      fs: probeFs as unknown as WritableProbeFs,
      now: () => 1_000,
      createProbeFileName: () => `.probe-${++probeIndex}`,
      autoStart: false,
    });

    const refresh = checker.refresh();
    await vi.waitFor(() => {
      expect(probeFs.mkdir).toHaveBeenCalledTimes(2);
    });
    await vi.waitFor(() => {
      expect(probeFs.open).toHaveBeenCalledTimes(1);
    });
    expect(probeFs.open).toHaveBeenCalledWith(path.join(fastRoot, ".probe-2"), "wx", 0o600);

    releaseSlowRoot?.();
    await expect(refresh).resolves.toEqual({ ready: true, failing: [] });
    expect(probeFs.open).toHaveBeenCalledTimes(2);
  });

  it("does not create the new default workspace while probing a pinned legacy state root", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-storage-legacy-"));
    try {
      const legacyStateDir = path.join(home, ".clawdbot");
      const newStateDir = path.join(home, ".openclaw");
      await fs.mkdir(legacyStateDir, { recursive: true });
      const env = { HOME: home, USERPROFILE: home, OPENCLAW_HOME: home } as NodeJS.ProcessEnv;
      const roots = resolveGatewayStorageReadinessRoots({
        config: {} as OpenClawConfig,
        stateDir: legacyStateDir,
        env,
      });

      expect(roots).toContain(legacyStateDir);
      expect(roots).toContain(path.join(legacyStateDir, "state"));
      expect(roots).toContain(path.join(legacyStateDir, "agents", "main", "agent"));
      expect(roots).toContain(path.join(legacyStateDir, "agents", "main", "sessions"));
      expect(roots).toContain(home);
      expect(roots).not.toContain(path.join(newStateDir, "workspace"));

      const checker = createStorageReadinessChecker({
        getWritableRoots: () => roots,
        createProbeFileName: () => ".probe",
        autoStart: false,
      });
      await expect(checker.refresh()).resolves.toEqual({ ready: true, failing: [] });
      await expectPathMissing(newStateDir);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("probes the parent creation path for a missing implicit default workspace", async () => {
    const home = path.resolve("/home/openclaw");
    const stateDir = path.resolve("/state");
    const roots = resolveGatewayStorageReadinessRoots({
      config: {} as OpenClawConfig,
      stateDir,
      env: { HOME: home, USERPROFILE: home } as NodeJS.ProcessEnv,
      workspaceExists: (workspaceDir) => workspaceDir === home,
    });

    expect(roots).toContain(home);
    expect(roots).not.toContain(path.join(home, ".openclaw", "workspace"));

    const accessError = Object.assign(new Error("permission denied"), { code: "EACCES" });
    const { probeFs } = createProbeFs({
      open: vi.fn(async (probePath: string) => {
        if (probePath.startsWith(`${home}${path.sep}`)) {
          throw accessError;
        }
        return {
          close: vi.fn(async () => undefined),
          sync: vi.fn(async () => undefined),
          writeFile: vi.fn(async () => undefined),
        };
      }),
    });
    const checker = createStorageReadinessChecker({
      getWritableRoots: () => roots,
      fs: probeFs as unknown as WritableProbeFs,
      createProbeFileName: () => ".probe",
      autoStart: false,
    });

    await expect(checker.refresh()).resolves.toEqual({
      ready: false,
      failing: [STORAGE_READINESS_FAILURE],
    });
    expect(probeFs.open).toHaveBeenCalledWith(path.join(home, ".probe"), "wx", 0o600);
  });

  it("probes configured workspaces even when they are missing", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-storage-workspace-"));
    try {
      const stateDir = path.join(home, ".clawdbot");
      const workspaceDir = path.join(home, "configured-workspace");
      await fs.mkdir(stateDir, { recursive: true });
      const config = {
        agents: {
          list: [{ id: "main", workspace: workspaceDir }],
        },
      } as OpenClawConfig;
      const roots = resolveGatewayStorageReadinessRoots({
        config,
        stateDir,
        env: { HOME: home, USERPROFILE: home, OPENCLAW_HOME: home } as NodeJS.ProcessEnv,
      });

      expect(roots).toContain(workspaceDir);

      const checker = createStorageReadinessChecker({
        getWritableRoots: () => roots,
        createProbeFileName: () => ".probe",
        autoStart: false,
      });
      await expect(checker.refresh()).resolves.toEqual({ ready: true, failing: [] });
      const workspaceStat = await fs.stat(workspaceDir);
      expect(workspaceStat.isDirectory()).toBe(true);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("includes configured ACP harness session-store roots", () => {
    const stateDir = path.resolve("/state");
    const config = {
      session: {
        store: path.join(stateDir, "agents", "{agentId}", "sessions", "sessions.json"),
      },
      agents: {
        list: [
          { id: "ops", default: true },
          { id: "review", runtime: { type: "acp", acp: { agent: "opencode" } } },
        ],
      },
      acp: {
        defaultAgent: "claude",
        allowedAgents: ["gemini", "*"],
      },
    } as OpenClawConfig;
    const roots = resolveGatewayStorageReadinessRoots({
      config,
      stateDir,
      env: { HOME: "/home/openclaw", USERPROFILE: "/home/openclaw" } as NodeJS.ProcessEnv,
    });

    for (const agentId of ["ops", "review", "opencode", "claude", "gemini"]) {
      expect(roots).toContain(path.join(stateDir, "agents", agentId, "sessions"));
    }
    expect(roots).not.toContain(path.join(stateDir, "agents", "claude", "agent"));
    expect(roots).not.toContain(path.join(stateDir, "agents", "gemini", "agent"));
    expect(roots).not.toContain(path.join(stateDir, "agents", "*", "sessions"));
  });

  it("returns cached readiness while an async refresh is in flight", async () => {
    let finishWrite: (() => void) | undefined;
    const { handle, probeFs } = createProbeFs(
      {},
      {
        writeFile: vi.fn(
          () =>
            new Promise<void>((resolve) => {
              finishWrite = resolve;
            }),
        ),
      },
    );
    const checker = createStorageReadinessChecker({
      getWritableRoots: () => ["/state"],
      fs: probeFs as unknown as WritableProbeFs,
      now: () => 1_000,
      createProbeFileName: () => ".probe",
      autoStart: false,
    });

    const refresh = checker.refresh();
    expect(checker()).toEqual({ ready: false, failing: [STORAGE_READINESS_FAILURE] });
    await vi.waitFor(() => {
      expect(handle.writeFile).toHaveBeenCalled();
    });
    expect(handle.sync).not.toHaveBeenCalled();

    finishWrite?.();
    await expect(refresh).resolves.toEqual({ ready: true, failing: [] });
    expect(checker()).toEqual({ ready: true, failing: [] });
  });

  it("reports storage unavailable and caches the failed probe briefly", async () => {
    let nowMs = 1_000;
    const writeError = Object.assign(new Error("no space left"), { code: "ENOSPC" });
    const { handle, probeFs } = createProbeFs(
      {},
      {
        writeFile: vi.fn(async () => {
          throw writeError;
        }),
      },
    );
    const checker = createStorageReadinessChecker({
      getWritableRoots: () => ["/state"],
      fs: probeFs as unknown as WritableProbeFs,
      now: () => nowMs,
      createProbeFileName: () => ".probe",
      cacheTtlMs: 1_000,
      autoStart: false,
    });

    await expect(checker.refresh()).resolves.toEqual({
      ready: false,
      failing: [STORAGE_READINESS_FAILURE],
    });
    nowMs += 500;
    expect(checker()).toEqual({ ready: false, failing: [STORAGE_READINESS_FAILURE] });
    expect(probeFs.open).toHaveBeenCalledTimes(1);

    nowMs += 501;
    expect(checker()).toEqual({ ready: false, failing: [STORAGE_READINESS_FAILURE] });
    await checker.refresh();
    expect(probeFs.open).toHaveBeenCalledTimes(2);
    expect(handle.writeFile).toHaveBeenCalledTimes(2);
  });

  it("reports storage unavailable when writable root discovery fails", async () => {
    const { probeFs } = createProbeFs();
    const checker = createStorageReadinessChecker({
      getWritableRoots: () => {
        throw new Error("bad workspace config");
      },
      fs: probeFs as unknown as WritableProbeFs,
      now: () => 1_000,
      createProbeFileName: () => ".probe",
      autoStart: false,
    });

    await expect(checker.refresh()).resolves.toEqual({
      ready: false,
      failing: [STORAGE_READINESS_FAILURE],
    });
    expect(probeFs.open).not.toHaveBeenCalled();
  });

  it("does not remove a pre-existing probe path when exclusive create fails", async () => {
    const stateRoot = path.resolve("/state");
    const existsError = Object.assign(new Error("exists"), { code: "EEXIST" });
    const { probeFs } = createProbeFs({
      open: vi.fn(async () => {
        throw existsError;
      }),
    });
    const checker = createStorageReadinessChecker({
      getWritableRoots: () => ["/state"],
      fs: probeFs as unknown as WritableProbeFs,
      now: () => 1_000,
      createProbeFileName: () => ".probe",
      autoStart: false,
    });

    await expect(checker.refresh()).resolves.toEqual({
      ready: false,
      failing: [STORAGE_READINESS_FAILURE],
    });
    expect(probeFs.open).toHaveBeenCalledWith(path.join(stateRoot, ".probe"), "wx", 0o600);
    expect(probeFs.unlink).not.toHaveBeenCalled();
  });

  it("recovers once writes succeed after the cache expires", async () => {
    let nowMs = 1_000;
    let attempts = 0;
    const writeError = Object.assign(new Error("read only"), { code: "EROFS" });
    const { probeFs } = createProbeFs(
      {},
      {
        writeFile: vi.fn(async () => {
          attempts += 1;
          if (attempts === 1) {
            throw writeError;
          }
        }),
      },
    );
    const checker = createStorageReadinessChecker({
      getWritableRoots: () => ["/state"],
      fs: probeFs as unknown as WritableProbeFs,
      now: () => nowMs,
      createProbeFileName: () => ".probe",
      cacheTtlMs: 1_000,
      autoStart: false,
    });

    await expect(checker.refresh()).resolves.toEqual({
      ready: false,
      failing: [STORAGE_READINESS_FAILURE],
    });
    nowMs += 1_001;
    expect(checker()).toEqual({ ready: false, failing: [STORAGE_READINESS_FAILURE] });
    await checker.refresh();
    expect(checker()).toEqual({ ready: true, failing: [] });
  });

  it("treats cleanup failures as not ready", async () => {
    const unlinkError = Object.assign(new Error("permission denied"), { code: "EACCES" });
    const { probeFs } = createProbeFs({
      unlink: vi.fn(async () => {
        throw unlinkError;
      }),
    });
    const checker = createStorageReadinessChecker({
      getWritableRoots: () => ["/state"],
      fs: probeFs as unknown as WritableProbeFs,
      now: () => 1_000,
      createProbeFileName: () => ".probe",
      autoStart: false,
    });

    await expect(checker.refresh()).resolves.toEqual({
      ready: false,
      failing: [STORAGE_READINESS_FAILURE],
    });
  });

  it("marks storage unavailable when a probe does not finish before the timeout", async () => {
    vi.useFakeTimers();
    try {
      let nowMs = 1_000;
      let writeAttempts = 0;
      let finishFirstWrite: (() => void) | undefined;
      const { probeFs } = createProbeFs(
        {},
        {
          writeFile: vi.fn(() => {
            writeAttempts += 1;
            if (writeAttempts > 1) {
              return Promise.resolve();
            }
            return new Promise<void>((resolve) => {
              finishFirstWrite = resolve;
            });
          }),
        },
      );
      const checker = createStorageReadinessChecker({
        getWritableRoots: () => ["/state"],
        fs: probeFs as unknown as WritableProbeFs,
        now: () => nowMs,
        createProbeFileName: () => ".probe",
        probeTimeoutMs: 50,
        timeoutRetryMs: 100,
        autoStart: false,
      });

      const refresh = checker.refresh();
      await vi.advanceTimersByTimeAsync(50);
      await expect(refresh).resolves.toEqual({
        ready: false,
        failing: [STORAGE_READINESS_FAILURE],
      });
      expect(checker()).toEqual({ ready: false, failing: [STORAGE_READINESS_FAILURE] });

      nowMs += 99;
      expect(checker()).toEqual({ ready: false, failing: [STORAGE_READINESS_FAILURE] });
      expect(probeFs.open).toHaveBeenCalledTimes(1);

      nowMs += 1;
      await expect(checker.refresh()).resolves.toEqual({ ready: true, failing: [] });
      expect(probeFs.open).toHaveBeenCalledTimes(2);
      expect(checker()).toEqual({ ready: true, failing: [] });

      finishFirstWrite?.();
      for (let i = 0; i < 10; i += 1) {
        await Promise.resolve();
      }
      expect(checker()).toEqual({ ready: true, failing: [] });
      expect(probeFs.open).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("caps timed-out retry probes while storage calls remain hung", async () => {
    vi.useFakeTimers();
    try {
      let nowMs = 1_000;
      const { probeFs } = createProbeFs(
        {},
        {
          writeFile: vi.fn(
            () =>
              new Promise<void>(() => {
                // Simulate a filesystem call that never settles.
              }),
          ),
        },
      );
      const checker = createStorageReadinessChecker({
        getWritableRoots: () => ["/state"],
        fs: probeFs as unknown as WritableProbeFs,
        now: () => nowMs,
        createProbeFileName: () => ".probe",
        probeTimeoutMs: 50,
        timeoutRetryMs: 100,
        autoStart: false,
      });

      const firstRefresh = checker.refresh();
      await vi.advanceTimersByTimeAsync(50);
      await expect(firstRefresh).resolves.toEqual({
        ready: false,
        failing: [STORAGE_READINESS_FAILURE],
      });
      expect(probeFs.open).toHaveBeenCalledTimes(1);

      nowMs += 100;
      const secondRefresh = checker.refresh();
      await vi.advanceTimersByTimeAsync(50);
      await expect(secondRefresh).resolves.toEqual({
        ready: false,
        failing: [STORAGE_READINESS_FAILURE],
      });
      expect(probeFs.open).toHaveBeenCalledTimes(2);

      nowMs += 100;
      await expect(checker.refresh()).resolves.toEqual({
        ready: false,
        failing: [STORAGE_READINESS_FAILURE],
      });
      expect(probeFs.open).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
