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

      it.each(["conflicting-preconditions", "expected-present", "stale", "gone"] as const)(
        "refuses a save with %s preconditions without overwriting the document",
        async (variant) => {
          const name = "MEMORY.md";
          let expectedHash = hashContent("# Memory\n");
          if (variant === "stale") {
            fs.writeFileSync(path.join(storageDir, name), "# Memory\n");
            const opened = await invokeAgentFilesHandler("agents.files.get", {
              agentId: "main",
              name,
            });
            expect(opened.ok).toBe(true);
            const openedHash = (opened.payload as { file: { hash: string } }).file.hash;
            expect(openedHash).toBe(expectedHash);
            expectedHash = openedHash;
            fs.appendFileSync(path.join(storageDir, name), "- agent learned a birthday\n");
          }
          const preconditions =
            variant === "conflicting-preconditions"
              ? { expectedMissing: true, expectedHash: hashContent("old") }
              : variant === "expected-present"
                ? { expectedMissing: false }
                : { expectedHash };
          const call = await invokeAgentFilesHandler("agents.files.set", {
            agentId: "main",
            name,
            content: "# Memory\n- operator note\n",
            ...preconditions,
          });
          expect(call).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
          if (variant === "stale" || variant === "gone") {
            expect(call.error?.details).toEqual({
              type: "agent_file_conflict",
              name,
              ...(variant === "stale"
                ? { currentHash: hashContent("# Memory\n- agent learned a birthday\n") }
                : {}),
            });
          }
          if (variant === "stale") {
            expect(readMemory()).toBe("# Memory\n- agent learned a birthday\n");
          } else {
            expect(fs.existsSync(path.join(storageDir, name))).toBe(false);
          }
        },
      );

      it.each(["uppercase", "omitted"] as const)(
        "writes with an %s expectedHash and returns the new hash",
        async (hashCase) => {
          fs.writeFileSync(path.join(storageDir, "MEMORY.md"), "# Memory\n");
          const expectedHash = hashContent("# Memory\n");

          const call = await invokeAgentFilesHandler("agents.files.set", {
            agentId: "main",
            name: "MEMORY.md",
            content: "# Memory\n- operator note\n",
            ...(hashCase === "uppercase" ? { expectedHash: expectedHash.toUpperCase() } : {}),
          });

          expect(call.ok).toBe(true);
          expect((call.payload as { file: { hash?: string } }).file.hash).toBe(
            hashContent("# Memory\n- operator note\n"),
          );
          expect(readMemory()).toBe("# Memory\n- operator note\n");
        },
      );

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
