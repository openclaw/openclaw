import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";

const loadConfig = vi.hoisted(() => vi.fn(() => ({}) as OpenClawConfig));
const resolveDefaultAgentId = vi.hoisted(() => vi.fn(() => "main"));
const resolveAgentWorkspaceDir = vi.hoisted(() =>
  vi.fn((_cfg: OpenClawConfig, _agentId: string) => "/tmp/openclaw"),
);
const resolveMemorySearchConfig = vi.hoisted(() =>
  vi.fn<(_cfg: OpenClawConfig, _agentId: string) => { enabled: boolean } | null>(() => ({
    enabled: true,
  })),
);
const getMemorySearchManager = vi.hoisted(() => vi.fn());

vi.mock("../../config/config.js", () => ({
  loadConfig,
}));

vi.mock("../../agents/agent-scope.js", () => ({
  resolveDefaultAgentId,
  resolveAgentWorkspaceDir,
}));

vi.mock("../../agents/memory-search.js", () => ({
  resolveMemorySearchConfig,
}));

vi.mock("../../plugins/memory-runtime.js", () => ({
  getActiveMemorySearchManager: getMemorySearchManager,
}));

import { doctorHandlers } from "./doctor.js";

const invokeDoctorMemoryStatus = async (
  respond: ReturnType<typeof vi.fn>,
  context?: { cron?: { list?: ReturnType<typeof vi.fn> } },
) => {
  const cronList =
    context?.cron?.list ??
    vi.fn(async () => {
      return [];
    });
  await doctorHandlers["doctor.memory.status"]({
    req: {} as never,
    params: {} as never,
    respond: respond as never,
    context: {
      cron: {
        list: cronList,
      },
    } as never,
    client: null,
    isWebchatConnect: () => false,
  });
};

const invokeDoctorMemoryDreamDiary = async (respond: ReturnType<typeof vi.fn>) => {
  await doctorHandlers["doctor.memory.dreamDiary"]({
    req: {} as never,
    params: {} as never,
    respond: respond as never,
    context: {} as never,
    client: null,
    isWebchatConnect: () => false,
  });
};

const expectEmbeddingErrorResponse = (respond: ReturnType<typeof vi.fn>, error: string) => {
  expect(respond).toHaveBeenCalledWith(
    true,
    expect.objectContaining({
      agentId: "main",
      embedding: {
        ok: false,
        error,
      },
    }),
    undefined,
  );
};

describe("doctor.memory.status", () => {
  beforeEach(() => {
    loadConfig.mockClear();
    resolveDefaultAgentId.mockClear();
    resolveAgentWorkspaceDir.mockReset().mockReturnValue("/tmp/openclaw");
    resolveMemorySearchConfig.mockReset().mockReturnValue({ enabled: true });
    getMemorySearchManager.mockReset();
  });

  it("returns gateway embedding probe status for the default agent", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    getMemorySearchManager.mockResolvedValue({
      manager: {
        status: () => ({ provider: "gemini" }),
        probeEmbeddingAvailability: vi.fn().mockResolvedValue({ ok: true }),
        close,
      },
    });
    const respond = vi.fn();

    await invokeDoctorMemoryStatus(respond);

    expect(getMemorySearchManager).toHaveBeenCalledWith({
      cfg: expect.any(Object),
      agentId: "main",
      purpose: "status",
    });
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        agentId: "main",
        provider: "gemini",
        embedding: { ok: true },
        dreaming: expect.objectContaining({
          enabled: false,
          shortTermCount: 0,
          totalSignalCount: 0,
          phaseSignalCount: 0,
          promotedTotal: 0,
          promotedToday: 0,
          phases: expect.objectContaining({
            deep: expect.objectContaining({
              managedCronPresent: false,
            }),
          }),
        }),
      }),
      undefined,
    );
    expect(close).toHaveBeenCalled();
  });

  it("returns unavailable when memory manager is missing", async () => {
    getMemorySearchManager.mockResolvedValue({
      manager: null,
      error: "memory search unavailable",
    });
    const respond = vi.fn();

    await invokeDoctorMemoryStatus(respond);

    expectEmbeddingErrorResponse(respond, "memory search unavailable");
  });

  it("returns probe failure when manager probe throws", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    getMemorySearchManager.mockResolvedValue({
      manager: {
        status: () => ({ provider: "openai" }),
        probeEmbeddingAvailability: vi.fn().mockRejectedValue(new Error("timeout")),
        close,
      },
    });
    const respond = vi.fn();

    await invokeDoctorMemoryStatus(respond);

    expectEmbeddingErrorResponse(respond, "gateway memory probe failed: timeout");
    expect(close).toHaveBeenCalled();
  });

  it("includes dreaming counts and managed cron status when workspace data is available", async () => {
    const now = Date.parse("2026-04-05T00:30:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const recentIso = "2026-04-04T23:45:00.000Z";
    const olderIso = "2026-04-02T10:00:00.000Z";
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "doctor-memory-status-"));
    const mainWorkspaceDir = path.join(workspaceRoot, "main");
    const alphaWorkspaceDir = path.join(workspaceRoot, "alpha");
    const mainStorePath = path.join(
      mainWorkspaceDir,
      "memory",
      ".dreams",
      "short-term-recall.json",
    );
    const alphaStorePath = path.join(
      alphaWorkspaceDir,
      "memory",
      ".dreams",
      "short-term-recall.json",
    );
    const mainPhaseSignalPath = path.join(
      mainWorkspaceDir,
      "memory",
      ".dreams",
      "phase-signals.json",
    );
    const alphaPhaseSignalPath = path.join(
      alphaWorkspaceDir,
      "memory",
      ".dreams",
      "phase-signals.json",
    );
    await fs.mkdir(path.dirname(mainStorePath), { recursive: true });
    await fs.mkdir(path.dirname(alphaStorePath), { recursive: true });
    await fs.writeFile(
      mainStorePath,
      `${JSON.stringify(
        {
          version: 1,
          updatedAt: recentIso,
          entries: {
            "memory:memory/2026-04-03.md:1:2": {
              path: "memory/2026-04-03.md",
              source: "memory",
              recallCount: 2,
              dailyCount: 1,
              promotedAt: undefined,
            },
            "memory:memory/2026-04-02.md:1:2": {
              path: "memory/2026-04-02.md",
              source: "memory",
              recallCount: 9,
              dailyCount: 5,
              promotedAt: recentIso,
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );
    await fs.writeFile(
      alphaStorePath,
      `${JSON.stringify(
        {
          version: 1,
          updatedAt: recentIso,
          entries: {
            "memory:memory/2026-04-01.md:1:2": {
              path: "memory/2026-04-01.md",
              source: "memory",
              recallCount: 7,
              dailyCount: 4,
              promotedAt: olderIso,
            },
            "memory:memory/2026-04-04.md:1:2": {
              path: "memory/2026-04-04.md",
              source: "memory",
              recallCount: 8,
              dailyCount: 3,
              promotedAt: recentIso,
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );
    await fs.writeFile(
      mainPhaseSignalPath,
      `${JSON.stringify(
        {
          version: 1,
          updatedAt: recentIso,
          entries: {
            "memory:memory/2026-04-03.md:1:2": {
              lightHits: 2,
              remHits: 3,
            },
            "memory:memory/2026-04-02.md:1:2": {
              lightHits: 9,
              remHits: 9,
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );
    await fs.writeFile(
      alphaPhaseSignalPath,
      `${JSON.stringify(
        {
          version: 1,
          updatedAt: recentIso,
          entries: {
            "memory:memory/2026-04-01.md:1:2": {
              lightHits: 5,
              remHits: 5,
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );

    loadConfig.mockReturnValue({
      agents: {
        defaults: {
          userTimezone: "America/Los_Angeles",
          memorySearch: {
            enabled: true,
          },
        },
        list: [
          { id: "main", workspace: mainWorkspaceDir },
          { id: "alpha", workspace: alphaWorkspaceDir },
        ],
      },
      plugins: {
        entries: {
          "memory-core": {
            config: {
              dreaming: {
                enabled: true,
                frequency: "0 */4 * * *",
                phases: {
                  deep: {
                    recencyHalfLifeDays: 21,
                    maxAgeDays: 30,
                  },
                },
              },
            },
          },
        },
      },
    } as OpenClawConfig);
    resolveAgentWorkspaceDir.mockImplementation((cfg: OpenClawConfig, agentId: string) => {
      if (agentId === "alpha") {
        return alphaWorkspaceDir;
      }
      return mainWorkspaceDir;
    });

    const close = vi.fn().mockResolvedValue(undefined);
    getMemorySearchManager.mockResolvedValue({
      manager: {
        status: () => ({ provider: "gemini", workspaceDir: mainWorkspaceDir }),
        probeEmbeddingAvailability: vi.fn().mockResolvedValue({ ok: true }),
        close,
      },
    });

    const cronList = vi.fn(async () => [
      {
        name: "Memory Dreaming Promotion",
        description: "[managed-by=memory-core.short-term-promotion] test",
        enabled: true,
        payload: {
          kind: "systemEvent",
          text: "__openclaw_memory_core_short_term_promotion_dream__",
        },
        state: { nextRunAtMs: now + 60_000 },
      },
    ]);
    const respond = vi.fn();

    try {
      await invokeDoctorMemoryStatus(respond, { cron: { list: cronList } });
      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({
          agentId: "main",
          provider: "gemini",
          embedding: { ok: true },
          dreaming: expect.objectContaining({
            enabled: true,
            timezone: "America/Los_Angeles",
            shortTermCount: 1,
            recallSignalCount: 2,
            dailySignalCount: 1,
            totalSignalCount: 3,
            phaseSignalCount: 5,
            lightPhaseHitCount: 2,
            remPhaseHitCount: 3,
            promotedTotal: 3,
            promotedToday: 2,
            phases: expect.objectContaining({
              deep: expect.objectContaining({
                cron: "0 */4 * * *",
                recencyHalfLifeDays: 21,
                maxAgeDays: 30,
                managedCronPresent: true,
                nextRunAtMs: now + 60_000,
              }),
            }),
          }),
        }),
        undefined,
      );
      expect(close).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("falls back to the manager workspace when no configured dreaming workspaces resolve", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "doctor-memory-fallback-"));
    const storePath = path.join(workspaceDir, "memory", ".dreams", "short-term-recall.json");
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(
      storePath,
      `${JSON.stringify(
        {
          version: 1,
          updatedAt: "2026-04-04T00:00:00.000Z",
          entries: {
            "memory:memory/2026-04-03.md:1:2": {
              path: "memory/2026-04-03.md",
              source: "memory",
              promotedAt: "2026-04-04T00:00:00.000Z",
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );
    resolveMemorySearchConfig.mockReturnValue(null);
    loadConfig.mockReturnValue({
      plugins: {
        entries: {
          "memory-core": {
            config: {
              dreaming: {},
            },
          },
        },
      },
    } as OpenClawConfig);

    const close = vi.fn().mockResolvedValue(undefined);
    getMemorySearchManager.mockResolvedValue({
      manager: {
        status: () => ({ provider: "gemini", workspaceDir }),
        probeEmbeddingAvailability: vi.fn().mockResolvedValue({ ok: true }),
        close,
      },
    });
    const respond = vi.fn();

    try {
      await invokeDoctorMemoryStatus(respond);
      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({
          dreaming: expect.objectContaining({
            shortTermCount: 0,
            promotedTotal: 0,
            phases: expect.objectContaining({
              deep: expect.objectContaining({
                managedCronPresent: false,
              }),
            }),
          }),
        }),
        undefined,
      );
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("reads dreaming config from the selected memory slot plugin", async () => {
    loadConfig.mockReturnValue({
      plugins: {
        slots: {
          memory: "memos-local-openclaw-plugin",
        },
        entries: {
          "memos-local-openclaw-plugin": {
            config: {
              dreaming: {
                enabled: true,
                frequency: "0 */4 * * *",
              },
            },
          },
          "memory-core": {
            config: {
              dreaming: {
                enabled: false,
              },
            },
          },
        },
      },
    } as OpenClawConfig);

    const close = vi.fn().mockResolvedValue(undefined);
    getMemorySearchManager.mockResolvedValue({
      manager: {
        status: () => ({ provider: "gemini" }),
        probeEmbeddingAvailability: vi.fn().mockResolvedValue({ ok: true }),
        close,
      },
    });
    const respond = vi.fn();

    await invokeDoctorMemoryStatus(respond);

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        dreaming: expect.objectContaining({
          enabled: true,
          phases: expect.objectContaining({
            deep: expect.objectContaining({
              cron: "0 */4 * * *",
            }),
          }),
        }),
      }),
      undefined,
    );
    expect(close).toHaveBeenCalled();
  });

  it("merges workspace store errors when multiple workspace stores are unreadable", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "doctor-memory-error-"));
    const mainWorkspaceDir = path.join(workspaceRoot, "main");
    const alphaWorkspaceDir = path.join(workspaceRoot, "alpha");
    const alphaStorePath = path.join(
      alphaWorkspaceDir,
      "memory",
      ".dreams",
      "short-term-recall.json",
    );
    await fs.mkdir(path.dirname(alphaStorePath), { recursive: true });
    await fs.writeFile(
      alphaStorePath,
      `${JSON.stringify(
        {
          version: 1,
          updatedAt: "2026-04-04T00:00:00.000Z",
          entries: {},
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );
    await fs.mkdir(path.join(mainWorkspaceDir, "memory", ".dreams"), { recursive: true });

    loadConfig.mockReturnValue({
      agents: {
        defaults: {
          memorySearch: {
            enabled: true,
          },
        },
        list: [
          { id: "main", workspace: mainWorkspaceDir },
          { id: "alpha", workspace: alphaWorkspaceDir },
        ],
      },
      plugins: {
        entries: {
          "memory-core": {
            config: {
              dreaming: {},
            },
          },
        },
      },
    } as OpenClawConfig);
    resolveAgentWorkspaceDir.mockImplementation((_cfg: OpenClawConfig, agentId: string) =>
      agentId === "alpha" ? alphaWorkspaceDir : mainWorkspaceDir,
    );

    const readFileSpy = vi.spyOn(fs, "readFile").mockImplementation(async (target, options) => {
      const targetPath =
        typeof target === "string"
          ? target
          : Buffer.isBuffer(target)
            ? target.toString("utf-8")
            : target instanceof URL
              ? target.pathname
              : "";
      if (
        targetPath === path.join(mainWorkspaceDir, "memory", ".dreams", "short-term-recall.json") ||
        targetPath === alphaStorePath
      ) {
        const error = Object.assign(new Error("denied"), { code: "EACCES" });
        throw error;
      }
      return await vi
        .importActual<typeof import("node:fs/promises")>("node:fs/promises")
        .then((actual) => actual.readFile(target, options as never));
    });

    const close = vi.fn().mockResolvedValue(undefined);
    getMemorySearchManager.mockResolvedValue({
      manager: {
        status: () => ({ provider: "gemini", workspaceDir: mainWorkspaceDir }),
        probeEmbeddingAvailability: vi.fn().mockResolvedValue({ ok: true }),
        close,
      },
    });
    const respond = vi.fn();

    try {
      await invokeDoctorMemoryStatus(respond);
      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({
          dreaming: expect.objectContaining({
            shortTermCount: 0,
            promotedTotal: 0,
            storeError: "2 dreaming stores had read errors.",
          }),
        }),
        undefined,
      );
    } finally {
      readFileSpy.mockRestore();
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});

describe("doctor.memory.dreamDiary", () => {
  beforeEach(() => {
    loadConfig.mockClear();
    resolveDefaultAgentId.mockClear();
    resolveAgentWorkspaceDir.mockReset().mockReturnValue("/tmp/openclaw");
  });

  it("reads DREAMS.md when present", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "doctor-dream-diary-upper-"));
    const diaryPath = path.join(workspaceDir, "DREAMS.md");
    await fs.writeFile(diaryPath, "## Dream Diary\n- staged durable memory\n", "utf-8");
    resolveAgentWorkspaceDir.mockReturnValue(workspaceDir);
    const respond = vi.fn();

    try {
      await invokeDoctorMemoryDreamDiary(respond);
      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({
          agentId: "main",
          found: true,
          path: "DREAMS.md",
          content: "## Dream Diary\n- staged durable memory\n",
          updatedAtMs: expect.any(Number),
        }),
        undefined,
      );
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("reads lowercase dreams.md when present", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "doctor-dream-diary-lower-"));
    await fs.writeFile(path.join(workspaceDir, "dreams.md"), "lowercase diary\n", "utf-8");
    resolveAgentWorkspaceDir.mockReturnValue(workspaceDir);
    const respond = vi.fn();

    try {
      await invokeDoctorMemoryDreamDiary(respond);
      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({
          agentId: "main",
          found: true,
          content: "lowercase diary\n",
          updatedAtMs: expect.any(Number),
        }),
        undefined,
      );
      const payload = respond.mock.calls[0]?.[1] as { path?: unknown };
      expect(["DREAMS.md", "dreams.md"]).toContain(payload.path);
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("returns not-found payload when no dream diary exists", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "doctor-dream-diary-missing-"));
    resolveAgentWorkspaceDir.mockReturnValue(workspaceDir);
    const respond = vi.fn();

    try {
      await invokeDoctorMemoryDreamDiary(respond);
      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({
          agentId: "main",
          found: false,
          path: "DREAMS.md",
        }),
        undefined,
      );
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });
});
