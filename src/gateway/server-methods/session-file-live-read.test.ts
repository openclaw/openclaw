import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { __setFsSafeTestHooksForTest } from "@openclaw/fs-safe/test-hooks";
import { afterEach, expect, it, vi } from "vitest";
import * as engine from "../../agents/sandbox/container-engine.js";
import { mockStoppedWorkspaceContainer } from "../../agents/sandbox/mount-plan.test-helpers.js";
import { ManagedWorktreeService } from "../../agents/worktrees/service.js";
import { initializeManagedWorktreeTestRepository } from "../../agents/worktrees/service.test-support.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { resolveAssistantMediaPolicy } from "../assistant-media-policy.js";
import { openAssistantMedia } from "../control-ui-assistant-media-read.js";
import { withLocalWorkspaceProjection } from "../worker-environments/local-workspace-projection.js";
import { prepareSessionFileReadPath } from "./session-file-read.js";
import { sessionsFilesHandlers } from "./sessions-files.js";
import { createSessionFilesHandlerInvoker } from "./sessions-files.test-support.js";
import { getSessionWorkspaceFile } from "./workspace-files.js";

afterEach(() => {
  __setFsSafeTestHooksForTest(undefined);
  vi.restoreAllMocks();
});

async function withLiveWorkspace(
  run: (fixture: Awaited<ReturnType<typeof prepareFixture>>) => Promise<void>,
  sandboxed = true,
) {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const fixture = await prepareFixture(state.workspaceDir, sandboxed);
    try {
      await run(fixture);
    } finally {
      fixture.policy.release();
    }
  });
}

async function prepareFixture(root: string, sandboxed: boolean) {
  const repo = await initializeManagedWorktreeTestRepository(root);
  const sessionKey = "agent:main:live-file-reader";
  const cfg: OpenClawConfig = {
    agents: { defaults: { sandbox: { mode: sandboxed ? "all" : "off", backend: "docker" } } },
  };
  setRuntimeConfigSnapshot(cfg);
  const service = new ManagedWorktreeService();
  const worktree = await service.create({
    repoRoot: repo,
    name: "live-file-reader",
    baseRef: "HEAD",
    ownerKind: "session",
    ownerId: sessionKey,
  });
  const authority = new AbortController();
  const assertCurrent = () => authority.signal.throwIfAborted();
  const owner = {
    agentId: "main",
    sessionKey,
    sessionId: "live-file-reader",
    lifecycleRevision: null,
    worktree,
    assertCurrent,
  };
  await upsertSessionEntryCore(
    { agentId: owner.agentId, sessionKey },
    {
      sessionId: owner.sessionId,
      updatedAt: 1,
      sandbox: sandboxed ? "required" : undefined,
      spawnedCwd: worktree.path,
      sessionRoot: worktree.path,
      worktree: { id: worktree.id, branch: worktree.branch, repoRoot: repo },
    },
  );
  const projection = await withLocalWorkspaceProjection(owner, (state) => state.prepare());
  await mockStoppedWorkspaceContainer(projection);
  let paused = false;
  const commands = vi.mocked(engine.execContainer);
  commands.mockImplementation(async (_engine, args) => {
    let stdout = "";
    if (args[0] === "pause") {
      paused = true;
    } else if (args[0] === "unpause") {
      paused = false;
    } else if (args.includes("{{.State.Paused}}")) {
      stdout = String(paused);
    } else if (args.includes("{{.Id}} {{.State.Running}} {{.State.Paused}}")) {
      stdout = `${"a".repeat(64)} true ${paused}`;
    } else if (args[0] === "inspect" && args[1] === "--format") {
      stdout = JSON.stringify({
        Mounts: [{ Type: "bind", Source: projection, Destination: "/workspace", RW: true }],
        Tmpfs: {},
      });
    } else if (args[0] === "exec" && args.at(-1) === "/proc/self/mountinfo") {
      stdout = "1 1 0:1 / / rw - overlay overlay rw\n2 1 0:2 / /workspace rw - ext4 workspace rw\n";
    } else {
      throw new Error(`Unexpected container command: ${args.join(" ")}`);
    }
    return { code: 0, stdout, stderr: "" };
  });
  const policy = await resolveAssistantMediaPolicy({
    config: cfg,
    sessionKey,
    agentId: owner.agentId,
    requestAuth: { authMethod: "token", operatorScopes: ["operator.admin"] },
  });
  assert(policy);
  if (sandboxed) {
    assert(policy.sandboxWorkspace);
  }
  const prepareFile = (filePath: string) =>
    prepareSessionFileReadPath({
      root: worktree.path,
      fileRoot: worktree.path,
      filePath,
      worktreeId: worktree.id,
      sandboxWorkspace: {
        hostRoot: worktree.path,
        containerRoot: "/workspace",
        runtimeWorkspaceDir: projection,
      },
      assertCurrent,
      assertReadCurrent: assertCurrent,
    });
  const readFile = async (filePath: string) => {
    const prepared = await prepareFile(filePath);
    assert(prepared.path);
    const result = await getSessionWorkspaceFile({
      root: worktree.path,
      fileRoot: worktree.path,
      readRoot: prepared.readRoot,
      files: [],
      path: prepared.path,
      assertCurrent: prepared.assertCurrent ?? assertCurrent,
    });
    prepared.assertCurrent?.();
    return result.file;
  };
  const readMedia = async (source: string) => {
    const result = await openAssistantMedia(source, policy, undefined, assertCurrent);
    await using opened = result.opened;
    const bytes = await opened.handle.readFile();
    result.assertSourceCurrent();
    return bytes.toString();
  };
  const save = (expectedHash: string) =>
    createSessionFilesHandlerInvoker(sessionsFilesHandlers)(
      "sessions.files.set",
      { sessionKey, path: "README.md", content: "host edit\n", expectedHash },
      { getRuntimeConfig: () => cfg },
    );
  const get = () =>
    createSessionFilesHandlerInvoker(sessionsFilesHandlers)(
      "sessions.files.get",
      { sessionKey, path: "README.md" },
      { getRuntimeConfig: () => cfg },
    );
  return {
    root,
    worktree,
    projection,
    commands,
    prepareFile,
    readFile,
    readMedia,
    policy,
    authority,
    save,
    get,
  };
}

it("reads fresh sandbox files and media without pausing or publishing guest edits", async () => {
  await withLiveWorkspace(async ({ worktree, projection, commands, readFile, readMedia, save }) => {
    let hash: string | undefined;
    for (let index = 0; index < 3; index++) {
      const text = `guest version ${index}\n`;
      await fs.writeFile(path.join(projection, "README.md"), text);
      expect(await readFile("/workspace/README.md")).toMatchObject({
        content: text,
        workspacePath: "README.md",
      });
      const file = await readFile("README.md");
      expect(file).toMatchObject({ content: text });
      hash = file?.hash;
      expect(await readMedia("/workspace/README.md")).toBe(text);
    }
    expect(commands.mock.calls.filter(([, args]) => args[0] === "pause")).toHaveLength(0);
    expect(await fs.readFile(path.join(worktree.path, "README.md"), "utf8")).toBe("base\n");
    assert(hash);
    expect(await save(hash)).toMatchObject([{ ok: true }]);
    expect(await fs.readFile(path.join(worktree.path, "README.md"), "utf8")).toBe("host edit\n");
    expect(await readFile("README.md")).toMatchObject({ content: "host edit\n" });
    expect(await readMedia("/workspace/README.md")).toBe("host edit\n");
  });
});

it("reads canonical host-session files despite a retained sandbox projection", async () => {
  await withLiveWorkspace(async ({ worktree, projection, commands, get }) => {
    await fs.writeFile(path.join(projection, "README.md"), "retained guest bytes\n");
    await fs.writeFile(path.join(worktree.path, "README.md"), "current host bytes\n");
    expect(await get()).toMatchObject([
      { ok: true, payload: { file: { content: "current host bytes\n" } } },
    ]);
    expect(commands.mock.calls.filter(([, args]) => args[0] === "pause")).toHaveLength(0);
  }, false);
});

it("keeps live reads on admitted descriptors through symlink swaps and partial writes", async () => {
  await withLiveWorkspace(async ({ root, projection, readFile, readMedia }) => {
    const outside = path.join(root, "outside");
    const nested = path.join(projection, "nested");
    await fs.mkdir(outside);
    await fs.mkdir(nested);
    await fs.writeFile(path.join(outside, "note.txt"), "outside bytes");
    await fs.writeFile(path.join(nested, "note.txt"), "guest bytes");
    for (const reader of ["file", "media"]) {
      let swapped = false;
      __setFsSafeTestHooksForTest({
        beforeOpen: async (filePath) => {
          if (filePath === path.join(nested, "note.txt") && !swapped) {
            swapped = true;
            await fs.rename(nested, `${nested}-original`);
            await fs.symlink(outside, nested, "dir");
          }
        },
      });
      if (reader === "file") {
        expect(await readFile("/workspace/nested/note.txt")).toBeUndefined();
      } else {
        await expect(readMedia("/workspace/nested/note.txt")).rejects.toThrow();
      }
      expect(swapped).toBe(true);
      __setFsSafeTestHooksForTest(undefined);
      await fs.unlink(nested);
      await fs.rename(`${nested}-original`, nested);
    }
    // A live view has normal concurrent-reader semantics, not snapshot semantics.
    // Write only the first half after descriptor admission; neither read may freeze the writer.
    const file = path.join(projection, "README.md");
    await fs.writeFile(file, "aaaaaaaa");
    let wrote = false;
    __setFsSafeTestHooksForTest({
      beforeRootReadFinalFence: async (filePath) => {
        if (filePath === file && !wrote) {
          wrote = true;
          await using writer = await fs.open(file, "r+");
          await writer.write("bbbb", 0, "utf8");
        }
      },
    });
    expect(await readFile("/workspace/README.md")).toMatchObject({ content: "bbbbaaaa" });
    expect(wrote).toBe(true);
  });
});

it("revokes prepared live backing when read authority ends", async () => {
  await withLiveWorkspace(async ({ projection, prepareFile, readMedia, authority }) => {
    const prepared = await prepareFile("/workspace/README.md");
    expect(prepared.readRoot).toBe(projection);
    authority.abort(new Error("Reader revoked"));
    expect(() => prepared.assertCurrent?.()).toThrow("Reader revoked");
    await expect(readMedia("/workspace/README.md")).rejects.toThrow("Reader revoked");
  });
});
