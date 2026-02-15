import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const agentCommand = vi.fn();

vi.mock("../commands/agent.js", () => ({ agentCommand }));

const { runBootOnce } = await import("./boot.js");
const { resolveMainSessionKey } = await import("../config/sessions/main-session.js");
const { saveSessionStore } = await import("../config/sessions/store.js");
const { resolveStorePath } = await import("../config/sessions/paths.js");
const { resolveAgentIdFromSessionKey } = await import("../config/sessions/main-session.js");

describe("runBootOnce", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const makeDeps = () => ({
    sendMessageWhatsApp: vi.fn(),
    sendMessageTelegram: vi.fn(),
    sendMessageDiscord: vi.fn(),
    sendMessageSlack: vi.fn(),
    sendMessageSignal: vi.fn(),
    sendMessageIMessage: vi.fn(),
  });

  it("skips when BOOT.md is missing", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-boot-"));
    await expect(runBootOnce({ cfg: {}, deps: makeDeps(), workspaceDir })).resolves.toEqual({
      status: "skipped",
      reason: "missing",
    });
    expect(agentCommand).not.toHaveBeenCalled();
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  it("skips when BOOT.md is empty", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-boot-"));
    await fs.writeFile(path.join(workspaceDir, "BOOT.md"), "   \n", "utf-8");
    await expect(runBootOnce({ cfg: {}, deps: makeDeps(), workspaceDir })).resolves.toEqual({
      status: "skipped",
      reason: "empty",
    });
    expect(agentCommand).not.toHaveBeenCalled();
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  it("runs agent command when BOOT.md exists", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-boot-"));
    const content = "Say hello when you wake up.";
    await fs.writeFile(path.join(workspaceDir, "BOOT.md"), content, "utf-8");

    agentCommand.mockResolvedValue(undefined);
    await expect(runBootOnce({ cfg: {}, deps: makeDeps(), workspaceDir })).resolves.toEqual({
      status: "ran",
    });

    expect(agentCommand).toHaveBeenCalledTimes(1);
    const call = agentCommand.mock.calls[0]?.[0];
    expect(call).toEqual(
      expect.objectContaining({
        deliver: false,
        sessionKey: resolveMainSessionKey({}),
      }),
    );
    expect(call?.message).toContain("BOOT.md:");
    expect(call?.message).toContain(content);
    expect(call?.message).toContain("NO_REPLY");

    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  it("generates new session ID when no existing session exists", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-boot-"));
    const content = "Say hello when you wake up.";
    await fs.writeFile(path.join(workspaceDir, "BOOT.md"), content, "utf-8");

    agentCommand.mockResolvedValue(undefined);
    const cfg = {};
    await expect(runBootOnce({ cfg, deps: makeDeps(), workspaceDir })).resolves.toEqual({
      status: "ran",
    });

    expect(agentCommand).toHaveBeenCalledTimes(1);
    const call = agentCommand.mock.calls[0]?.[0];

    // Verify a boot-style session ID was generated (format: boot-YYYY-MM-DD_HH-MM-SS-xxx-xxxxxxxx)
    expect(call?.sessionId).toMatch(/^boot-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}-\d{3}-[0-9a-f]{8}$/);

    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  it("reuses existing session ID when session mapping exists", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-boot-"));
    const content = "Say hello when you wake up.";
    await fs.writeFile(path.join(workspaceDir, "BOOT.md"), content, "utf-8");

    // Create a session store with an existing session
    const cfg = {};
    const sessionKey = resolveMainSessionKey(cfg);
    const agentId = resolveAgentIdFromSessionKey(sessionKey);
    const storePath = resolveStorePath(undefined, { agentId });
    const existingSessionId = "existing-session-abc123";

    await saveSessionStore(storePath, {
      [sessionKey]: {
        sessionId: existingSessionId,
        updatedAt: Date.now(),
      },
    });

    agentCommand.mockResolvedValue(undefined);
    await expect(runBootOnce({ cfg, deps: makeDeps(), workspaceDir })).resolves.toEqual({
      status: "ran",
    });

    expect(agentCommand).toHaveBeenCalledTimes(1);
    const call = agentCommand.mock.calls[0]?.[0];

    // Verify the existing session ID was reused
    expect(call?.sessionId).toBe(existingSessionId);
    expect(call?.sessionKey).toBe(sessionKey);

    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  it("appends boot message to existing session transcript", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-boot-"));
    const content = "Check if the system is healthy.";
    await fs.writeFile(path.join(workspaceDir, "BOOT.md"), content, "utf-8");

    // Create a session store with an existing session
    const cfg = {};
    const sessionKey = resolveMainSessionKey(cfg);
    const agentId = resolveAgentIdFromSessionKey(sessionKey);
    const storePath = resolveStorePath(undefined, { agentId });
    const existingSessionId = "test-session-xyz789";

    await saveSessionStore(storePath, {
      [sessionKey]: {
        sessionId: existingSessionId,
        updatedAt: Date.now() - 60_000, // 1 minute ago
      },
    });

    agentCommand.mockResolvedValue(undefined);
    await expect(runBootOnce({ cfg, deps: makeDeps(), workspaceDir })).resolves.toEqual({
      status: "ran",
    });

    const call = agentCommand.mock.calls[0]?.[0];

    // Verify boot message uses the existing session
    expect(call?.sessionId).toBe(existingSessionId);
    expect(call?.sessionKey).toBe(sessionKey);

    // The agent command should append to the existing session's JSONL file
    // (actual file append is handled by agentCommand, we just verify the IDs match)

    await fs.rm(workspaceDir, { recursive: true, force: true });
  });
});
