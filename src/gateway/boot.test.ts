import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionScope } from "../config/sessions/types.js";
import { isBootRunSessionKey } from "../sessions/session-key-utils.js";

const agentCommand = vi.fn();

vi.mock("../commands/agent.js", () => ({
  agentCommand,
  agentCommandFromIngress: agentCommand,
}));

const { runBootOnce } = await import("./boot.js");
const { resolveAgentIdFromSessionKey, resolveMainSessionKey } =
  await import("../config/sessions/main-session.js");
const { resolveStorePath } = await import("../config/sessions/paths.js");
const { loadSessionStore, saveSessionStore } = await import("../config/sessions/store.js");

describe("runBootOnce", () => {
  type BootWorkspaceOptions = {
    bootAsDirectory?: boolean;
    bootContent?: string;
  };

  const resolveMainStore = (
    cfg: {
      session?: { store?: string; scope?: SessionScope; mainKey?: string };
      agents?: { list?: Array<{ id?: string; default?: boolean }> };
    } = {},
  ) => {
    const sessionKey = resolveMainSessionKey(cfg);
    const agentId = resolveAgentIdFromSessionKey(sessionKey);
    const storePath = resolveStorePath(cfg.session?.store, { agentId });
    return { sessionKey, storePath };
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    const { storePath } = resolveMainStore();
    await fs.rm(storePath, { force: true });
  });

  const makeDeps = () => ({
    sendMessageWhatsApp: vi.fn(),
    sendMessageTelegram: vi.fn(),
    sendMessageDiscord: vi.fn(),
    sendMessageSlack: vi.fn(),
    sendMessageSignal: vi.fn(),
    sendMessageIMessage: vi.fn(),
  });

  const withBootWorkspace = async (
    options: BootWorkspaceOptions,
    run: (workspaceDir: string) => Promise<void>,
  ) => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-boot-"));
    try {
      const bootPath = path.join(workspaceDir, "BOOT.md");
      if (options.bootAsDirectory) {
        await fs.mkdir(bootPath, { recursive: true });
      } else if (typeof options.bootContent === "string") {
        await fs.writeFile(bootPath, options.bootContent, "utf-8");
      }
      await run(workspaceDir);
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  };

  const mockAgentWritesBootSession = (storePath: string) => {
    agentCommand.mockImplementation(async (opts: { sessionId?: string; sessionKey?: string }) => {
      if (!opts.sessionKey) {
        return;
      }
      const current = loadSessionStore(storePath, { skipCache: true });
      current[opts.sessionKey] = {
        sessionId: String(opts.sessionId),
        updatedAt: Date.now(),
      };
      await saveSessionStore(storePath, current);
    });
  };

  const requireAgentCall = () => {
    const [call] = agentCommand.mock.calls[0] ?? [];
    if (!call || typeof call !== "object") {
      throw new Error("expected agent command call");
    }
    return call as Record<string, unknown>;
  };

  it("skips when BOOT.md is missing", async () => {
    await withBootWorkspace({}, async (workspaceDir) => {
      await expect(runBootOnce({ cfg: {}, deps: makeDeps(), workspaceDir })).resolves.toEqual({
        status: "skipped",
        reason: "missing",
      });
      expect(agentCommand).not.toHaveBeenCalled();
    });
  });

  it("returns failed when BOOT.md cannot be read", async () => {
    await withBootWorkspace({ bootAsDirectory: true }, async (workspaceDir) => {
      const result = await runBootOnce({ cfg: {}, deps: makeDeps(), workspaceDir });
      expect(result.status).toBe("failed");
      if (result.status === "failed") {
        expect(result.reason.length).toBeGreaterThan(0);
      }
      expect(agentCommand).not.toHaveBeenCalled();
    });
  });

  it.each([
    { title: "empty", content: "   \n", reason: "empty" as const },
    { title: "whitespace-only", content: "\n\t ", reason: "empty" as const },
  ])("skips when BOOT.md is $title", async ({ content, reason }) => {
    await withBootWorkspace({ bootContent: content }, async (workspaceDir) => {
      await expect(runBootOnce({ cfg: {}, deps: makeDeps(), workspaceDir })).resolves.toEqual({
        status: "skipped",
        reason,
      });
      expect(agentCommand).not.toHaveBeenCalled();
    });
  });

  it("runs agent command against a boot-shaped session key, not the main session", async () => {
    const content = "Say hello when you wake up.";
    await withBootWorkspace({ bootContent: content }, async (workspaceDir) => {
      agentCommand.mockResolvedValue(undefined);
      await expect(runBootOnce({ cfg: {}, deps: makeDeps(), workspaceDir })).resolves.toEqual({
        status: "ran",
      });

      expect(agentCommand).toHaveBeenCalledTimes(1);
      const call = requireAgentCall();
      expect(call.deliver).toBe(false);
      expect(call.sessionKey).not.toBe(resolveMainSessionKey({}));
      expect(typeof call.sessionKey).toBe("string");
      expect(isBootRunSessionKey(call.sessionKey as string)).toBe(true);
      expect(call.message).toContain("BOOT.md:");
      expect(call.message).toContain(content);
      expect(call.message).toContain("NO_REPLY");
    });
  });

  it("returns failed when agent command throws", async () => {
    await withBootWorkspace({ bootContent: "Wake up and report." }, async (workspaceDir) => {
      agentCommand.mockRejectedValue(new Error("boom"));
      await expect(runBootOnce({ cfg: {}, deps: makeDeps(), workspaceDir })).resolves.toEqual({
        status: "failed",
        reason: "agent run failed: boom",
      });
      expect(agentCommand).toHaveBeenCalledTimes(1);
    });
  });

  it("scopes the boot session key to the agentId when provided", async () => {
    await withBootWorkspace({ bootContent: "Check status." }, async (workspaceDir) => {
      agentCommand.mockResolvedValue(undefined);
      const agentId = "ops";
      await expect(
        runBootOnce({ cfg: {}, deps: makeDeps(), workspaceDir, agentId }),
      ).resolves.toEqual({ status: "ran" });

      expect(agentCommand).toHaveBeenCalledTimes(1);
      const sessionKey = requireAgentCall().sessionKey as string;
      expect(isBootRunSessionKey(sessionKey)).toBe(true);
      expect(sessionKey.startsWith(`agent:${agentId}:boot:run:`)).toBe(true);
    });
  });

  it("generates a boot-style session ID", async () => {
    await withBootWorkspace(
      { bootContent: "Say hello when you wake up." },
      async (workspaceDir) => {
        agentCommand.mockResolvedValue(undefined);
        await expect(runBootOnce({ cfg: {}, deps: makeDeps(), workspaceDir })).resolves.toEqual({
          status: "ran",
        });

        expect(agentCommand).toHaveBeenCalledTimes(1);
        expect(requireAgentCall().sessionId).toMatch(
          /^boot-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}-\d{3}-[0-9a-f]{8}$/,
        );
      },
    );
  });

  it("leaves the main session mapping untouched even when it already exists", async () => {
    await withBootWorkspace(
      { bootContent: "Check if the system is healthy." },
      async (workspaceDir) => {
        const cfg = {};
        const { sessionKey: mainSessionKey, storePath } = resolveMainStore(cfg);
        const existingSessionId = "main-session-xyz789";

        await saveSessionStore(storePath, {
          [mainSessionKey]: {
            sessionId: existingSessionId,
            updatedAt: Date.now() - 60_000,
          },
        });

        mockAgentWritesBootSession(storePath);
        await expect(runBootOnce({ cfg, deps: makeDeps(), workspaceDir })).resolves.toEqual({
          status: "ran",
        });

        const after = loadSessionStore(storePath, { skipCache: true });
        expect(after[mainSessionKey]?.sessionId).toBe(existingSessionId);
      },
    );
  });

  it("clears its own boot session mapping after the run", async () => {
    await withBootWorkspace({ bootContent: "health check" }, async (workspaceDir) => {
      const cfg = {};
      const { storePath } = resolveMainStore(cfg);

      mockAgentWritesBootSession(storePath);
      await expect(runBootOnce({ cfg, deps: makeDeps(), workspaceDir })).resolves.toEqual({
        status: "ran",
      });

      const bootSessionKey = requireAgentCall().sessionKey as string;
      const after = loadSessionStore(storePath, { skipCache: true });
      expect(after[bootSessionKey]).toBeUndefined();
    });
  });
});
