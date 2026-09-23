import { randomUUID } from "node:crypto";
import { describe, expect, it, vi, type Mock } from "vitest";
import { registerAgentWorkspaceAccess } from "../../agents/workspace-access.js";
import { FsSafeError } from "../../infra/fs-safe.js";

type IdentityUpdateHarness = {
  mocks: {
    loadConfigReturn: Record<string, unknown>;
    applyAgentConfig: Mock<(cfg: unknown, opts: unknown) => unknown>;
    ensureAgentWorkspace: Mock<
      (params?: { dir?: string }) => Promise<{ dir: string; identityPathCreated: boolean }>
    >;
    rootRead: Mock<
      (params: { rootDir: string; relativePath: string }) => Promise<{
        buffer: Buffer;
        realPath: string;
        stat: { size: number; mtimeMs: number };
      }>
    >;
    rootWrite: Mock<(params?: unknown) => Promise<void>>;
    writeConfigFile: Mock<(nextConfig?: unknown, writeOptions?: unknown) => Promise<void>>;
    fsMkdir: unknown;
  };
  makeCall: (
    method: "agents.update",
    params: Record<string, unknown>,
  ) => { respond: Mock; promise: Promise<void> | void };
  makeFileStat: () => import("node:fs").Stats;
  createEnoentError: () => Error;
  mockCallArg: (mock: Mock, callIndex?: number, argIndex?: number) => unknown;
  expectRecordFields: (
    record: unknown,
    expected: Record<string, unknown>,
  ) => Record<string, unknown>;
  expectRespondOk: (respond: Mock, expected: Record<string, unknown>) => Record<string, unknown>;
  expectRespondErrorContaining: (respond: Mock, text: string) => Record<string, unknown>;
  expectStringContaining: (value: unknown, text: string) => void;
  expectStringNotContaining: (value: unknown, text: string) => void;
};

/** Share the mutation harness while exercising identity changes through agents.update. */
export function registerAgentIdentityUpdateTests(harness: IdentityUpdateHarness): void {
  const {
    mocks,
    makeCall,
    makeFileStat,
    createEnoentError,
    mockCallArg,
    expectRecordFields,
    expectRespondOk,
    expectRespondErrorContaining,
    expectStringContaining,
    expectStringNotContaining,
  } = harness;
  describe("identity", () => {
    it.each(["available", "revoked"] as const)(
      "updates the identity form through remote workspace access when %s",
      async (state) => {
        const workspace = `/remote-identity-${randomUUID()}`;
        mocks.loadConfigReturn = {
          agents: { list: [{ id: "test-agent", workspace, identity: { name: "Current Agent" } }] },
        };
        let release = () => {};
        const readFile = vi.fn(async () => {
          if (state === "revoked") {
            release();
          }
          return Buffer.from("# Identity\n\n- **Name:** Current Agent\n\nRemote custom notes.\n");
        });
        const writeFile = vi.fn(async () => {});
        release = registerAgentWorkspaceAccess(workspace, {
          bridge: { readFile, writeFile, stat: vi.fn() },
        });
        try {
          const { respond, promise } = makeCall("agents.update", {
            agentId: "test-agent",
            name: "Updated Name",
          });
          if (state === "revoked") {
            await expect(promise).rejects.toThrow("Workspace access");
            expect(writeFile).not.toHaveBeenCalled();
            expect(mocks.writeConfigFile).not.toHaveBeenCalled();
          } else {
            await promise;
            expect(respond).toHaveBeenCalledWith(
              true,
              { ok: true, agentId: "test-agent" },
              undefined,
            );
            expect(writeFile).toHaveBeenCalledWith({
              filePath: "IDENTITY.md",
              data: expect.stringContaining("Updated Name"),
              mkdir: false,
            });
            expect(writeFile).toHaveBeenCalledWith(
              expect.objectContaining({ data: expect.stringContaining("Remote custom notes.") }),
            );
            expect(mocks.writeConfigFile).toHaveBeenCalled();
          }
          expect(mocks.rootRead).not.toHaveBeenCalled();
          expect(mocks.rootWrite).not.toHaveBeenCalled();
          expect(mocks.fsMkdir).not.toHaveBeenCalled();
        } finally {
          release();
        }
      },
    );

    it("does not redirect an identity save when its destination binding changes during fallback read", async () => {
      const workspace = `/identity-move-${randomUUID()}`;
      const destination = `/resolved${workspace}`;
      const oldWrite = vi.fn(async () => {});
      const replacementWrite = vi.fn(async () => {});
      const releaseOld = registerAgentWorkspaceAccess(destination, {
        bridge: {
          readFile: vi.fn(async () => {
            throw createEnoentError();
          }),
          writeFile: oldWrite,
          stat: vi.fn(),
        },
      });
      let releaseReplacement = () => {};
      mocks.ensureAgentWorkspace.mockResolvedValueOnce({
        dir: destination,
        identityPathCreated: false,
      });
      mocks.rootRead.mockImplementation(async ({ rootDir, relativePath }) => {
        expect(rootDir).toBe("/workspace/test-agent");
        releaseOld();
        releaseReplacement = registerAgentWorkspaceAccess(destination, {
          bridge: { readFile: vi.fn(), writeFile: replacementWrite, stat: vi.fn() },
        });
        return {
          buffer: Buffer.from("# Identity\n\n- Name: Current Agent\n\nOriginal notes.\n"),
          realPath: `${rootDir}/${relativePath}`,
          stat: makeFileStat(),
        };
      });
      try {
        const { promise } = makeCall("agents.update", { agentId: "test-agent", workspace });
        await expect(promise).rejects.toThrow("Workspace access changed");
        expect(oldWrite).not.toHaveBeenCalled();
        expect(replacementWrite).not.toHaveBeenCalled();
        expect(mocks.writeConfigFile).not.toHaveBeenCalled();
      } finally {
        releaseOld();
        releaseReplacement();
      }
    });

    it("writes merged identity to IDENTITY.md when only avatar changes", async () => {
      const { respond, promise } = makeCall("agents.update", {
        agentId: "test-agent",
        avatar: "https://example.com/avatar.png",
      });
      await promise;

      expectRespondOk(respond, { ok: true, agentId: "test-agent" });
      const configOptions = expectRecordFields(mockCallArg(mocks.applyAgentConfig, 0, 1), {});
      expectRecordFields(configOptions.identity, {
        avatar: "https://example.com/avatar.png",
      });
      const write = expectRecordFields(mockCallArg(mocks.rootWrite), {
        rootDir: "/workspace/test-agent",
        relativePath: "IDENTITY.md",
      });
      expect(write.data).toBe(
        [
          "# IDENTITY.md - Agent Identity",
          "",
          "- Name: Current Agent",
          "- Theme: steady",
          "- Emoji: 🐢",
          "- Avatar: https://example.com/avatar.png",
          "",
        ].join("\n"),
      );
    });

    it("writes merged identity to IDENTITY.md when only emoji changes", async () => {
      const { respond, promise } = makeCall("agents.update", {
        agentId: "test-agent",
        emoji: "🦀",
      });
      await promise;

      expectRespondOk(respond, { ok: true, agentId: "test-agent" });
      const configOptions = expectRecordFields(mockCallArg(mocks.applyAgentConfig, 0, 1), {});
      expectRecordFields(configOptions.identity, { emoji: "🦀" });
      const write = expectRecordFields(mockCallArg(mocks.rootWrite), {
        rootDir: "/workspace/test-agent",
        relativePath: "IDENTITY.md",
      });
      expect(write.data).toBe(
        [
          "# IDENTITY.md - Agent Identity",
          "",
          "- Name: Current Agent",
          "- Theme: steady",
          "- Emoji: 🦀",
          "",
        ].join("\n"),
      );
    });

    it("writes combined identity fields to both config and IDENTITY.md", async () => {
      const { respond, promise } = makeCall("agents.update", {
        agentId: "test-agent",
        name: "New Name",
        emoji: "🤖",
        avatar: "https://example.com/new.png",
      });
      await promise;

      expectRespondOk(respond, { ok: true, agentId: "test-agent" });
      const configOptions = expectRecordFields(mockCallArg(mocks.applyAgentConfig, 0, 1), {
        name: "New Name",
      });
      expectRecordFields(configOptions.identity, {
        name: "New Name",
        emoji: "🤖",
        avatar: "https://example.com/new.png",
      });
      const write = expectRecordFields(mockCallArg(mocks.rootWrite), {
        rootDir: "/workspace/test-agent",
        relativePath: "IDENTITY.md",
      });
      expect(write.data).toBe(
        [
          "# IDENTITY.md - Agent Identity",
          "",
          "- Name: New Name",
          "- Theme: steady",
          "- Emoji: 🤖",
          "- Avatar: https://example.com/new.png",
          "",
        ].join("\n"),
      );
    });

    it("syncs existing identity into a new workspace even without identity params", async () => {
      mocks.ensureAgentWorkspace.mockResolvedValueOnce({
        dir: "/resolved/new/workspace",
        identityPathCreated: true,
      });
      mocks.rootRead.mockImplementation(async ({ rootDir, relativePath }) => {
        const filePath = `${rootDir}/${relativePath}`;
        if (filePath === "/workspace/test-agent/IDENTITY.md") {
          return {
            buffer: Buffer.from(
              [
                "# IDENTITY.md - Agent Identity",
                "",
                "- **Name:** Current Agent",
                "- **Creature:** Steady Turtle",
                "- **Vibe:** Calm and methodical",
                "- **Emoji:** 🐢",
                "",
                "## Role",
                "",
                "Protect the queue.",
                "",
              ].join("\n"),
            ),
            realPath: filePath,
            stat: makeFileStat(),
          };
        }
        if (filePath === "/resolved/new/workspace/IDENTITY.md") {
          return {
            buffer: Buffer.from(
              [
                "# IDENTITY.md - Agent Identity",
                "",
                "- **Name:** C-3PO (Clawd's Third Protocol Observer)",
                "- **Creature:** Flustered Protocol Droid",
                "",
                "## Role",
                "",
                "Debug agent for `--dev` mode.",
                "",
              ].join("\n"),
            ),
            realPath: filePath,
            stat: makeFileStat(),
          };
        }
        throw createEnoentError();
      });

      const { respond, promise } = makeCall("agents.update", {
        agentId: "test-agent",
        workspace: "/new/workspace",
      });
      await promise;

      expectRespondOk(respond, { ok: true, agentId: "test-agent" });
      const write = expectRecordFields(mockCallArg(mocks.rootWrite), {
        rootDir: "/resolved/new/workspace",
        relativePath: "IDENTITY.md",
      });
      expectStringContaining(write.data, "- **Creature:** Steady Turtle");
      expectStringContaining(write.data, "## Role");
      expectStringNotContaining(write.data, "Flustered Protocol Droid");
    });

    it("preserves an existing destination identity file when workspace changes", async () => {
      mocks.ensureAgentWorkspace.mockResolvedValueOnce({
        dir: "/resolved/new/workspace",
        identityPathCreated: false,
      });
      mocks.rootRead.mockImplementation(async ({ rootDir, relativePath }) => {
        const filePath = `${rootDir}/${relativePath}`;
        if (filePath === "/workspace/test-agent/IDENTITY.md") {
          return {
            buffer: Buffer.from(
              [
                "# IDENTITY.md - Agent Identity",
                "",
                "- **Name:** Current Agent",
                "- **Creature:** Old Turtle",
                "",
                "## Role",
                "",
                "Old workspace role.",
                "",
              ].join("\n"),
            ),
            realPath: filePath,
            stat: makeFileStat(),
          };
        }
        if (filePath === "/resolved/new/workspace/IDENTITY.md") {
          return {
            buffer: Buffer.from(
              [
                "# IDENTITY.md - Agent Identity",
                "",
                "- **Name:** Destination Agent",
                "- **Creature:** Destination Fox",
                "",
                "## Role",
                "",
                "Destination workspace role.",
                "",
              ].join("\n"),
            ),
            realPath: filePath,
            stat: makeFileStat(),
          };
        }
        throw createEnoentError();
      });

      const { respond, promise } = makeCall("agents.update", {
        agentId: "test-agent",
        workspace: "/new/workspace",
      });
      await promise;

      expectRespondOk(respond, { ok: true, agentId: "test-agent" });
      const write = expectRecordFields(mockCallArg(mocks.rootWrite), {
        rootDir: "/resolved/new/workspace",
        relativePath: "IDENTITY.md",
      });
      expectStringContaining(write.data, "- **Creature:** Destination Fox");
      expectStringContaining(write.data, "Destination workspace role.");
      expectStringNotContaining(write.data, "Old workspace role.");
    });

    it("does not persist config when IDENTITY.md write fails on update", async () => {
      mocks.rootWrite.mockRejectedValueOnce(
        new FsSafeError("path-mismatch", "path escapes workspace root"),
      );

      const { respond, promise } = makeCall("agents.update", {
        agentId: "test-agent",
        name: "Bad Update",
        avatar: "https://example.com/avatar.png",
      });
      await promise;

      expectRespondErrorContaining(respond, "unsafe workspace file");
      expect(mocks.writeConfigFile).not.toHaveBeenCalled();
    });

    it("treats unsafe IDENTITY.md reads as invalid update requests", async () => {
      mocks.rootRead.mockRejectedValue(
        new FsSafeError("invalid-path", "path is not a regular file under root"),
      );

      const { respond, promise } = makeCall("agents.update", {
        agentId: "test-agent",
        avatar: "https://example.com/unsafe.png",
      });
      await promise;

      expectRespondErrorContaining(respond, 'unsafe workspace file "IDENTITY.md"');
      expect(mocks.writeConfigFile).not.toHaveBeenCalled();
      expect(mocks.rootWrite).not.toHaveBeenCalled();
    });

    it("uses non-blocking reads for IDENTITY.md during agents.update", async () => {
      mocks.rootRead.mockRejectedValue(new FsSafeError("not-found", "file not found"));

      const { promise } = makeCall("agents.update", {
        agentId: "test-agent",
        name: "Updated NB",
      });
      await promise;

      expectRecordFields(mockCallArg(mocks.rootRead), {
        relativePath: "IDENTITY.md",
        nonBlockingRead: true,
      });
    });
  });
}
