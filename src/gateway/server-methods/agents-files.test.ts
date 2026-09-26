import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { GatewayRequestError } from "../../../ui/src/api/gateway.ts";
import {
  loadAgentFileContent,
  saveAgentFile,
  type AgentFilesState,
} from "../../../ui/src/pages/agents/files.ts";
import { createTestGatewayClient } from "../../../ui/src/test-helpers/gateway-client.ts";
import { createSandbox } from "../../agents/sandbox/fs-bridge.test-helpers.js";
import { createRemoteShellSandboxFsBridge } from "../../agents/sandbox/remote-fs-bridge.js";
import { createLocalRemoteShellScriptRunner } from "../../agents/sandbox/remote-fs-bridge.test-helpers.js";
import { registerAgentWorkspaceAccess } from "../../agents/workspace-access.js";
import { agentsHandlers } from "./agents.js";

type HandlerCall = {
  ok: boolean;
  payload?: unknown;
  error?: ConstructorParameters<typeof GatewayRequestError>[0];
};

function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

// The real remote scripts require GNU tools, as they do on the execution host.
const hasGnuShell =
  process.platform !== "win32" &&
  spawnSync("stat", ["--version"], { encoding: "utf8" }).stdout?.includes("GNU coreutils");

for (const storage of ["local", "remote"] as const) {
  describe.runIf(storage === "local" || hasGnuShell)(
    `agents.files.get/set content hashes (${storage})`,
    () => {
      const tempDirs = useAutoCleanupTempDirTracker(afterEach);
      let workspace: string;
      let storageDir: string;
      let release: (() => void) | undefined;
      let remoteBridge: ReturnType<typeof createRemoteShellSandboxFsBridge> | undefined;

      afterEach(() => {
        release?.();
        release = undefined;
      });

      beforeEach(() => {
        workspace = fs.realpathSync(tempDirs.make("openclaw-agent-files-"));
        storageDir = workspace;
        remoteBridge = undefined;
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

      async function invokeAgentFilesHandler(
        method: "agents.files.list" | "agents.files.get" | "agents.files.set",
        params: Record<string, unknown>,
      ): Promise<HandlerCall> {
        const calls: HandlerCall[] = [];
        await agentsHandlers[method]?.({
          req: { type: "req", id: method, method, params: {} },
          params,
          client: null,
          isWebchatConnect: () => false,
          respond: (ok, payload, error) => {
            calls.push({ ok, payload, error });
          },
          context: {
            getRuntimeConfig: () => ({ agents: { defaults: { workspace } } }),
          } as never,
        });
        expect(calls).toHaveLength(1);
        return calls[0] as HandlerCall;
      }

      function readMemory(): string {
        return fs.readFileSync(path.join(storageDir, "MEMORY.md"), "utf8");
      }

      function createFileEditor(): AgentFilesState {
        return {
          client: createTestGatewayClient(async (method, params) => {
            if (
              (method !== "agents.files.get" && method !== "agents.files.set") ||
              !isRecord(params)
            ) {
              throw new Error(`Unexpected editor request: ${method}`);
            }
            const call = await invokeAgentFilesHandler(method, params);
            if (call.error) {
              throw new GatewayRequestError(call.error);
            }
            expect(call.ok).toBe(true);
            return call.payload;
          }),
          connected: true,
          requestGeneration: 0,
          agents: { recordFile: () => null },
          agentFilesLoading: false,
          agentFilesError: null,
          agentFileContents: {},
          agentFileBaseVersions: {},
          agentFileVersions: {},
          agentFileConflict: null,
          agentFileDrafts: {},
          agentFileSaving: false,
          agentFileWriteRevisions: new Map(),
        };
      }

      it("preserves the first creation when two editors loaded a missing document", async () => {
        const first = createFileEditor();
        const second = createFileEditor();
        const name = "MEMORY.md";
        expect(await loadAgentFileContent(first, "main", name)).toBe(true);
        expect(await loadAgentFileContent(second, "main", name)).toBe(true);
        expect(fs.existsSync(path.join(storageDir, name))).toBe(false);
        first.agentFileDrafts[name] = "# Memory\n- first operator\n";
        second.agentFileDrafts[name] = "# Memory\n- second operator\n";

        expect(await saveAgentFile(first, "main", name, first.agentFileDrafts[name])).toBe(true);
        expect(readMemory()).toBe(first.agentFileDrafts[name]);
        expect(await saveAgentFile(second, "main", name, second.agentFileDrafts[name])).toBe(false);
        expect(second.agentFileConflict).toBe(name);
        expect(second.agentFileDrafts[name]).toBe("# Memory\n- second operator\n");
        expect(readMemory()).toBe("# Memory\n- first operator\n");
      });

      it.each([
        { expectedMissing: true, expectedHash: hashContent("old") },
        { expectedMissing: false },
      ])("rejects invalid create preconditions: %j", async (preconditions) => {
        const result = await invokeAgentFilesHandler("agents.files.set", {
          agentId: "main",
          name: "MEMORY.md",
          content: "new",
          ...preconditions,
        });
        expect(result).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
        expect(fs.existsSync(path.join(storageDir, "MEMORY.md"))).toBe(false);
      });

      it.runIf(storage === "remote")(
        "keeps the draft when a workspace provider lacks exclusive creation, while preserving blind writes",
        async () => {
          if (!remoteBridge) {
            throw new Error("Expected the remote workspace fixture");
          }
          release?.();
          release = registerAgentWorkspaceAccess(workspace, {
            bridge: {
              readFile: remoteBridge.readFile.bind(remoteBridge),
              writeFile: remoteBridge.writeFile.bind(remoteBridge),
              stat: remoteBridge.stat.bind(remoteBridge),
            },
          });
          const editor = createFileEditor();
          expect(await loadAgentFileContent(editor, "main", "MEMORY.md")).toBe(true);
          editor.agentFileDrafts["MEMORY.md"] = "unsaved new memory";
          expect(await saveAgentFile(editor, "main", "MEMORY.md", "unsaved new memory")).toBe(
            false,
          );
          expect(editor.agentFilesError).toContain("Update its workspace provider");
          expect(editor.agentFileDrafts["MEMORY.md"]).toBe("unsaved new memory");
          expect(fs.existsSync(path.join(storageDir, "MEMORY.md"))).toBe(false);

          const result = await invokeAgentFilesHandler("agents.files.set", {
            agentId: "main",
            name: "MEMORY.md",
            content: "explicit blind write",
          });
          expect(result.ok).toBe(true);
          expect(readMemory()).toBe("explicit blind write");
        },
      );

      it("lists a directory named AGENTS.md as a missing document", async () => {
        fs.mkdirSync(path.join(storageDir, "AGENTS.md"));
        const call = await invokeAgentFilesHandler("agents.files.list", { agentId: "main" });
        expect(call.ok).toBe(true);
        const file = (
          call.payload as { files: Array<{ name: string; missing: boolean }> }
        ).files.find((entry) => entry.name === "AGENTS.md");
        expect(file).toMatchObject({ name: "AGENTS.md", missing: true });
        expect(file).not.toHaveProperty("size", expect.any(Number));
      });

      it("returns the on-disk content hash from agents.files.get", async () => {
        fs.writeFileSync(path.join(storageDir, "MEMORY.md"), "# Memory\n");

        const call = await invokeAgentFilesHandler("agents.files.get", {
          agentId: "main",
          name: "MEMORY.md",
        });

        expect(call.ok).toBe(true);
        expect((call.payload as { file: { hash?: string } }).file.hash).toBe(
          hashContent("# Memory\n"),
        );
      });

      it("refuses a stale expectedHash and keeps the lines written since the read", async () => {
        fs.writeFileSync(path.join(storageDir, "MEMORY.md"), "# Memory\n");
        const opened = await invokeAgentFilesHandler("agents.files.get", {
          agentId: "main",
          name: "MEMORY.md",
        });
        const openedHash = (opened.payload as { file: { hash: string } }).file.hash;
        fs.appendFileSync(path.join(storageDir, "MEMORY.md"), "- agent learned a birthday\n");

        const call = await invokeAgentFilesHandler("agents.files.set", {
          agentId: "main",
          name: "MEMORY.md",
          content: "# Memory\n- operator note\n",
          expectedHash: openedHash,
        });

        expect(call.ok).toBe(false);
        expect((call.error as { details?: unknown }).details).toEqual({
          type: "agent_file_conflict",
          name: "MEMORY.md",
          currentHash: hashContent("# Memory\n- agent learned a birthday\n"),
        });
        expect(readMemory()).toBe("# Memory\n- agent learned a birthday\n");
      });

      it.each(["lowercase", "uppercase"])(
        "writes when the %s expectedHash matches and returns the new hash",
        async (hashCase) => {
          fs.writeFileSync(path.join(storageDir, "MEMORY.md"), "# Memory\n");
          const expectedHash = hashContent("# Memory\n");

          const call = await invokeAgentFilesHandler("agents.files.set", {
            agentId: "main",
            name: "MEMORY.md",
            content: "# Memory\n- operator note\n",
            expectedHash: hashCase === "uppercase" ? expectedHash.toUpperCase() : expectedHash,
          });

          expect(call.ok).toBe(true);
          expect((call.payload as { file: { hash?: string } }).file.hash).toBe(
            hashContent("# Memory\n- operator note\n"),
          );
          expect(readMemory()).toBe("# Memory\n- operator note\n");
        },
      );

      it("reports a conflict without currentHash when the expected file is gone", async () => {
        const call = await invokeAgentFilesHandler("agents.files.set", {
          agentId: "main",
          name: "MEMORY.md",
          content: "# Memory\n",
          expectedHash: hashContent("# Memory\n"),
        });

        expect(call.ok).toBe(false);
        expect((call.error as { details?: unknown }).details).toEqual({
          type: "agent_file_conflict",
          name: "MEMORY.md",
        });
        expect(fs.existsSync(path.join(storageDir, "MEMORY.md"))).toBe(false);
      });

      it("keeps the unconditional overwrite when expectedHash is omitted", async () => {
        fs.writeFileSync(
          path.join(storageDir, "MEMORY.md"),
          "# Memory\n- agent learned a birthday\n",
        );

        const call = await invokeAgentFilesHandler("agents.files.set", {
          agentId: "main",
          name: "MEMORY.md",
          content: "# Memory\n- operator note\n",
        });

        expect(call.ok).toBe(true);
        expect(readMemory()).toBe("# Memory\n- operator note\n");
      });

      it("admits only one of two concurrent saves that share an expectedHash", async () => {
        fs.writeFileSync(path.join(storageDir, "MEMORY.md"), "# Memory\n");
        const expectedHash = hashContent("# Memory\n");

        const [first, second] = await Promise.all([
          invokeAgentFilesHandler("agents.files.set", {
            agentId: "main",
            name: "MEMORY.md",
            content: "# Memory\n- first operator\n",
            expectedHash,
          }),
          invokeAgentFilesHandler("agents.files.set", {
            agentId: "main",
            name: "MEMORY.md",
            content: "# Memory\n- second operator\n",
            expectedHash,
          }),
        ]);

        const calls = [first, second];
        expect(calls.filter((call) => call.ok)).toHaveLength(1);
        const conflict = calls.find((call) => !call.ok)?.error as {
          details: { type: string; currentHash: string };
        };
        expect(conflict.details.type).toBe("agent_file_conflict");
        expect(["# Memory\n- first operator\n", "# Memory\n- second operator\n"]).toContain(
          readMemory(),
        );
        expect(conflict.details.currentHash).toBe(hashContent(readMemory()));
      });
    },
  );
}
