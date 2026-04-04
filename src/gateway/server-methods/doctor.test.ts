import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";

const loadConfig = vi.hoisted(() => vi.fn(() => ({}) as OpenClawConfig));
const resolveDefaultAgentId = vi.hoisted(() => vi.fn(() => "main"));
const getMemorySearchManager = vi.hoisted(() => vi.fn());

vi.mock("../../config/config.js", () => ({
  loadConfig,
}));

vi.mock("../../agents/agent-scope.js", () => ({
  resolveDefaultAgentId,
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
          mode: "off",
          enabled: false,
          shortTermCount: 0,
          promotedTotal: 0,
          promotedToday: 0,
          managedCronPresent: false,
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
    const now = Date.now();
    const todayIso = new Date(now).toISOString();
    const earlierIso = new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString();
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "doctor-memory-status-"));
    const storePath = path.join(workspaceDir, "memory", ".dreams", "short-term-recall.json");
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(
      storePath,
      `${JSON.stringify(
        {
          version: 1,
          updatedAt: todayIso,
          entries: {
            "memory:memory/2026-04-03.md:1:2": {
              path: "memory/2026-04-03.md",
              source: "memory",
              promotedAt: undefined,
            },
            "memory:memory/2026-04-02.md:1:2": {
              path: "memory/2026-04-02.md",
              source: "memory",
              promotedAt: todayIso,
            },
            "memory:memory/2026-04-01.md:1:2": {
              path: "memory/2026-04-01.md",
              source: "memory",
              promotedAt: earlierIso,
            },
            "memory:MEMORY.md:1:2": {
              path: "MEMORY.md",
              source: "memory",
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );

    loadConfig.mockReturnValue({
      plugins: {
        entries: {
          "memory-core": {
            config: {
              dreaming: {
                mode: "rem",
                frequency: "0 */4 * * *",
              },
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
            mode: "rem",
            enabled: true,
            frequency: "0 */4 * * *",
            shortTermCount: 1,
            promotedTotal: 2,
            promotedToday: 1,
            managedCronPresent: true,
            nextRunAtMs: now + 60_000,
          }),
        }),
        undefined,
      );
      expect(close).toHaveBeenCalled();
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });
});
