import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createSandbox } from "../../agents/sandbox/fs-bridge.test-helpers.js";
import { createRemoteShellSandboxFsBridge } from "../../agents/sandbox/remote-fs-bridge.js";
import { createLocalRemoteShellScriptRunner } from "../../agents/sandbox/remote-fs-bridge.test-helpers.js";
import { registerAgentWorkspaceAccess } from "../../agents/workspace-access.js";
import { callAgentHandler } from "./agents-mutate.test-support.js";
import { agentsHandlers } from "./agents.js";

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
    preconditions: {
      expectedHash?: string;
      expectedMissing?: boolean;
      expectedWorkspace?: string;
    } = {},
    name = memory,
  ) {
    return invokeFiles("agents.files.set", { agentId: "main", name, content, ...preconditions });
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

  it("preserves the first creation when two callers observed a missing document", async () => {
    expect(await invokeFiles("agents.files.get", { agentId: "main", name: memory })).toMatchObject({
      ok: true,
      payload: { workspace, file: { missing: true } },
    });
    const preconditions = { expectedMissing: true, expectedWorkspace: workspace };
    expect(await setFile(drafts[0], preconditions)).toMatchObject({ ok: true });
    expect(await setFile(drafts[1], preconditions)).toMatchObject({
      ok: false,
      error: { details: { type: "agent_file_conflict", name: memory } },
    });
    expect(readFile()).toBe(drafts[0]);
  });

  it("rejects an old workspace binding even when the replacement matches the draft", async () => {
    writeFile(original);
    const originalStorage = storageDir;
    const expectedWorkspace = workspace;
    workspace = fs.realpathSync(tempDirs.make("openclaw-replacement-workspace-"));
    storageDir = workspace;
    writeFile(edited);
    expect(
      await setFile(edited, { expectedWorkspace, expectedHash: hashContent(original) }),
    ).toMatchObject({
      ok: false,
      error: {
        message: expect.stringContaining("workspace changed"),
        details: { type: "agent_file_conflict", name: memory },
      },
    });
    expect(readFile()).toBe(edited);
    expect(
      await setFile(drafts[0], {
        expectedWorkspace: workspace,
        expectedHash: hashContent(edited),
      }),
    ).toMatchObject({ ok: true });
    expect(readFile()).toBe(drafts[0]);
    expect(fs.readFileSync(path.join(originalStorage, memory), "utf8")).toBe(original);
  });

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
    expect(await setFile("unsaved new memory", { expectedMissing: true })).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("Update its workspace provider") },
    });
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
