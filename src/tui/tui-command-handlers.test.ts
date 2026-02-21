import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi, beforeAll, afterAll } from "vitest";
import { createCommandHandlers } from "./tui-command-handlers.js";

describe("tui command handlers", () => {
  it("forwards unknown slash commands to the gateway", async () => {
    const sendChat = vi.fn().mockResolvedValue({ runId: "r1" });
    const addUser = vi.fn();
    const addSystem = vi.fn();
    const requestRender = vi.fn();
    const setActivityStatus = vi.fn();

    const { handleCommand } = createCommandHandlers({
      client: { sendChat } as never,
      chatLog: { addUser, addSystem } as never,
      tui: { requestRender } as never,
      opts: {},
      state: {
        currentSessionKey: "agent:main:main",
        activeChatRunId: null,
        sessionInfo: {},
      } as never,
      deliverDefault: false,
      openOverlay: vi.fn(),
      closeOverlay: vi.fn(),
      refreshSessionInfo: vi.fn(),
      loadHistory: vi.fn(),
      setSession: vi.fn(),
      refreshAgents: vi.fn(),
      abortActive: vi.fn(),
      setActivityStatus,
      formatSessionKey: vi.fn(),
      applySessionInfoFromPatch: vi.fn(),
      noteLocalRunId: vi.fn(),
    });

    await handleCommand("/context");

    expect(addSystem).not.toHaveBeenCalled();
    expect(addUser).toHaveBeenCalledWith("/context");
    expect(sendChat).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:main:main",
        message: "/context",
      }),
    );
    expect(requestRender).toHaveBeenCalled();
  });

  it("passes reset reason when handling /new and /reset", async () => {
    const resetSession = vi.fn().mockResolvedValue({ ok: true });
    const addSystem = vi.fn();
    const requestRender = vi.fn();
    const loadHistory = vi.fn().mockResolvedValue(undefined);

    const { handleCommand } = createCommandHandlers({
      client: { resetSession } as never,
      chatLog: { addSystem } as never,
      tui: { requestRender } as never,
      opts: {},
      state: {
        currentSessionKey: "agent:main:main",
        activeChatRunId: null,
        sessionInfo: {},
      } as never,
      deliverDefault: false,
      openOverlay: vi.fn(),
      closeOverlay: vi.fn(),
      refreshSessionInfo: vi.fn(),
      loadHistory,
      setSession: vi.fn(),
      refreshAgents: vi.fn(),
      abortActive: vi.fn(),
      setActivityStatus: vi.fn(),
      formatSessionKey: vi.fn(),
      applySessionInfoFromPatch: vi.fn(),
      noteLocalRunId: vi.fn(),
    });

    await handleCommand("/new");
    await handleCommand("/reset");

    expect(resetSession).toHaveBeenNthCalledWith(1, "agent:main:main", "new");
    expect(resetSession).toHaveBeenNthCalledWith(2, "agent:main:main", "reset");
    expect(loadHistory).toHaveBeenCalledTimes(2);
  });

  describe("/image command", () => {
    const testDir = join(tmpdir(), "openclaw-tui-test-images");
    const testImagePath = join(testDir, "test.png");
    // 1x1 red PNG
    const pngBytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==",
      "base64",
    );

    beforeAll(() => {
      mkdirSync(testDir, { recursive: true });
      writeFileSync(testImagePath, pngBytes);
    });

    afterAll(() => {
      rmSync(testDir, { recursive: true, force: true });
    });

    function makeContext() {
      const sendChat = vi.fn().mockResolvedValue({ runId: "r1" });
      const addUser = vi.fn();
      const addSystem = vi.fn();
      const requestRender = vi.fn();
      const setActivityStatus = vi.fn();

      const handlers = createCommandHandlers({
        client: { sendChat } as never,
        chatLog: { addUser, addSystem } as never,
        tui: { requestRender } as never,
        opts: {},
        state: {
          currentSessionKey: "agent:main:main",
          activeChatRunId: null,
          sessionInfo: {},
        } as never,
        deliverDefault: false,
        openOverlay: vi.fn(),
        closeOverlay: vi.fn(),
        refreshSessionInfo: vi.fn(),
        loadHistory: vi.fn(),
        setSession: vi.fn(),
        refreshAgents: vi.fn(),
        abortActive: vi.fn(),
        setActivityStatus,
        formatSessionKey: vi.fn(),
        applySessionInfoFromPatch: vi.fn(),
        noteLocalRunId: vi.fn(),
      });

      return { ...handlers, sendChat, addUser, addSystem, requestRender, setActivityStatus };
    }

    it("shows usage when no args", async () => {
      const ctx = makeContext();
      await ctx.handleCommand("/image");
      expect(ctx.addSystem).toHaveBeenCalledWith("usage: /image <path> [message]");
    });

    it("attaches image file as pending", async () => {
      const ctx = makeContext();
      await ctx.handleCommand(`/image ${testImagePath}`);
      expect(ctx.addSystem).toHaveBeenCalledWith(expect.stringContaining("attached test.png"));
      expect(ctx.getPendingAttachmentCount()).toBe(1);
    });

    it("sends immediately with inline message", async () => {
      const ctx = makeContext();
      await ctx.handleCommand(`/image ${testImagePath} describe this image`);
      expect(ctx.sendChat).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "describe this image",
          attachments: expect.arrayContaining([
            expect.objectContaining({
              type: "image",
              mimeType: "image/png",
              fileName: "test.png",
            }),
          ]),
        }),
      );
    });

    it("consumes pending attachments on normal send", async () => {
      const ctx = makeContext();
      // Attach first
      await ctx.handleCommand(`/image ${testImagePath}`);
      expect(ctx.getPendingAttachmentCount()).toBe(1);
      // Send message — should consume pending
      await ctx.sendMessage("what is this?");
      expect(ctx.sendChat).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "what is this?",
          attachments: expect.arrayContaining([expect.objectContaining({ fileName: "test.png" })]),
        }),
      );
      // Pending should be cleared
      expect(ctx.getPendingAttachmentCount()).toBe(0);
    });

    it("rejects non-image files", async () => {
      const textFile = join(testDir, "readme.txt");
      writeFileSync(textFile, "hello");
      const ctx = makeContext();
      await ctx.handleCommand(`/image ${textFile}`);
      expect(ctx.addSystem).toHaveBeenCalledWith(expect.stringContaining("unsupported image type"));
    });

    it("/detach clears pending attachments", async () => {
      const ctx = makeContext();
      await ctx.handleCommand(`/image ${testImagePath}`);
      expect(ctx.getPendingAttachmentCount()).toBe(1);
      await ctx.handleCommand("/detach");
      expect(ctx.getPendingAttachmentCount()).toBe(0);
      expect(ctx.addSystem).toHaveBeenCalledWith("cleared 1 pending attachment(s)");
    });
  });
});
