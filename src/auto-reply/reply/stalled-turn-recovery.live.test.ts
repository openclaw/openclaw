import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { prepareSystemAgentRunAdmission } from "../../agents/admitted-run-context.js";
import { runEmbeddedAgent } from "../../agents/embedded-agent-runner.js";
import {
  createLiveResponsesConfig,
  isLiveTestEnabled,
  useLiveTestRuntimeConfig,
} from "../../agents/live-test-helpers.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createTestFollowupRun } from "./agent-runner.test-fixtures.js";
import { buildStalledTurnRecoveryRun } from "./stalled-turn-recovery.js";

// A deterministic stand-in for a remote operation: it finishes on the third status
// check. Real tools and a real model run below; no mock interprets the prompt.
const operationScript = `const fs = require("node:fs");
const stateFile = "operation.json";
const action = process.argv[2];
const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
if (action === "start") {
  state.starts++;
} else if (action === "status" && process.argv[3] === "comparison-1") {
  state.checks++;
} else {
  throw new Error("Usage: node operation.cjs start | status comparison-1");
}
state.status = state.checks >= 3 ? "complete" : "pending";
fs.writeFileSync(stateFile, JSON.stringify(state));
console.log(JSON.stringify({
  handle: "comparison-1",
  status: state.status,
  ...(state.status === "complete"
    ? { smaller: 13, larger: 21 }
    : { next: "node operation.cjs status comparison-1" }),
}));
`;

const request =
  "Compare the values in a.json and b.json using node operation.cjs start. " +
  "Save the larger value returned by that operation to result.txt using write, then verify the saved result using read.";

describe.skipIf(!isLiveTestEnabled(["OPENAI_LIVE_TEST"]))(
  "stalled-turn recovery with a live model",
  () => {
    it.each([
      { name: "unfinished request", newerMessage: undefined, expected: "21" },
      {
        name: "newer correction",
        newerMessage:
          "Correction: save the smaller value instead. Use the same comparison operation.",
        expected: "13",
      },
    ])(
      "finishes and verifies $name without restarting pending work",
      async ({ name, newerMessage, expected }) => {
        await withOpenClawTestState({ prefix: "stalled-turn-recovery-live-" }, async (state) => {
          const modelId = process.env.OPENCLAW_STALLED_RECOVERY_MODEL ?? "gpt-6.1-sol";
          const config = {
            ...createLiveResponsesConfig(modelId, state.workspaceDir, 4096),
            tools: { exec: { host: "gateway" as const } },
            plugins: { enabled: false, slots: { memory: "none" } },
          };
          await state.writeConfig(config);
          await Promise.all([
            fs.writeFile(path.join(state.workspaceDir, "a.json"), '{"value":13}'),
            fs.writeFile(path.join(state.workspaceDir, "b.json"), '{"value":21}'),
            fs.writeFile(
              path.join(state.workspaceDir, "operation.json"),
              JSON.stringify({ starts: 0, checks: 0 }),
            ),
            fs.writeFile(path.join(state.workspaceDir, "operation.cjs"), operationScript),
          ]);
          // Seed the interrupted turn after its real start command has executed once.
          const pending = execFileSync(process.execPath, ["operation.cjs", "start"], {
            cwd: state.workspaceDir,
            encoding: "utf8",
          }).trim();
          const manager = SessionManager.inMemory(state.workspaceDir);
          manager.appendMessage({ role: "user", content: request, timestamp: Date.now() });
          manager.appendMessage({
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "comparison-start",
                name: "exec",
                arguments: {
                  command: "node operation.cjs start",
                  workdir: state.workspaceDir,
                },
              },
            ],
            api: "openai-responses",
            provider: "openai",
            model: modelId,
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "toolUse",
            timestamp: Date.now(),
          });
          manager.appendMessage({
            role: "toolResult",
            toolCallId: "comparison-start",
            toolName: "exec",
            content: [{ type: "text", text: pending }],
            isError: false,
            timestamp: Date.now(),
          });
          if (newerMessage) {
            manager.appendMessage({ role: "user", content: newerMessage, timestamp: Date.now() });
          }
          const base = createTestFollowupRun({
            sessionId: "stalled-recovery-live",
            sessionKey: "agent:main:stalled-recovery-live",
          });
          const recovery = buildStalledTurnRecoveryRun(base);
          using _ = useLiveTestRuntimeConfig(config);
          const runId = "stalled-recovery-live-" + name.replaceAll(" ", "-");
          const admission = await prepareSystemAgentRunAdmission(
            config,
            runId,
            "main",
            "stalled-recovery-live",
          );
          const toolCalls: Array<{ name: unknown; args: unknown }> = [];
          let wroteWhilePending = false;
          let verifiedAfterWrite = false;
          let wroteResult = false;
          const result = await runEmbeddedAgent({
            preparedRunAdmission: admission,
            agentId: "main",
            sessionId: "stalled-recovery-live",
            sessionKey: "agent:main:stalled-recovery-live",
            sessionManager: manager,
            sessionPersistence: "detached",
            agentDir: state.agentDir(),
            workspaceDir: state.workspaceDir,
            config,
            provider: "openai",
            model: modelId,
            modelSelectionLocked: true,
            agentHarnessRuntimeOverride: "openclaw",
            codeModeOverride: false,
            thinkLevel: "off",
            toolsAllow: ["exec", "read", "write"],
            requireWorkspaceOnly: true,
            execOverrides: { host: "gateway", mode: "full" },
            prompt: recovery.prompt,
            timeoutMs: 180000,
            runId,
            onAgentEvent: (event) => {
              if (event.stream !== "tool" || event.data.phase !== "start") {
                return;
              }
              toolCalls.push({ name: event.data.name, args: event.data.args });
              const args = JSON.stringify(event.data.args);
              if (event.data.name === "write" && args.includes("result.txt")) {
                wroteResult = true;
                const operation = JSON.parse(
                  readFileSync(path.join(state.workspaceDir, "operation.json"), "utf8"),
                );
                if (operation.status !== "complete") {
                  wroteWhilePending = true;
                }
              }
              if (wroteResult && event.data.name === "read" && args.includes("result.txt")) {
                verifiedAfterWrite = true;
              }
            },
          });
          const operation = JSON.parse(
            await fs.readFile(path.join(state.workspaceDir, "operation.json"), "utf8"),
          );
          const content = await fs
            .readFile(path.join(state.workspaceDir, "result.txt"), "utf8")
            .catch(() => null);
          const proof = {
            name,
            modelId,
            operation,
            content,
            wroteWhilePending,
            verifiedAfterWrite,
            reply: result.payloads,
            toolCalls,
          };
          if (process.env.OPENCLAW_STALLED_RECOVERY_PROOF_DIR) {
            const dir = process.env.OPENCLAW_STALLED_RECOVERY_PROOF_DIR;
            await fs.mkdir(dir, { recursive: true });
            await fs.writeFile(
              path.join(dir, name.replaceAll(" ", "-") + ".json"),
              JSON.stringify(proof, null, 2),
            );
          }
          expect(operation.starts).toBe(1);
          expect(operation.status).toBe("complete");
          expect(content?.trim()).toBe(expected);
          expect(wroteWhilePending).toBe(false);
          expect(verifiedAfterWrite).toBe(true);
        });
      },
      240000,
    );
  },
);
