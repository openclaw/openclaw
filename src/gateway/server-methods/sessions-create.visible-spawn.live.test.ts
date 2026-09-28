import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it } from "vitest";
import type { SessionRow } from "../../../packages/gateway-protocol/src/schema/sessions-row.js";
import { createOpenClawTestInstance } from "../../../test/helpers/openclaw-test-instance.js";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.js";
import { isLiveTestEnabled } from "../../agents/live-test-helpers.js";
import type { OpenClawConfig } from "../../config/config.js";
import { loadOrCreateDeviceIdentity } from "../../infra/device-identity.js";
import {
  extractAssistantPhaseText,
  extractFirstTextBlock,
} from "../../shared/chat-message-content.js";
import type { GatewayClient } from "../client.js";
import { connectGatewayClient } from "../test-helpers.e2e.js";

const apiKey = process.env.OPENAI_API_KEY?.trim() ?? "";
const describeLive = isLiveTestEnabled() && apiKey ? describe : describe.skip;
const execFileAsync = promisify(execFile);
const RUN_TIMEOUT_MS = 120_000;

async function readHistory(client: GatewayClient, sessionKey: string) {
  const history = await client.request<{ messages: unknown[] }>("chat.history", {
    sessionKey,
    limit: 100,
  });
  return history.messages.filter(isRecord);
}

async function waitForRun(client: GatewayClient, runId: string) {
  const result = await client.request<{ status: string }>(
    "agent.wait",
    { runId, timeoutMs: RUN_TIMEOUT_MS },
    { timeoutMs: RUN_TIMEOUT_MS + 5_000 },
  );
  expect(result.status).toBe("ok");
}

describeLive("Gateway visible worktree spawn (live)", () => {
  it("forks an active first turn into the parent's registered project", async () => {
    const modelId = process.env.OPENCLAW_LIVE_RESPONSES_MODEL || "gpt-5.6-luna";
    const modelRef = `openai/${modelId}`;
    const instance = await createOpenClawTestInstance({
      name: "gateway-visible-spawn",
      env: {
        OPENAI_API_KEY: apiKey,
        OPENAI_BASE_URL: undefined,
        OPENAI_API_BASE: undefined,
        OPENCLAW_SKIP_PROVIDERS: undefined,
        OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
      },
      startTimeoutMs: 120_000,
      stopTimeoutMs: 10_000,
    });
    let client: GatewayClient | undefined;
    await runQaGatewayFixture(
      async () => {
        const repository = instance.state.path("registered-project");
        const contextMarker = `CONTEXT_${randomUUID()}`;
        const fileMarker = `README_${randomUUID()}`;
        await fs.mkdir(repository);
        await fs.writeFile(path.join(repository, "README.md"), `${fileMarker}\n`);
        const git = (args: string[]) =>
          execFileAsync("git", ["-C", repository, ...args], { env: instance.env });
        await git(["init", "-b", "main"]);
        await git(["add", "README.md"]);
        await git([
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.invalid",
          "-c",
          "commit.gpgsign=false",
          "commit",
          "-m",
          "Initialize fixture",
        ]);
        const config: OpenClawConfig = {
          gateway: {
            mode: "local",
            port: instance.port,
            bind: "loopback",
            auth: { mode: "token", token: instance.gatewayToken },
            controlUi: { enabled: false },
          },
          secrets: { providers: { default: { source: "env" } } },
          models: {
            mode: "replace",
            providers: {
              openai: {
                baseUrl: "https://api.openai.com/v1",
                api: "openai-responses",
                apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
                models: [
                  {
                    id: modelId,
                    name: modelId,
                    reasoning: true,
                    input: ["text"],
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    contextWindow: 200_000,
                    maxTokens: 2048,
                  },
                ],
              },
            },
          },
          agents: {
            defaults: {
              workspace: instance.state.workspaceDir,
              skipBootstrap: true,
              model: { primary: modelRef },
              models: { [modelRef]: { agentRuntime: { id: "openclaw" } } },
              thinkingDefault: "low",
              heartbeat: { every: "0m" },
              sandbox: { mode: "off" },
              timeoutSeconds: RUN_TIMEOUT_MS / 1000,
              subagents: { model: modelRef, maxSpawnDepth: 1 },
            },
          },
          tools: { codeMode: false, allow: ["read", "sessions_spawn"] },
        };
        await instance.state.writeConfig(config);
        await instance.startGateway();
        client = await connectGatewayClient({
          url: instance.url,
          token: instance.gatewayToken,
          role: "operator",
          scopes: ["operator.admin", "operator.read", "operator.write"],
          deviceIdentity: loadOrCreateDeviceIdentity({
            path: instance.state.path("operator-device.sqlite"),
          }),
          requestTimeoutMs: RUN_TIMEOUT_MS + 5_000,
          timeoutMs: 60_000,
          clientDisplayName: "vitest-visible-spawn-live",
        });
        const project = await client.request<{ id: string }>("projects.register", {
          path: repository,
          name: "Visible spawn fixture",
        });
        const parent = await client.request<{ key: string; entry: { worktree?: unknown } }>(
          "sessions.create",
          { agentId: "main", projectId: project.id, model: modelRef },
        );
        expect(parent.entry.worktree).toBeUndefined();
        const childTask = [
          "Do not spawn any further tasks.",
          "Read README.md from your current working directory using the read tool.",
          "Then reply with the CONTEXT_ marker from the inherited first user message",
          "followed by the README_ marker from that file, separated by a space.",
        ].join(" ");
        const message = [
          `Remember this context marker: ${contextMarker}.`,
          "Call sessions_spawn exactly once with visible=true, worktree=true, context='fork',",
          "runtime='subagent', label='Visible spawn child', and no cwd or other options.",
          `Set task to exactly this text: ${JSON.stringify(childTask)}.`,
          "Do not copy the marker into the child task or read the README yourself.",
          "After the spawn is accepted, finish by replying exactly PARENT_CONTINUED.",
        ].join("\n");
        const started = await client.request<{ runId: string }>("chat.send", {
          sessionKey: parent.key,
          message,
          idempotencyKey: randomUUID(),
        });
        await waitForRun(client, started.runId);
        const parentHistory = await readHistory(client, parent.key);
        const calls = parentHistory.flatMap((entry) =>
          Array.isArray(entry.content)
            ? entry.content
                .filter(isRecord)
                .filter((block) => block.type === "toolCall" && block.name === "sessions_spawn")
            : [],
        );
        expect(calls).toHaveLength(1);
        expect(calls[0]?.arguments).toMatchObject({
          visible: true,
          worktree: true,
          context: "fork",
          task: childTask,
        });
        expect(calls[0]?.arguments).not.toHaveProperty("cwd");
        expect(JSON.stringify(calls[0]?.arguments)).not.toContain(contextMarker);
        const spawnResult = parentHistory.find((entry) => entry.toolName === "sessions_spawn");
        const resultText = extractFirstTextBlock(spawnResult);
        const details: unknown = resultText ? JSON.parse(resultText) : undefined;
        expect(details).toMatchObject({ status: "accepted" });
        if (
          !isRecord(details) ||
          typeof details.childSessionKey !== "string" ||
          typeof details.runId !== "string"
        ) {
          throw new Error("Visible spawn omitted its child session or run ID");
        }
        expect(
          parentHistory
            .filter((entry) => entry.role === "assistant")
            .map((entry) => extractAssistantPhaseText(entry))
            .join("\n"),
        ).toContain("PARENT_CONTINUED");
        await waitForRun(client, details.runId);
        const listing = await client.request<{ sessions: SessionRow[] }>("sessions.list", {
          includeGlobal: true,
          limit: 100,
        });
        const child = listing.sessions.find((entry) => entry.key === details.childSessionKey);
        expect(child).toMatchObject({ parentSessionKey: parent.key, forkedFromParent: true });
        expect(child?.worktree?.repoRoot).toBe(await fs.realpath(repository));
        const childCwd = child?.spawnedCwd;
        if (!childCwd) {
          throw new Error("Visible child has no working directory");
        }
        expect(childCwd).not.toBe(repository);
        const commonDir = await execFileAsync(
          "git",
          ["-C", childCwd, "rev-parse", "--path-format=absolute", "--git-common-dir"],
          { env: instance.env },
        );
        expect(await fs.realpath(commonDir.stdout.trim())).toBe(
          await fs.realpath(path.join(repository, ".git")),
        );
        const childHistory = await readHistory(client, details.childSessionKey);
        const inheritedUser = childHistory.find((entry) => entry.role === "user");
        expect(extractFirstTextBlock(inheritedUser)).toContain(contextMarker);
        const userMessages = childHistory
          .filter((entry) => entry.role === "user")
          .map((entry) => extractFirstTextBlock(entry));
        expect(userMessages.at(-1), JSON.stringify(userMessages)).toContain(childTask);
        const childReply = childHistory
          .filter((entry) => entry.role === "assistant")
          .map((entry) => extractAssistantPhaseText(entry))
          .join("\n");
        expect(childReply).toContain(contextMarker);
        expect(childReply).toContain(fileMarker);
      },
      () => client?.stopAndWait({ timeoutMs: 2_000 }),
      () => instance.cleanup(),
    );
  }, 420_000);
});
