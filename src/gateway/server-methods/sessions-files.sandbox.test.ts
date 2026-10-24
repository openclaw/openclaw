import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { resolveSandboxConfigForAgent } from "../../agents/sandbox/config.js";
import { hashTextSha256 } from "../../agents/sandbox/hash.js";
import { resolveSandboxRuntimeStatus } from "../../agents/sandbox/runtime-status.js";
import { resolveSandboxWorkspaceLayoutPaths } from "../../agents/sandbox/shared.js";
import { resolveSubagentSessionAttachmentRootDir } from "../../agents/subagents/subagent-attachment-paths.js";
import { requireGit } from "../../agents/worktrees/git.js";
import { ManagedWorktreeService } from "../../agents/worktrees/service.js";
import { initializeManagedWorktreeTestRepository } from "../../agents/worktrees/service.test-support.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import * as checkoutDiff from "../../sessions/session-diff.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { handleGatewayRequest } from "../server-methods.js";
import { roleClient, rolePolicyConfig } from "../session-sharing.test-utils.js";
import { sessionsDiffHandlers } from "./sessions-diff.js";
import { sessionsFilesHandlers } from "./sessions-files.js";
import {
  expectError,
  expectOkPayload,
  openSessionFileDownload,
} from "./sessions-files.test-support.js";

it("keeps real guest file requests in their session's private sandbox", async () => {
  await withOpenClawTestState(
    { scenario: "minimal", prepareProfileCatalog: true },
    async (state) => {
      const cfg: OpenClawConfig = {
        ...rolePolicyConfig(),
        agents: {
          defaults: { sandbox: { workspaceRoot: state.path("sandboxes") } },
          entries: { main: { workspace: state.workspaceDir } },
        },
      };
      for (const name of ["none", "view"] as const) {
        const role = cfg.gateway!.roles!.definitions![name]!;
        role.scopes = ["operator.sessions.write"];
        role.sandbox = "required";
      }
      cfg.gateway!.roles!.definitions!.write!.scopes = ["operator.admin"];
      setRuntimeConfigSnapshot(cfg);
      const connection = new AbortController();
      const owner = roleClient("none", "files-owner");
      owner.connect.scopes = ["operator.sessions.write"];
      owner.connId = "files-owner";
      owner.connectionSignal = connection.signal;
      const viewer = roleClient("view", "files-viewer");
      viewer.connect.scopes = ["operator.sessions.write"];
      const admin = roleClient("write", "files-admin");
      admin.connect.scopes = ["operator.admin"];
      const createdBy = (client: typeof owner) => ({
        type: "human" as const,
        source: "profile" as const,
        id: client.authenticatedUserProfile!.profileId,
      });
      const save = (sessionKey: string, value: InternalSessionEntry) =>
        upsertSessionEntryCore({ agentId: "main", sessionKey }, value);
      const write = (root: string, file: string, content: string) =>
        fs.writeFile(path.join(root, file), content);
      const key = "agent:main:dashboard:sandbox-files";
      const entry: InternalSessionEntry = {
        sessionId: "sandbox-files-session",
        updatedAt: 1,
        visibility: "shared",
        createdVia: "operator",
        createdActor: createdBy(owner),
        sandbox: "required",
        sessionRoot: state.workspaceDir,
      };
      await save(key, entry);
      const sessionLayout = (sessionKey: string) =>
        resolveSandboxWorkspaceLayoutPaths({
          cfg: resolveSandboxConfigForAgent(cfg, "main"),
          rawSessionKey: key,
          agentId: "main",
          isolationSubject: { kind: "session", sessionKey },
          workspaceDir: state.workspaceDir,
        });
      const layoutFor = (selected: InternalSessionEntry) => {
        const runtime = resolveSandboxRuntimeStatus({
          cfg,
          agentId: "main",
          sessionKey: key,
          preparedSessionEntry: selected,
        });
        const sandbox = resolveSandboxConfigForAgent(cfg, "main");
        return resolveSandboxWorkspaceLayoutPaths({
          cfg: runtime.sandboxRequired
            ? { ...sandbox, scope: "agent", workspaceAccess: runtime.workspaceAccess }
            : sandbox,
          rawSessionKey: key,
          agentId: "main",
          isolationSubject: runtime.isolationSubject,
          workspaceDir: state.workspaceDir,
        });
      };
      const layout = layoutFor(entry);
      const foreign = layoutFor({
        ...entry,
        createdActor: createdBy(viewer),
      });
      const context = createDirectChatContext({ getRuntimeConfig: () => cfg });
      const request = async (
        operation: "list" | "get" | "download" | "assets" | "diff",
        params: Record<string, unknown> = {},
        client = owner,
      ) => {
        const method = operation === "diff" ? "sessions.diff" : `sessions.files.${operation}`;
        const respond = vi.fn();
        await handleGatewayRequest({
          req: { type: "req", id: method, method, params: { sessionKey: key, ...params } },
          client,
          context,
          respond,
          isWebchatConnect: () => false,
          extraHandlers: { ...sessionsFilesHandlers, ...sessionsDiffHandlers },
        });
        return respond.mock.calls.map(([ok, payload, error]) => ({ ok, payload, error }));
      };
      const expectSuccess = (calls: Awaited<ReturnType<typeof request>>) => {
        expect(calls[0]?.error).toBeUndefined();
        return expectOkPayload(calls);
      };
      const ok = async (...args: Parameters<typeof request>) =>
        expectSuccess(await request(...args));
      const error = async (...args: Parameters<typeof request>) =>
        expectError(await request(...args));
      const expectContent = async (
        file: string,
        content: string,
        client = owner,
        sessionKey = key,
      ) => expect((await ok("get", { sessionKey, path: file }, client)).file.content).toBe(content);
      async function expectSandboxRequired(
        sessionKey: string,
        file: string,
        operations: Parameters<typeof request>[0][],
      ) {
        for (const operation of operations) {
          const denied = await error(
            operation,
            {
              sessionKey,
              ...(!["list", "diff"].includes(operation) ? { path: file } : {}),
              ...(operation === "assets" ? { refs: ["style.css"] } : {}),
            },
            viewer,
          );
          expect(denied.message).toContain("requires a sandboxed session");
        }
      }
      try {
        const hostFile = path.join(state.workspaceDir, "host-only.txt");
        await fs.writeFile(hostFile, "host private bytes");
        // No turn has prepared the private directory. This must not expose the host fallback.
        const cold = await ok("list");
        expect(cold.root).toBe(layout.workspaceDir);
        expect(cold.browser).toBeUndefined();
        await error("get", { path: "host-only.txt" });
        await fs.mkdir(layout.workspaceDir, { recursive: true });
        await fs.mkdir(foreign.workspaceDir, { recursive: true });
        await write(layout.workspaceDir, "guest.txt", "guest work");
        await write(layout.workspaceDir, "index.html", '<link rel="stylesheet" href="style.css">');
        await write(layout.workspaceDir, "style.css", "body { color: blue; }");
        const foreignFile = path.join(foreign.workspaceDir, "foreign.txt");
        await fs.writeFile(foreignFile, "other guest private bytes");
        await fs.symlink(hostFile, path.join(layout.workspaceDir, "host-link.txt"));
        await fs.link(hostFile, path.join(layout.workspaceDir, "host-hardlink.txt"));
        for (const client of [owner, viewer, admin]) {
          const listed = await ok("list", {}, client);
          expect(listed.root).toBe(layout.workspaceDir);
          expect(JSON.stringify(listed)).not.toContain("host-only.txt");
          const searched = await ok("list", { search: "guest.txt" }, client);
          expect(searched.browser.entries).toEqual([
            expect.objectContaining({ path: "guest.txt" }),
          ]);
          await expectContent("guest.txt", "guest work", client);
          for (const file of [
            hostFile,
            "host-only.txt",
            foreignFile,
            "../host-only.txt",
            "host-link.txt",
            "host-hardlink.txt",
          ]) {
            await error("get", { path: file }, client);
          }
        }
        const assets = await ok("assets", {
          path: "index.html",
          refs: ["style.css", "../host-only.txt"],
        });
        expect(assets.assets).toEqual(
          expect.arrayContaining([expect.objectContaining({ ref: "style.css" })]),
        );
        expect(JSON.stringify(assets)).not.toContain("host private bytes");
        const download = await ok("download", { path: "guest.txt" });
        const bytes = await openSessionFileDownload(owner, download.url);
        expect(bytes.status).toBe(200);
        expect(await bytes.text()).toBe("guest work");
        for (const file of [hostFile, foreignFile, "host-link.txt"]) {
          await error("download", { path: file });
        }
        await expect(request("download", { path: "host-hardlink.txt" })).rejects.toThrow(
          "hardlinked path not allowed",
        );
        await fs.unlink(path.join(layout.workspaceDir, "host-hardlink.txt"));
        const externalRepo = await initializeManagedWorktreeTestRepository(
          state.path("external-diff-source"),
        );
        await write(externalRepo, "outside-private.txt", "SYNTHETIC_HOST_DIFF_BYTES\n");
        await requireGit(externalRepo, ["add", "outside-private.txt"]);
        await requireGit(externalRepo, ["commit", "-m", "synthetic external content"]);
        const gitPointer = path.join(layout.workspaceDir, ".git");
        await fs.writeFile(gitPointer, `gitdir: ${path.join(externalRepo, ".git")}\n`);
        const hostDiff = vi.spyOn(checkoutDiff, "loadCheckoutDiff");
        try {
          const diff = await ok("diff", { scope: "uncommitted" });
          expect(diff).toMatchObject({ unavailableReason: "not_git", files: [] });
          expect(JSON.stringify(diff)).not.toContain("SYNTHETIC_HOST_DIFF_BYTES");
          expect(hostDiff).not.toHaveBeenCalled();
        } finally {
          hostDiff.mockRestore();
          await fs.unlink(gitPointer);
        }
        // A reconnect retains the session creator's workspace, not the new connection's identity.
        const reconnect = { ...owner, connId: "files-owner-reconnected" };
        await expectContent("guest.txt", "guest work", reconnect);
        const pending = await ok("download", { path: "guest.txt" });
        cfg.agents!.defaults!.sandbox!.workspaceRoot = state.path("replacement-sandboxes");
        expect((await openSessionFileDownload(owner, pending.url)).status).toBe(404);
        await error("get", { path: "guest.txt" });
        await error("get", { path: "host-only.txt" });
        cfg.agents!.defaults!.sandbox!.workspaceRoot = state.path("sandboxes");
        // The same namespace owner handles attachment-granted children and private library revisions.
        const attachmentRoot = resolveSubagentSessionAttachmentRootDir({
          agentId: "main",
          childSessionKey: key,
        });
        await fs.mkdir(attachmentRoot, { recursive: true });
        const childLayout = sessionLayout(key);
        await fs.mkdir(childLayout.workspaceDir, { recursive: true });
        await write(childLayout.workspaceDir, "child.txt", "child work");
        await expectContent("child.txt", "child work");
        await error("get", { path: "guest.txt" });
        const librarySelections = [
          {
            skillId: "11111111-1111-4111-8111-111111111111",
            revision: "a".repeat(64),
            name: "notes",
            ownerProfileId: owner.authenticatedUserProfile!.profileId,
          },
        ];
        const libraryEntry = {
          ...entry,
          skillsSnapshot: { prompt: "", skills: [], librarySelections },
        };
        await save(key, libraryEntry);
        const libraryLayout = sessionLayout(
          `${key}:skills:${hashTextSha256(JSON.stringify(librarySelections))}`,
        );
        await fs.mkdir(libraryLayout.workspaceDir, { recursive: true });
        await write(libraryLayout.workspaceDir, "library.txt", "library session work");
        await expectContent("library.txt", "library session work");
        await error("get", { path: "child.txt" });
        const libraryDownload = await ok("download", { path: "library.txt" });
        await save(key, { ...libraryEntry, updatedAt: 2, displayName: "Renamed library session" });
        const sameLibrary = await openSessionFileDownload(owner, libraryDownload.url);
        expect(sameLibrary.status).toBe(200);
        expect(await sameLibrary.text()).toBe("library session work");
        await save(key, {
          ...libraryEntry,
          updatedAt: 3,
          skillsSnapshot: {
            ...libraryEntry.skillsSnapshot,
            librarySelections: [{ ...librarySelections[0]!, revision: "b".repeat(64) }],
          },
        });
        // The row identity and sharing remain valid; its namespace selection changed.
        expect((await openSessionFileDownload(owner, libraryDownload.url)).status).toBe(404);
        await error("get", { path: "library.txt" });
        // Explicit read-only source access remains admitted, including the required-sandbox rw cap.
        for (const workspaceAccess of ["ro", "rw"] as const) {
          cfg.agents!.defaults!.sandbox!.workspaceAccess = workspaceAccess;
          await expectContent("host-only.txt", "host private bytes");
        }
        cfg.agents!.defaults!.sandbox!.workspaceAccess = "none";
        const adminKey = "agent:main:dashboard:admin-files";
        await save(adminKey, {
          sessionId: "admin-files-session",
          updatedAt: 1,
          visibility: "shared",
          createdActor: createdBy(admin),
          sessionRoot: state.workspaceDir,
        });
        await expectContent("host-only.txt", "host private bytes", admin, adminKey);
        await expectSandboxRequired(adminKey, "host-only.txt", [
          "list",
          "get",
          "download",
          "assets",
          "diff",
        ]);
        const readOnlyRole = cfg.gateway!.roles!.definitions!.suggest!;
        readOnlyRole.scopes = ["operator.read"];
        const readOnly = roleClient("suggest", "files-read-only");
        readOnly.connect.scopes = ["operator.read"];
        readOnly.connId = "files-read-only";
        readOnly.connectionSignal = connection.signal;
        await expectContent("host-only.txt", "host private bytes", readOnly, adminKey);
        const readableDownload = await ok(
          "download",
          { sessionKey: adminKey, path: "host-only.txt" },
          readOnly,
        );
        // Use normal provisioning, not an inserted canonical file, for the managed sibling.
        const repo = await initializeManagedWorktreeTestRepository(state.path("managed-source"));
        await write(repo, ".gitignore", ".env.local\n");
        await write(repo, ".worktreeinclude", ".env.local\n");
        await requireGit(repo, ["add", ".gitignore", ".worktreeinclude"]);
        await requireGit(repo, ["commit", "-m", "configure synthetic provisioning"]);
        await write(repo, ".env.local", "SYNTHETIC_VALUE=host-only\n");
        const service = new ManagedWorktreeService({ env: state.env, getConfig: () => cfg });
        const provision = (name: string, provisionIgnoredFiles: boolean) =>
          service.create({ repoRoot: repo, name, baseRef: "HEAD", provisionIgnoredFiles });
        const managed = await provision("admin-files", true);
        const managedKey = "agent:main:dashboard:managed-admin-files";
        const managedEntry: InternalSessionEntry = {
          sessionId: "managed-admin-files",
          updatedAt: 1,
          visibility: "shared",
          createdActor: createdBy(admin),
          spawnedCwd: managed.path,
          worktree: { id: managed.id, branch: managed.branch, repoRoot: repo },
        };
        await save(managedKey, managedEntry);
        for (const client of [admin, readOnly]) {
          await expectContent(".env.local", "SYNTHETIC_VALUE=host-only\n", client, managedKey);
        }
        await expectSandboxRequired(managedKey, ".env.local", ["list", "get", "download", "diff"]);
        // Optional sandbox execution does not turn canonical host files into a private root.
        cfg.agents!.defaults!.sandbox!.mode = "all";
        for (const workspaceAccess of ["none", "ro"] as const) {
          cfg.agents!.defaults!.sandbox!.workspaceAccess = workspaceAccess;
          await expectSandboxRequired(managedKey, ".env.local", ["get"]);
          await expectContent(".env.local", "SYNTHETIC_VALUE=host-only\n", readOnly, managedKey);
        }
        cfg.agents!.defaults!.sandbox!.mode = "off";
        cfg.agents!.defaults!.sandbox!.workspaceAccess = "none";
        // Normal required-sandbox provisioning leaves host-only inputs out of its own project.
        const guestManaged = await provision("guest-files", false);
        const guestManagedKey = "agent:main:dashboard:managed-guest-files";
        const guestManagedSessionId = "managed-guest-files-session";
        await save(guestManagedKey, {
          ...managedEntry,
          sessionId: guestManagedSessionId,
          sandbox: "required",
          createdActor: entry.createdActor,
          spawnedCwd: guestManaged.path,
          worktree: { id: guestManaged.id, branch: guestManaged.branch, repoRoot: repo },
        });
        await expectContent("README.md", "base\n", viewer, guestManagedKey);
        await error("get", { sessionKey: guestManagedKey, path: ".env.local" }, viewer);
        readOnlyRole.sandbox = "required";
        expect((await openSessionFileDownload(readOnly, readableDownload.url)).status).toBe(404);
      } finally {
        connection.abort();
      }
    },
  );
});
