import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { text as readBody } from "node:stream/consumers";
import { expect, it } from "vitest";
import {
  closeHttpServer,
  listenLoopback,
} from "../../../test/helpers/gateway-integration-fixtures.js";
import { makeUserMessage } from "../../../test/helpers/user-message.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/config.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { hasErrnoCode } from "../../infra/errno.js";
import { clearMemoryPluginState } from "../../plugins/memory-state.js";
import { beginSessionEffect } from "../../sessions/session-controller.lifecycle.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { runMemoryFlushIfNeeded } from "./agent-runner-memory.js";
import {
  createTestFollowupRun,
  installAgentRunnerMemoryFixture,
} from "./agent-runner.test-fixtures.js";

// Real preparation, detached session, inference adapter, tool assembly and writer.
// Only the provider's HTTP response and memory plugin plan are synthetic. This is
// not Control UI/session-root admission or live-model end-to-end coverage.
type ModelRequest = {
  messages: Array<{ role: string; content: unknown; tool_call_id?: string }>;
  tools?: Array<{ function?: { name?: string } }>;
};

async function readNote(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, "utf8");
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
}

it.each([
  { agentId: "main", execution: "agent workspace" },
  { agentId: "main", execution: "selected project" },
  { agentId: "research", execution: "selected project" },
])(
  "keeps $agentId flush files in agent memory from $execution",
  async ({ agentId, execution }) => {
    await withOpenClawTestState({ label: "memory-workspace" }, async (state) => {
      const agentWorkspace = state.path("agent-workspaces", agentId);
      const executionRoot =
        execution === "agent workspace" ? agentWorkspace : state.path("selected-project");
      const relativePath = "memory/2026-11-18.md";
      const note = "Synthetic durable note: the Cedar fixture prefers concise reports.\n";
      const legacyNote = "Existing project-owned note; do not migrate or remove.\n";
      await fs.mkdir(agentWorkspace, { recursive: true });
      await fs.mkdir(path.join(executionRoot, "memory"), { recursive: true });
      await fs.writeFile(path.join(executionRoot, "memory/existing.md"), legacyNote);
      const requests: ModelRequest[] = [];
      const requestErrors: unknown[] = [];
      let beforeInference: { agent: string | undefined; execution: string | undefined } | undefined;
      const server = createServer((request, response) => {
        void readBody(request)
          .then(async (body) => {
            const received = JSON.parse(body) as ModelRequest;
            requests.push(received);
            const first = requests.length === 1;
            if (first) {
              // Observe the real pre-creation before returning any model/tool action.
              beforeInference = {
                agent: await readNote(path.join(agentWorkspace, relativePath)),
                execution: await readNote(path.join(executionRoot, relativePath)),
              };
            }
            response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
            const delta = first
              ? {
                  role: "assistant",
                  tool_calls: [
                    {
                      index: 0,
                      id: "synthetic-memory-write",
                      type: "function",
                      function: {
                        name: "write",
                        arguments: JSON.stringify({ path: relativePath, content: note }),
                      },
                    },
                  ],
                }
              : { role: "assistant", content: "NO_REPLY" };
            for (const choice of [
              { index: 0, delta, finish_reason: null },
              { index: 0, delta: {}, finish_reason: first ? "tool_calls" : "stop" },
            ]) {
              response.write(
                "data: " +
                  JSON.stringify({
                    id: "synthetic-memory-completion",
                    object: "chat.completion.chunk",
                    created: 1,
                    model: "workspace-model",
                    choices: [choice],
                  }) +
                  "\n\n",
              );
            }
            response.end("data: [DONE]\n\n");
          })
          .catch((error: unknown) => {
            requestErrors.push(error);
            response.destroy();
          });
      });
      const baseUrl = await listenLoopback(server);
      const scope = {
        agentId,
        sessionId: "synthetic-memory-source",
        sessionKey: "agent:" + agentId + ":dashboard:memory-workspace",
        storePath: path.join(state.sessionsDir(agentId), "sessions.json"),
      };
      const cfg: OpenClawConfig = {
        agents: {
          ownership: "explicit",
          entries: {
            main: { workspace: state.path("agent-workspaces", "main") },
            research: { workspace: state.path("agent-workspaces", "research") },
          },
          defaults: { model: { primary: "test-provider/workspace-model" } },
        },
        session: { store: scope.storePath },
        tools: { profile: "coding", allow: ["read", "write"] },
        models: {
          providers: {
            "test-provider": {
              api: "openai-completions",
              apiKey: "synthetic-fixture-key",
              baseUrl: baseUrl + "/v1",
              models: [
                {
                  id: "workspace-model",
                  name: "Synthetic workspace model",
                  reasoning: false,
                  input: ["text"],
                  contextWindow: 128_000,
                  contextTokens: 128_000,
                  maxTokens: 8_192,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                },
              ],
            },
          },
        },
      };
      let admission: Awaited<ReturnType<typeof beginSessionEffect>> | undefined;
      try {
        await state.writeConfig(cfg);
        setRuntimeConfigSnapshot(cfg);
        await replaceSessionEntry(scope, {
          sessionId: scope.sessionId,
          updatedAt: 1,
          sessionRoot: executionRoot,
        });
        const transcript = await SessionManager.openAsync(scope, executionRoot);
        await transcript.appendMessageAsync(
          makeUserMessage("Remember the synthetic Cedar preference.", 1),
        );
        const entry = loadSessionEntry(scope);
        if (!entry) {
          throw new Error("Missing synthetic source session");
        }
        const followup = createTestFollowupRun({
          ...scope,
          sessionFile: scope.sessionKey,
          agentDir: state.agentDir(agentId),
          workspaceDir: executionRoot,
          cwd: executionRoot,
          sessionRoot: executionRoot,
          config: cfg,
          provider: "test-provider",
          model: "workspace-model",
          messageProvider: "webchat",
          thinkLevel: "off",
          timeoutMs: 30_000,
          senderIsOwner: true,
        });
        installAgentRunnerMemoryFixture(() => ({
          softThresholdTokens: 0,
          reserveTokensFloor: 8_192,
          forceFlushTranscriptBytes: 1,
          prompt: "Checkpoint the synthetic durable note, then reply NO_REPLY.",
          systemPrompt: "Append only new synthetic notes to memory/2026-11-18.md.",
          relativePath,
        }));
        admission = await beginSessionEffect({
          scope: scope.storePath,
          identities: [scope.sessionKey, scope.sessionId],
          assertAllowed: () => {
            expect(loadSessionEntry(scope)?.sessionId).toBe(scope.sessionId);
          },
        });
        const result = await admission.run(() =>
          runMemoryFlushIfNeeded({
            cfg,
            followupRun: followup,
            defaultModel: "workspace-model",
            resolvedVerboseLevel: "off",
            sessionEntry: entry,
            sessionStore: { [scope.sessionKey]: entry },
            sessionKey: scope.sessionKey,
            storePath: scope.storePath,
          }),
        );
        expect(requestErrors).toEqual([]);
        expect(result.outcome).toBe("completed");
        expect(requests).toHaveLength(2);
        expect(requests[0]?.tools?.some((tool) => tool.function?.name === "write")).toBe(true);
        expect(
          JSON.stringify(requests[1]?.messages.filter((message) => message.role === "tool")),
        ).toContain("Appended content");
        expect
          .soft(beforeInference, "target pre-creation must use the configured agent workspace")
          .toEqual({
            agent: "",
            execution: execution === "agent workspace" ? "" : undefined,
          });
        expect
          .soft(
            await readNote(path.join(agentWorkspace, relativePath)),
            "actual memory writer root",
          )
          .toBe(note);
        if (execution !== "agent workspace") {
          expect
            .soft(
              await readNote(path.join(executionRoot, relativePath)),
              "no project-local flush file",
            )
            .toBeUndefined();
        }
        expect(await fs.readFile(path.join(executionRoot, "memory/existing.md"), "utf8")).toBe(
          legacyNote,
        );
        expect(followup.run.workspaceDir).toBe(executionRoot);
        expect(followup.run.cwd).toBe(executionRoot);
      } finally {
        admission?.release();
        clearMemoryPluginState();
        clearRuntimeConfigSnapshot();
        await closeHttpServer(server);
      }
    });
  },
  60_000,
);
