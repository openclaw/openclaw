import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import { createOpenClawTestInstance } from "../../test/helpers/openclaw-test-instance.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import { captureRuntimeConfigAsyncReader } from "../config/io.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { extractFirstTextBlock } from "../shared/chat-message-content.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { sessionKey } from "./server-methods/sessions-github-read.test-support.js";
import { bind, git } from "./server-methods/sessions-github-readiness.test-support.js";

export function expectOwnerReadiness(readiness: unknown) {
  expect(readiness).toMatchObject({
    policy: { read: "admitted", write: "unknown" },
    custody: { kind: "qualified", source: "worktree" },
    target: { kind: "supported", basis: "registered-repository" },
  });
}

export async function proveOwnerSharingThroughCli(options: {
  config: OpenClawConfig;
  prompt: string;
  finalText: string;
  waitMs: number;
  signal: AbortSignal;
  env?: Record<string, string | undefined>;
}) {
  const instance = await createOpenClawTestInstance({
    name: "owner-sharing-authority",
    state: { prepareProfileCatalog: true },
    signal: options.signal,
    config: {
      ...options.config,
      gateway: {
        roles: {
          default: "guest",
          definitions: {
            guest: {
              scopes: ["operator.write"],
              sessions: { others: "none" },
              agents: ["main"],
            },
          },
        },
      },
      tools: {
        allow: ["github_publish"],
        codeMode: { enabled: false },
        toolSearch: false,
        gatewayPolicy: { allow: ["github_publish"], actions: { github_publish: ["readiness"] } },
      },
      hooks: { enabled: false },
    },
    env: {
      ...options.env,
      OPENCLAW_SKIP_PROVIDERS: undefined,
      OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
    },
  });
  return await runQaGatewayFixture(
    async () => {
      instance.state.applyEnv();
      await captureRuntimeConfigAsyncReader()();
      const creator = ensureProfileForEmail("session-creator@example.test");
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey },
        {
          sessionId: randomUUID(),
          label: "Owner sharing proof",
          updatedAt: Date.now(),
          createdActor: { type: "human", source: "profile", id: creator.id },
        },
      );
      const worktree = await bind();
      const head = await git(worktree.path, "rev-parse", "HEAD");
      const status = await git(worktree.path, "status", "--porcelain");
      await instance.startGateway();
      const cli = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
        const result = await instance.cli(
          [
            "gateway",
            "call",
            method,
            "--url",
            instance.url,
            "--token",
            instance.gatewayToken,
            "--params",
            JSON.stringify(params),
            "--json",
            // Transport and CLI ownership must outlive the server's agent.wait deadline.
            "--timeout",
            String(options.waitMs + 5_000),
          ],
          { timeoutMs: options.waitMs + 10_000 },
        );
        expect(result.code, result.stderr).toBe(0);
        return JSON.parse(result.stdout) as T;
      };
      // Production CLI selects scopes and identity; the fixture supplies neither.
      const accepted = await cli<{ runId: string; status: string }>("chat.send", {
        sessionKey,
        message: options.prompt,
        deliver: false,
        idempotencyKey: randomUUID(),
      });
      expect(accepted.status).toBe("started");
      expect(
        await cli("agent.wait", { runId: accepted.runId, timeoutMs: options.waitMs }),
      ).toMatchObject({ status: "ok" });
      const history = await cli<{
        messages: Array<{
          role: string;
          toolName?: string;
          content:
            | string
            | Array<{ type: string; name?: string; arguments?: unknown; text?: string }>;
        }>;
      }>("chat.history", { sessionKey, limit: 30 });
      expect(history.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ role: "user", content: options.prompt }),
          expect.objectContaining({
            role: "assistant",
            content: expect.arrayContaining([
              expect.objectContaining({ type: "text", text: options.finalText }),
            ]),
          }),
        ]),
      );
      const calls = history.messages
        .filter((message) => message.role === "assistant")
        .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
        .filter((block) => block.type === "toolCall" && block.name === "github_publish");
      expect(calls.map((call) => call.arguments)).toEqual([
        { action: "readiness" },
        { action: "readiness", publishingSessionKey: sessionKey },
      ]);
      const results = history.messages.filter(
        (message) => message.role === "toolResult" && message.toolName === "github_publish",
      );
      expect(results).toHaveLength(2);
      for (const result of results) {
        const text = extractFirstTextBlock(result);
        assert(text, "history must retain each actual readiness result");
        expectOwnerReadiness(JSON.parse(text));
      }
      expect(await git(worktree.path, "rev-parse", "HEAD")).toBe(head);
      expect(await git(worktree.path, "status", "--porcelain")).toBe(status);
      return history;
    },
    () => instance.cleanup(),
  );
}
