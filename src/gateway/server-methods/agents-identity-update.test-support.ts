import { randomUUID } from "node:crypto";
import { describe, expect, it, vi, type Mock } from "vitest";
import { registerAgentWorkspaceAccess } from "../../agents/workspace-access.js";
import { FsSafeError, type ReadResult } from "../../infra/fs-safe.js";
import {
  expectRecordFields,
  expectRespondErrorContaining,
  expectRespondOk,
  agentConfig,
  expectUncalled,
  mockCallArg,
} from "./agents-mutate.test-support.js";
type IdentityUpdateHarness = {
  mocks: {
    loadConfigReturn: Record<string, unknown>;
    applyAgentConfig: Mock<(cfg: unknown, opts: unknown) => unknown>;
    ensureAgentWorkspace: Mock<
      (params?: { dir?: string }) => Promise<{ dir: string; identityPathCreated: boolean }>
    >;
    rootRead: Mock<(params: { rootDir: string; relativePath: string }) => Promise<ReadResult>>;
    rootWrite: Mock<(params?: unknown) => Promise<void>>;
    writeConfigFile: Mock<(nextConfig?: unknown, writeOptions?: unknown) => Promise<void>>;
    fsMkdir: unknown;
  };
  makeCall: (
    method: "agents.update",
    params: Record<string, unknown>,
  ) => { respond: Mock; promise: Promise<void> | void };
  call: (method: "agents.update", params: Record<string, unknown>) => Promise<Mock>;
  makeFileStat: () => import("node:fs").Stats;
  createEnoentError: () => Error;
};

export function registerAgentIdentityUpdateTests(harness: IdentityUpdateHarness): void {
  const { mocks, makeCall, call, makeFileStat, createEnoentError } = harness;
  const update = (params: Record<string, unknown>) =>
    call("agents.update", { agentId: "test-agent", ...params });
  function identityRead(rootDir: string, relativePath: string, content: string): ReadResult {
    return {
      buffer: Buffer.from(content),
      realPath: `${rootDir}/${relativePath}`,
      stat: makeFileStat(),
      containment: "best-effort",
      exactIdentity: { dev: 1n, ino: 1n },
    };
  }
  function readIdentities(files: Record<string, string>) {
    mocks.rootRead.mockImplementation(async ({ rootDir, relativePath }) => {
      const content = files[`${rootDir}/${relativePath}`];
      if (content === undefined) {
        throw createEnoentError();
      }
      return identityRead(rootDir, relativePath, content);
    });
  }
  describe("identity", () => {
    it.each(["available", "revoked"] as const)(
      "updates the identity form through remote workspace access when %s",
      async (state) => {
        const workspace = `/remote-identity-${randomUUID()}`;
        mocks.loadConfigReturn = agentConfig({
          "test-agent": { workspace, identity: { name: "Current Agent" } },
        });
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
            expectUncalled(writeFile, mocks.writeConfigFile);
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
          expectUncalled(mocks.rootRead, mocks.rootWrite, mocks.fsMkdir);
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
        return identityRead(
          rootDir,
          relativePath,
          "# Identity\n\n- Name: Current Agent\n\nOriginal notes.\n",
        );
      });
      try {
        const { promise } = makeCall("agents.update", { agentId: "test-agent", workspace });
        await expect(promise).rejects.toThrow("Workspace access changed");
        expectUncalled(oldWrite, replacementWrite, mocks.writeConfigFile);
      } finally {
        releaseOld();
        releaseReplacement();
      }
    });

    it("writes combined identity fields to both config and IDENTITY.md", async () => {
      mocks.rootRead.mockRejectedValue(new FsSafeError("not-found", "file not found"));
      const respond = await update({
        name: "New Name",
        emoji: "🤖",
        avatar: "https://example.com/new.png",
      });

      expectRespondOk(respond, { ok: true, agentId: "test-agent" });
      expectRecordFields(mockCallArg(mocks.rootRead), { relativePath: "IDENTITY.md" });
      expectRecordFields(mockCallArg(mocks.applyAgentConfig, 0, 1), {
        name: "New Name",
        identity: expect.objectContaining({
          name: "New Name",
          emoji: "🤖",
          avatar: "https://example.com/new.png",
        }),
      });
      expectRecordFields(mockCallArg(mocks.rootWrite), {
        rootDir: "/workspace/test-agent",
        relativePath: "IDENTITY.md",
        data: "# IDENTITY.md - Agent Identity\n\n- Name: New Name\n- Theme: steady\n- Emoji: 🤖\n- Avatar: https://example.com/new.png\n",
      });
    });

    it.each([
      {
        created: true,
        source:
          "- Name: Current Agent\n- **Creature:** Steady Turtle\n\n## Role\nProtect the queue.\n",
        destination: "- Name: Dev Agent\n- **Creature:** Flustered Protocol Droid\n",
        kept: ["- **Creature:** Steady Turtle", "## Role"],
        removed: "Flustered Protocol Droid",
      },
      {
        created: false,
        source:
          "- Name: Current Agent\n- **Creature:** Old Turtle\n\n## Role\nOld workspace role.\n",
        destination:
          "- Name: Destination Agent\n- **Creature:** Destination Fox\n\n## Role\nDestination workspace role.\n",
        kept: ["- **Creature:** Destination Fox", "Destination workspace role."],
        removed: "Old workspace role.",
      },
    ])(
      "preserves the correct identity when moving workspace (new=$created)",
      async ({ created, source, destination, kept, removed }) => {
        mocks.ensureAgentWorkspace.mockResolvedValueOnce({
          dir: "/resolved/new/workspace",
          identityPathCreated: created,
        });
        readIdentities({
          "/workspace/test-agent/IDENTITY.md": source,
          "/resolved/new/workspace/IDENTITY.md": destination,
        });
        const respond = await update({ workspace: "/new/workspace" });
        expectRespondOk(respond, { ok: true, agentId: "test-agent" });
        const write = expectRecordFields(mockCallArg(mocks.rootWrite), {
          rootDir: "/resolved/new/workspace",
          relativePath: "IDENTITY.md",
        });
        for (const content of kept) {
          expect(write.data).toEqual(expect.stringContaining(content));
        }
        expect(typeof write.data).toBe("string");
        expect(write.data).not.toContain(removed);
      },
    );

    it.each([
      {
        operation: "write",
        error: new FsSafeError("path-mismatch", "path escapes workspace root"),
        params: { name: "Bad Update", avatar: "https://example.com/avatar.png" },
        message: "unsafe workspace file",
      },
      {
        operation: "read",
        error: new FsSafeError("invalid-path", "path is not a regular file under root"),
        params: { avatar: "https://example.com/unsafe.png" },
        message: 'unsafe workspace file "IDENTITY.md"',
      },
    ])(
      "rejects unsafe identity $operation without persisting config",
      async ({ operation, error, params, message }) => {
        if (operation === "read") {
          mocks.rootRead.mockRejectedValue(error);
        } else {
          mocks.rootWrite.mockRejectedValueOnce(error);
        }
        const respond = await update(params);
        expectRespondErrorContaining(respond, message);
        expect(mocks.writeConfigFile).not.toHaveBeenCalled();
        if (operation === "read") {
          expect(mocks.rootWrite).not.toHaveBeenCalled();
        }
      },
    );
  });
}
