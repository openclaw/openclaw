import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { isLiveTestEnabled } from "../src/agents/live-test-helpers.js";
import type { OpenClawConfig } from "../src/config/config.js";
import type { GatewayClient } from "../src/gateway/client.js";
import {
  connectTestGatewayClient,
  ensurePairedTestGatewayClientIdentity,
} from "../src/gateway/gateway-cli-backend.live-helpers.js";
import { extractFirstTextBlock } from "../src/shared/chat-message-content.js";
import {
  createCodexHarnessLiveInstance,
  createCodexHarnessWorkspace,
} from "./helpers/gateway-codex-harness.js";

const enabled = isLiveTestEnabled() && process.env.OPENCLAW_LIVE_CODEX_GOAL_RESUME === "1";

type HistoryMessage = {
  role?: string;
  toolName?: string;
  content?: unknown;
  __openclaw?: { transcriptPosition?: { source?: string; rawSeq?: number } };
};

function persistedHistory(messages: HistoryMessage[]) {
  return messages.map((message) => {
    const copy = structuredClone(message);
    // This cursor binds the current display generation, not persisted message bytes.
    if (copy["__openclaw"]?.transcriptPosition) {
      delete copy["__openclaw"].transcriptPosition.source;
    }
    return copy;
  });
}

type GoalRow = {
  key: string;
  sessionId?: string;
  hasActiveRun?: boolean;
  lastRunId?: string;
  agentRuntime?: { id?: string };
  goal?: {
    id: string;
    objective: string;
    createdAt: number;
    status: string;
    continuationTurns: number;
    lastStatusNote?: string;
  };
};

it.skipIf(!enabled).each(["paused", "human-decision"] as const)(
  "resumes the same local Codex Goal after a %s wait through the public RPC",
  async (waitKind) => {
    const humanWait = waitKind === "human-decision";
    const waitStatus = humanWait ? "blocked" : "paused";
    const model = process.env.OPENCLAW_LIVE_CODEX_HARNESS_MODEL;
    if (!model) {
      throw new Error("Set OPENCLAW_LIVE_CODEX_HARNESS_MODEL to an available native Codex model");
    }
    const token = `goal-proof-${randomUUID()}`;
    const instance = await createCodexHarnessLiveInstance(token, "codex-auth");
    // Native auth uses only the disposable HOME staged by the live-test owner.
    instance.env.CODEX_HOME = path.join(os.homedir(), ".codex");
    let client: GatewayClient | undefined;
    const sessionKey = `agent:main:local-goal-resume-${randomUUID()}`;
    const marker = `GOAL_RESUMED_${randomUUID()}`;
    const objective = humanWait
      ? "This synthetic Goal requires an explicit human decision before any remaining work: ask the operator to approve the synthetic configuration check and wait. Do not perform the check, mark the Goal complete, write files, or send external messages. There is no other independent work to do."
      : "This is a Goal Resume verification. Reply exactly GOAL_WAITING. The operator will pause this goal immediately after admission; do not update the goal status during this first turn. The operator will provide the next stage through a Goal edit before explicitly resuming. Do not use tools, write files, or send messages.";
    const editedObjective = `Read this goal through get_goal, then call update_goal with status complete and reply exactly ${marker}. This synthetic verification is complete after those two tool calls. Do not use other tools, write files, or send messages.`;
    try {
      instance.state.applyEnv();
      await createCodexHarnessWorkspace(instance.state.workspaceDir);
      const config: OpenClawConfig = {
        gateway: {
          mode: "local",
          port: instance.port,
          auth: { mode: "token", token },
          controlUi: { enabled: false },
        },
        plugins: {
          allow: ["codex"],
          entries: {
            codex: { enabled: true, config: { appServer: { mode: "yolo", homeScope: "user" } } },
          },
          slots: { memory: "none" },
        },
        agents: {
          defaults: {
            workspace: instance.state.workspaceDir,
            skipBootstrap: true,
            model: { primary: model },
            models: { [model]: { agentRuntime: { id: "codex" } } },
            timeoutSeconds: 180,
            thinkingDefault: "low",
            sandbox: { mode: "off" },
          },
        },
      };
      await fs.writeFile(instance.configPath, JSON.stringify(config));
      const deviceIdentity = await ensurePairedTestGatewayClientIdentity({
        displayName: "local-goal-resume-proof",
      });
      await instance.startGateway();
      client = await connectTestGatewayClient({
        url: instance.url,
        token,
        deviceIdentity,
        requestTimeoutMs: 180_000,
      });
      const row = async () => {
        const result = await client!.request<{ sessions: GoalRow[] }>("sessions.list", {
          limit: 100,
        });
        const found = result.sessions.find((entry) => entry.key === sessionKey);
        expect(found).toBeDefined();
        return found!;
      };
      await client.request("sessions.create", {
        key: sessionKey,
        agentId: "main",
        permissionMode: "full",
      });
      const start = await client.request<{ runId: string }>("chat.send", {
        sessionKey,
        message: objective,
        idempotencyKey: randomUUID(),
        intent: { kind: "session-goal-start", version: 1, issuedAtMs: Date.now() },
      });
      // The paused case exercises an operator stop; the human-wait case must
      // let the real model choose and persist its own stopping status.
      const waiting = await row();
      if (!humanWait) {
        await client.request("sessions.goal.update", {
          sessionKey,
          sessionId: waiting.sessionId,
          goalId: waiting.goal!.id,
          action: "pause",
          operationId: randomUUID(),
          issuedAtMs: Date.now(),
        });
      }
      const initialResult = await client.request("agent.wait", {
        runId: start.runId,
        timeoutMs: 180_000,
      });
      expect(initialResult, JSON.stringify(initialResult)).toMatchObject({ status: "ok" });
      await vi.waitFor(
        async () =>
          expect(await row()).toMatchObject({ hasActiveRun: false, goal: { status: waitStatus } }),
        { timeout: 30_000, interval: 200 },
      );
      const initialPaused = await row();
      expect(initialPaused.goal?.status).toBe(waitStatus);
      expect(initialPaused.agentRuntime?.id).toBe("codex");
      expect(initialPaused.goal).toMatchObject({ objective });
      if (humanWait) {
        expect(initialPaused.goal).toMatchObject({
          continuationTurns: 0,
          lastStatusNote: expect.stringContaining("Waiting on human:"),
        });
        const unrelated = await client.request<{ runId: string }>("chat.send", {
          sessionKey,
          message:
            "Unrelated message: reply exactly CONTEXT_ONLY. This is not approval or a request to resume the Goal. Do not use tools or continue the synthetic check.",
          idempotencyKey: randomUUID(),
        });
        expect(
          await client.request("agent.wait", { runId: unrelated.runId, timeoutMs: 180_000 }),
        ).toMatchObject({ status: "ok" });
        await vi.waitFor(
          async () =>
            expect(await row()).toMatchObject({
              hasActiveRun: false,
              lastRunId: unrelated.runId,
              goal: { id: initialPaused.goal!.id, status: "blocked", continuationTurns: 0 },
            }),
          { timeout: 30_000, interval: 200 },
        );
        const history = await client.request<{ messages: HistoryMessage[] }>("chat.history", {
          sessionKey,
          limit: 100,
        });
        expect(
          history.messages.some(
            (message) => message.role === "toolResult" && message.toolName === "update_goal",
          ),
          "the native model must record its own wait through the Core Goal tool",
        ).toBe(true);
      }
      await client.request("sessions.goal.update", {
        sessionKey,
        sessionId: initialPaused.sessionId,
        goalId: initialPaused.goal!.id,
        action: "edit",
        objective: editedObjective,
        operationId: randomUUID(),
        issuedAtMs: Date.now(),
      });
      const paused = await row();
      expect(paused).toMatchObject({
        sessionId: initialPaused.sessionId,
        goal: {
          id: initialPaused.goal!.id,
          objective: editedObjective,
          createdAt: initialPaused.goal!.createdAt,
          status: waitStatus,
        },
      });
      const before = await client.request<{ messages: HistoryMessage[] }>("chat.history", {
        sessionKey,
        limit: 100,
      });
      const request = {
        sessionKey,
        sessionId: paused.sessionId,
        goalId: paused.goal!.id,
        action: "resume",
        operationId: randomUUID(),
        issuedAtMs: Date.now(),
      };
      const resumed = await client.request<{ runId: string }>("sessions.goal.update", request);
      expect(resumed).toMatchObject({ status: "started", goalId: paused.goal!.id });
      const resumedResult = await client.request("agent.wait", {
        runId: resumed.runId,
        timeoutMs: 180_000,
      });
      expect(resumedResult, JSON.stringify(resumedResult)).toMatchObject({ status: "ok" });
      await vi.waitFor(
        async () =>
          expect(await row()).toMatchObject({
            sessionId: paused.sessionId,
            hasActiveRun: false,
            goal: {
              id: paused.goal!.id,
              objective: editedObjective,
              createdAt: paused.goal!.createdAt,
              status: "complete",
            },
          }),
        { timeout: 30_000, interval: 200 },
      );
      const after = await client.request<{ messages: HistoryMessage[] }>("chat.history", {
        sessionKey,
        limit: 100,
      });
      expect(
        after.messages.filter((message) => message.role === "assistant").map(extractFirstTextBlock),
      ).toContain(marker);
      expect(persistedHistory(after.messages.slice(0, before.messages.length))).toEqual(
        persistedHistory(before.messages),
      );
      expect(
        after.messages
          .slice(before.messages.length)
          .some((message) => message.role === "toolResult" && message.toolName === "get_goal"),
        "the resumed native model must read the edited objective from get_goal",
      ).toBe(true);
      const settled = await row();
      expect(await client.request("sessions.goal.update", request)).toMatchObject({
        replayed: true,
        runId: resumed.runId,
      });
      expect(await row()).toMatchObject({ lastRunId: settled.lastRunId, hasActiveRun: false });
      expect(
        (
          await client.request<{ messages: HistoryMessage[] }>("chat.history", {
            sessionKey,
            limit: 100,
          })
        ).messages,
      ).toEqual(after.messages);
      console.log(
        JSON.stringify({
          proof: humanWait ? "local-codex-human-decision-wait" : "local-codex-same-goal-resume",
          ...(humanWait
            ? {
                modelRecordedWait: true,
                continuationTurnsBeforeResume: 0,
                unrelatedMessageKeptBlocked: true,
              }
            : {}),
          goalId: paused.goal!.id,
          sessionId: paused.sessionId,
          followedEditedObjective: true,
          preservedHistory: true,
          completed: true,
          replayedWithoutNewRun: true,
        }),
      );
    } finally {
      await client?.stopAndWait();
      await instance.cleanup();
    }
  },
  480_000,
);
