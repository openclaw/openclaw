import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { GatewayRequestError } from "../../../ui/src/api/gateway.ts";
import { createAgentFilePanel, retainAgentFileDrafts } from "../../../ui/src/pages/agents/files.ts";
import { createTestGatewayClient } from "../../../ui/src/test-helpers/gateway-client.ts";
import { createSandbox } from "../../agents/sandbox/fs-bridge.test-helpers.js";
import { createRemoteShellSandboxFsBridge } from "../../agents/sandbox/remote-fs-bridge.js";
import { createLocalRemoteShellScriptRunner } from "../../agents/sandbox/remote-fs-bridge.test-helpers.js";
import { registerAgentWorkspaceAccess } from "../../agents/workspace-access.js";
import { callAgentHandler } from "./agents-mutate.test-support.js";
import { agentsHandlers } from "./agents.js";

type EditorState = Parameters<typeof createAgentFilePanel>[0];

function editorActions(editor: EditorState) {
  return createAgentFilePanel(editor, {
    canWrite: () => true,
    isCurrent: () => true,
  }).forAgent("main");
}

function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

// The real remote scripts require GNU tools, as they do on the execution host.
const hasGnuShell =
  process.platform !== "win32" &&
  spawnSync("stat", ["--version"], { encoding: "utf8" }).stdout?.includes("GNU coreutils");

function registerFileTests(storage: "local" | "remote") {
  const memory = "MEMORY.md";
  const original = "# Memory\n";
  const edited = "# Memory\n- operator note\n";
  const learned = "# Memory\n- agent learned a birthday\n";
  const drafts = ["# Memory\n- first operator\n", "# Memory\n- second operator\n"] as const;
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  let workspace: string;
  let storageDir: string;
  let release: (() => void) | undefined;
  let remoteBridge: ReturnType<typeof createRemoteShellSandboxFsBridge> | undefined;
  const broadcast = vi.fn();

  afterEach(() => {
    release?.();
    release = undefined;
  });

  beforeEach(() => {
    broadcast.mockReset();
    workspace = fs.realpathSync(tempDirs.make("openclaw-agent-files-"));
    storageDir = workspace;
    if (storage === "remote") {
      storageDir = fs.realpathSync(tempDirs.make("openclaw-remote-agent-files-"));
      remoteBridge = createRemoteShellSandboxFsBridge({
        sandbox: createSandbox({ workspaceDir: workspace, agentWorkspaceDir: workspace }),
        runtime: {
          remoteWorkspaceDir: storageDir,
          remoteAgentWorkspaceDir: storageDir,
          runRemoteShellScript: createLocalRemoteShellScriptRunner(),
        },
      });
      release = registerAgentWorkspaceAccess(workspace, { bridge: remoteBridge });
    }
  });

  async function invokeFiles(
    method: "agents.files.list" | "agents.files.get" | "agents.files.set",
    params: Record<string, unknown>,
  ) {
    const respond = await callAgentHandler(agentsHandlers[method]!, method, params, {
      context: {
        getRuntimeConfig: () => ({ agents: { defaults: { workspace } } }),
        broadcast,
      } as never,
    });
    expect(respond).toHaveBeenCalledTimes(1);
    const [ok, payload, error] = expectDefined(respond.mock.calls[0], "handler response");
    return { ok, payload, error };
  }

  function setFile(
    content: string,
    preconditions: { expectedHash?: string; expectedMissing?: boolean } = {},
    name = memory,
  ) {
    return invokeFiles("agents.files.set", { agentId: "main", name, content, ...preconditions });
  }
  function saveDraft(editor: EditorState) {
    expectDefined(editor.agentFileEditors[memory]?.draft, "editor draft");
    return editorActions(editor).onFileSave(memory);
  }
  function readFile(name = memory): string {
    return fs.readFileSync(path.join(storageDir, name), "utf8");
  }
  function writeFile(content: string, name = memory) {
    fs.writeFileSync(path.join(storageDir, name), content);
  }

  it.each(["x", "é"])("bounds UTF-8 bytes (%s)", async (character) => {
    const name = "AGENTS.md";
    const accepted = character.repeat((2 * 1024 * 1024) / Buffer.byteLength(character));
    expect(await setFile(accepted, {}, name)).toMatchObject({ ok: true });
    expect(readFile(name)).toBe(accepted);

    await expect(setFile(`${accepted}x`, {}, name)).rejects.toThrow(
      "Workspace document exceeds its write bound",
    );
    expect(readFile(name)).toBe(accepted);
  });

  it.each([
    ["IDENTITY.md", false],
    ["AGENTS.md", false],
    ["IDENTITY.md", true],
  ] as const)("identity publication (%s, conflict=%s)", async (name, conflict) => {
    const originalIdentity = "- Name: Before\n";
    const replacement = "- Name: After\n";
    writeFile(originalIdentity, name);
    broadcast.mockImplementation(() => readFile(name));
    const preconditions = { expectedHash: hashContent(conflict ? "stale" : originalIdentity) };
    const result = await setFile(replacement, preconditions, name);

    expect(result.ok).toBe(!conflict);
    expect(readFile(name)).toBe(conflict ? originalIdentity : replacement);
    if (name === "IDENTITY.md" && !conflict) {
      expect(broadcast).toHaveBeenCalledExactlyOnceWith("agent.identity.changed", {
        agentId: "main",
      });
      expect(broadcast.mock.results[0]?.value).toBe(replacement);
    } else {
      expect(broadcast).not.toHaveBeenCalled();
    }
  });

  async function loadEditor(draft: string) {
    const editor: EditorState = {
      agentsSelectedId: "main",
      agentFileActive: memory,
      agentFilesList: null,
      agentsPanel: "files",
      client: createTestGatewayClient(async (method, params) => {
        if ((method !== "agents.files.get" && method !== "agents.files.set") || !isRecord(params)) {
          throw new Error(`Unexpected editor request: ${method}`);
        }
        const call = await invokeFiles(method, params);
        if (call.error) {
          throw new GatewayRequestError(call.error);
        }
        expect(call.ok).toBe(true);
        return call.payload;
      }),
      connected: true,
      requestGeneration: 0,
      agents: {
        recordFile: () => null,
        files: () => ({ list: null, loading: false, read: null }),
        ensureFiles: async () => null,
        refreshFiles: async () => null,
      },
      agentFilesLoading: false,
      agentFileRead: null,
      agentFileOutcome: null,
      agentFileEditors: {},
      agentFileConflict: null,
      agentFileSaving: false,
      agentFileWriteRevisions: new Map(),
    };
    const actions = editorActions(editor);
    expect(await actions.onSelectFile(memory)).toBe(true);
    actions.onFileDraftChange(memory, draft);
    return editor;
  }

  it("preserves the first creation when two editors loaded a missing document", async () => {
    const first = await loadEditor(drafts[0]);
    const second = await loadEditor(drafts[1]);
    expect(fs.existsSync(path.join(storageDir, memory))).toBe(false);
    expect(await saveDraft(first)).toBe(true);
    expect(readFile()).toBe(first.agentFileEditors[memory]?.draft);
    expect(await saveDraft(second)).toBe(false);
    expect(second.agentFileConflict).toBe(memory);
    expect(second.agentFileEditors[memory]?.draft).toBe(drafts[1]);
    expect(readFile()).toBe(drafts[0]);
  });

  it.each(["existing", "missing", "matching draft"])(
    "keeps a retained draft bound to its original workspace (%s)",
    async (variant) => {
      if (variant !== "missing") {
        writeFile(original);
      }
      const originalStorage = storageDir;
      const editor = await loadEditor(edited);
      const retained = expectDefined(
        retainAgentFileDrafts({ ...editor, agentFileActive: memory }),
        "retained draft",
      );
      workspace = fs.realpathSync(tempDirs.make("openclaw-replacement-workspace-"));
      storageDir = workspace;
      const replacement = variant === "matching draft" ? edited : original;
      if (variant !== "missing") {
        writeFile(replacement);
      }
      editor.agentFileEditors = retained.editors;
      expect(await editorActions(editor).onSelectFile(memory)).toBe(true);

      expect(await saveDraft(editor)).toBe(false);
      expect(editor.agentFileConflict).toBe(memory);
      expect((await editor.agentFileOutcome)?.error).toContain("workspace changed");
      expect(editor.agentFileEditors[memory]?.draft).toBe(edited);
      expect(retainAgentFileDrafts({ ...editor, agentFileActive: memory })).not.toBeNull();
      expect(
        variant === "missing" ? fs.existsSync(path.join(storageDir, memory)) : readFile(),
      ).toBe(variant === "missing" ? false : replacement);

      if (variant === "missing") {
        expect(await editorActions(editor).onFileReload(memory)).toBe(true);
        expect(editor.agentFileEditors[memory]?.draft).toBe("");
        expect(fs.existsSync(path.join(storageDir, memory))).toBe(false);
      } else {
        expect(await editorActions(editor).onFileOverwrite(memory)).toBe(true);
        expect(readFile()).toBe(edited);
      }
      expect(editor.agentFileConflict).toBeNull();
      expect((await editor.agentFileOutcome)?.error).toBeUndefined();
      expect(
        variant === "missing"
          ? fs.existsSync(path.join(originalStorage, memory))
          : fs.readFileSync(path.join(originalStorage, memory), "utf8"),
      ).toBe(variant === "missing" ? false : original);
    },
  );

  it.runIf(storage === "remote")("rejects unsupported create, permits blind writes", async () => {
    const bridge = expectDefined(remoteBridge, "remote workspace fixture");
    release?.();
    release = registerAgentWorkspaceAccess(workspace, {
      bridge: {
        readFile: bridge.readFile.bind(bridge),
        writeFile: bridge.writeFile.bind(bridge),
        stat: bridge.stat.bind(bridge),
      },
    });
    const editor = await loadEditor("unsaved new memory");
    expect(await saveDraft(editor)).toBe(false);
    expect((await editor.agentFileOutcome)?.error).toContain("Update its workspace provider");
    expect(editor.agentFileEditors[memory]?.draft).toBe("unsaved new memory");
    expect(fs.existsSync(path.join(storageDir, memory))).toBe(false);

    expect(await setFile("explicit blind write")).toMatchObject({ ok: true });
    expect(readFile()).toBe("explicit blind write");
  });

  it("lists a directory named AGENTS.md as a missing document", async () => {
    fs.mkdirSync(path.join(storageDir, "AGENTS.md"));
    const call = await invokeFiles("agents.files.list", { agentId: "main" });
    expect(call.ok).toBe(true);
    const file = (call.payload as { files: Array<{ name: string; missing: boolean }> }).files.find(
      (entry) => entry.name === "AGENTS.md",
    );
    expect(file).toMatchObject({ name: "AGENTS.md", missing: true });
    expect(file).not.toHaveProperty("size", expect.any(Number));
  });

  it.each(["conflicting", "expected-present", "stale", "gone", "uppercase", "omitted"] as const)(
    "honors %s write preconditions",
    async (variant) => {
      let expectedHash = hashContent(original);
      const success = variant === "uppercase" || variant === "omitted";
      if (success || variant === "stale") {
        writeFile(original);
      }
      if (variant === "stale") {
        const opened = await invokeFiles("agents.files.get", { agentId: "main", name: memory });
        expect(opened).toMatchObject({ ok: true, payload: { file: { hash: expectedHash } } });
        expectedHash = (opened.payload as { file: { hash: string } }).file.hash;
        fs.appendFileSync(path.join(storageDir, memory), "- agent learned a birthday\n");
      }
      const preconditions = {
        conflicting: { expectedMissing: true, expectedHash: hashContent("old") },
        "expected-present": { expectedMissing: false },
        stale: { expectedHash },
        gone: { expectedHash },
        uppercase: { expectedHash: expectedHash.toUpperCase() },
        omitted: {},
      }[variant];
      const call = await setFile(edited, preconditions);
      if (success) {
        expect(call).toMatchObject({ ok: true, payload: { file: { hash: hashContent(edited) } } });
        expect(readFile()).toBe(edited);
        return;
      }
      expect(call).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
      if (variant === "stale" || variant === "gone") {
        expect(call.error?.details).toEqual({
          type: "agent_file_conflict",
          name: memory,
          ...(variant === "stale" ? { currentHash: hashContent(learned) } : {}),
        });
      }
      if (variant === "stale") {
        expect(readFile()).toBe(learned);
      } else {
        expect(fs.existsSync(path.join(storageDir, memory))).toBe(false);
      }
    },
  );

  it("admits only one of two concurrent saves that share an expectedHash", async () => {
    writeFile(original);
    const expectedHash = hashContent(original);
    const calls = await Promise.all(drafts.map((content) => setFile(content, { expectedHash })));

    expect(calls.filter((call) => call.ok)).toHaveLength(1);
    expect(drafts).toContain(readFile());
    expect(calls.find((call) => !call.ok)?.error?.details).toMatchObject({
      type: "agent_file_conflict",
      currentHash: hashContent(readFile()),
    });
  });
}

for (const storage of ["local", "remote"] as const) {
  describe.runIf(storage === "local" || hasGnuShell)(
    `agents.files.get/set content hashes (${storage})`,
    () => registerFileTests(storage),
  );
}
