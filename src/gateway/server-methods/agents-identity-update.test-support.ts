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
  const beginUpdate = (params: Record<string, unknown>) =>
    makeCall("agents.update", { agentId: "test-agent", ...params });
  const bindWorkspace = (
    workspace: string,
    readFile: () => Promise<Buffer>,
    writeFile = vi.fn(async () => {}),
  ) => registerAgentWorkspaceAccess(workspace, { bridge: { readFile, writeFile, stat: vi.fn() } });
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
    it.each(["revoked", "replaced during fallback"] as const)(
      "does not write identity or config after workspace access is %s",
      async (state) => {
        const workspace = `/remote-identity-${randomUUID()}`;
        const fallback = state === "replaced during fallback";
        const destination = fallback ? `/resolved${workspace}` : workspace;
        if (fallback) {
          mocks.ensureAgentWorkspace.mockResolvedValueOnce({
            dir: destination,
            identityPathCreated: false,
          });
        } else {
          mocks.loadConfigReturn = agentConfig({
            "test-agent": { workspace, identity: { name: "Current Agent" } },
          });
        }
        using bindings = new DisposableStack();
        let release = () => {};
        const writeFile = vi.fn(async () => {});
        const replacementWrite = vi.fn(async () => {});
        const content = "# Identity\n\n- **Name:** Current Agent\n\nRemote custom notes.\n";
        release = bindWorkspace(
          destination,
          async () => {
            if (fallback) {
              throw createEnoentError();
            }
            release();
            return Buffer.from(content);
          },
          writeFile,
        );
        bindings.defer(release);
        if (fallback) {
          mocks.rootRead.mockImplementation(async ({ rootDir, relativePath }) => {
            expect(rootDir).toBe("/workspace/test-agent");
            release();
            bindings.defer(bindWorkspace(destination, vi.fn(), replacementWrite));
            return identityRead(rootDir, relativePath, content);
          });
        }
        const { promise } = beginUpdate(fallback ? { workspace } : { name: "Updated Name" });
        await expect(promise).rejects.toThrow(
          fallback ? "Workspace access changed" : "Workspace access",
        );
        expectUncalled(writeFile, replacementWrite, mocks.writeConfigFile);
        expectUncalled(mocks.rootWrite, mocks.fsMkdir);
        if (!fallback) {
          expectUncalled(mocks.rootRead);
        }
      },
    );

    it("writes combined identity fields to both config and IDENTITY.md", async () => {
      mocks.rootRead.mockRejectedValue(new FsSafeError("not-found", "file not found"));
      const identity = { name: "New Name", emoji: "🤖", avatar: "https://example.com/new.png" };
      const respond = await update(identity);

      expectRespondOk(respond, { ok: true, agentId: "test-agent" });
      expectRecordFields(mockCallArg(mocks.applyAgentConfig, 0, 1), {
        name: "New Name",
        identity: expect.objectContaining(identity),
      });
      expectRecordFields(mockCallArg(mocks.rootWrite), {
        rootDir: "/workspace/test-agent",
        relativePath: "IDENTITY.md",
        data: "# IDENTITY.md - Agent Identity\n\n- Name: New Name\n- Theme: steady\n- Emoji: 🤖\n- Avatar: https://example.com/new.png\n",
      });
    });

    it.each([true, false])(
      "preserves the correct identity when moving workspace (new=%s)",
      async (created) => {
        const identity = (name: string, creature: string, role: string) =>
          `- Name: ${name}\n- **Creature:** ${creature}\n\n## Role\n${role}\n`;
        mocks.ensureAgentWorkspace.mockResolvedValueOnce({
          dir: "/resolved/new/workspace",
          identityPathCreated: created,
        });
        readIdentities({
          "/workspace/test-agent/IDENTITY.md": identity("Source", "Turtle", "Source role"),
          "/resolved/new/workspace/IDENTITY.md": identity("Destination", "Fox", "Destination role"),
        });
        const respond = await update({ workspace: "/new/workspace" });
        expectRespondOk(respond, { ok: true, agentId: "test-agent" });
        const write = expectRecordFields(mockCallArg(mocks.rootWrite), {
          rootDir: "/resolved/new/workspace",
          relativePath: "IDENTITY.md",
        });
        for (const content of [
          created ? "- **Creature:** Turtle" : "- **Creature:** Fox",
          created ? "Source role" : "Destination role",
        ]) {
          expect(write.data).toEqual(expect.stringContaining(content));
        }
        expect(write.data).toContain("## Role");
        expect(write.data).not.toContain(created ? "Destination role" : "Source role");
      },
    );

    it.each([
      ["write", "path-mismatch", "unsafe workspace file"],
      ["read", "invalid-path", 'unsafe workspace file "IDENTITY.md"'],
    ] as const)(
      "rejects unsafe identity %s without persisting config",
      async (operation, code, message) => {
        const error = new FsSafeError(code, "unsafe identity path");
        if (operation === "read") {
          mocks.rootRead.mockRejectedValue(error);
        } else {
          mocks.rootWrite.mockRejectedValueOnce(error);
        }
        const respond = await update({
          name: "Bad Update",
          avatar: "https://example.com/unsafe.png",
        });
        expectRespondErrorContaining(respond, message);
        expectUncalled(mocks.writeConfigFile);
        if (operation === "read") {
          expectUncalled(mocks.rootWrite);
        }
      },
    );
  });
}
