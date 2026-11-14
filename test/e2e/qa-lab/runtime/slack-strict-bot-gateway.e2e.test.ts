import { createHmac } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { startOpenClawCrablineAdapter } from "@openclaw/crabline";
import { asNonArrayRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { stopQaGatewayFixture } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import {
  createQaGatewayChild,
  startQaMockOpenAiServer,
} from "../../../../extensions/qa-lab/api.js";

const CHANNEL = "C12345678";
const HUMAN = "U12345678";
const BOT = "U22345678";
const MODEL = "mock-openai/gpt-5.6-luna";
async function until<T>(read: () => Promise<T | undefined> | T | undefined, label: string) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) {
      return value;
    }
    await sleep(50);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

describe("Slack strict bot mentions through an actual Gateway", () => {
  it.runIf(process.env.OPENCLAW_QA_SLACK_STRICT_E2E === "1")(
    "rejects both implicit bot kinds before model dispatch and preserves explicit, human, and legacy replies",
    { timeout: 240_000 },
    async () => {
      const repoRoot = process.cwd();
      const directory = await fs.mkdtemp(
        path.join(await fs.realpath(os.tmpdir()), "slack-strict-"),
      );
      const artifactDir = path.join(
        repoRoot,
        ".artifacts",
        "slack-strict-gateway",
        path.basename(directory),
      );
      await fs.mkdir(artifactDir, { recursive: true });
      const owner = createQaGatewayChild();
      const posts: Array<{ text: unknown; threadTs: unknown }> = [];
      let adapter: Awaited<ReturnType<typeof startOpenClawCrablineAdapter>> | undefined;
      let provider: Awaited<ReturnType<typeof startQaMockOpenAiServer>> | undefined;
      const evidence: Record<string, unknown> = {
        gatewayProcess: false,
        liveSlack: false,
        passed: false,
      };
      let bodyError: unknown;
      const cleanupErrors: unknown[] = [];
      try {
        adapter = await startOpenClawCrablineAdapter({
          channel: "slack",
          recorderPath: path.join(directory, "provider.jsonl"),
          onEvent(event) {
            if (event.type === "api" && event.path.endsWith("/api/chat.postMessage")) {
              const body = asNonArrayRecord(event.body);
              posts.push({ text: body.text, threadTs: body.thread_ts });
            }
          },
        });
        const slack = adapter;
        if (slack.manifest.provider !== "slack") {
          throw new Error("Expected Slack fixture");
        }
        const manifest = slack.manifest;
        const identity = asNonArrayRecord(await slack.probe());
        const botUserId = identity.user_id;
        if (typeof botUserId !== "string") {
          throw new Error("Missing synthetic bot identity");
        }
        provider = await startQaMockOpenAiServer();
        const model = provider;
        const gateway = await owner.start({
          repoRoot,
          command: {
            executablePath: process.execPath,
            argsPrefix: [path.join(repoRoot, "openclaw.mjs")],
            argsSuffix: ["--verbose"],
            cwd: repoRoot,
            usePackagedPlugins: false,
          },
          providerBaseUrl: `${model.baseUrl}/v1`,
          providerMode: "mock-openai",
          primaryModel: MODEL,
          alternateModel: MODEL,
          controlUiEnabled: false,
          transportBaseUrl: manifest.endpoints.apiRoot,
          transport: {
            requiredPluginIds: slack.requiredPluginIds,
            createGatewayConfig: () => slack.createGatewayConfig() as OpenClawConfig,
          },
          runtimeEnvPatch: slack.createProviderReadinessEnv({}),
          mutateConfig(config) {
            return {
              ...config,
              logging: {
                ...config.logging,
                level: "debug",
                consoleLevel: "debug",
                file: path.join(directory, "runtime.jsonl"),
              },
              messages: {
                ...config.messages,
                ackReaction: "",
                statusReactions: { enabled: false },
                inbound: { debounceMs: 0 },
                queue: { mode: "followup" },
              },
              agents: {
                ...config.agents,
                defaults: { ...config.agents?.defaults, typingMode: "never" },
              },
              channels: {
                ...config.channels,
                slack: {
                  ...config.channels?.slack,
                  allowBots: "mentions",
                  requireExplicitBotMention: true,
                  replyToMode: "all",
                  streaming: { mode: "off" },
                  implicitMentions: { replyToBot: true, threadParticipation: true },
                  channels: { "*": { requireMention: true, users: [HUMAN, BOT] } },
                },
              },
            };
          },
        });
        evidence.gatewayProcess = true;
        evidence.gatewayPid = gateway.pid;
        await until(async () => {
          const status = asNonArrayRecord(await gateway.call("channels.status", { probe: false }));
          const accounts = asNonArrayRecord(status.channelAccounts).slack;
          return Array.isArray(accounts) &&
            accounts.some((account) => asNonArrayRecord(account).running === true)
            ? true
            : undefined;
        }, "Slack HTTP readiness");
        const cursor = async () =>
          asNonArrayRecord(await (await fetch(`${model.baseUrl}/debug/request-cursor`)).json())
            .cursor;
        const deliver = async (
          marker: string,
          options: { bot?: boolean; threadTs?: string; parent?: string; explicit?: boolean } = {},
        ) => {
          const input = slack.createInbound({
            input: {
              conversation: { id: CHANNEL, kind: "group" },
              senderId: options.bot ? BOT : HUMAN,
              text: `${options.explicit ? `<@${botUserId}> ` : ""}Reply exactly: ${marker}`,
              ...(options.threadTs ? { threadId: options.threadTs } : {}),
            },
          });
          const seeded = await fetch(input.providerUrl, {
            method: "POST",
            headers: input.providerHeaders,
            body: JSON.stringify(input.providerBody),
          });
          expect(seeded.ok).toBe(true);
          const payload = asNonArrayRecord(await seeded.json());
          const envelope = asNonArrayRecord(payload.event);
          const event = asNonArrayRecord(envelope.event);
          if (options.bot) {
            event.bot_id = "B22345678";
          }
          if (options.parent) {
            event.parent_user_id = options.parent;
          }
          const body = JSON.stringify(envelope);
          const timestamp = String(Math.floor(Date.now() / 1000));
          const signature = createHmac("sha256", manifest.signingSecret)
            .update(`v0:${timestamp}:${body}`)
            .digest("hex");
          const accepted = await fetch(`${gateway.baseUrl}/slack/events`, {
            method: "POST",
            body,
            headers: {
              "content-type": "application/json",
              "x-slack-request-timestamp": timestamp,
              "x-slack-signature": `v0=${signature}`,
            },
          });
          expect(accepted.ok).toBe(true);
          return event;
        };
        const root = await deliver("QA-STRICT-SEED", { explicit: true });
        const threadTs = root.ts;
        if (typeof threadTs !== "string") {
          throw new Error("Missing root timestamp");
        }
        const replied = (marker: string) =>
          until(
            () =>
              posts.some((post) => post.text === marker && post.threadTs === threadTs)
                ? true
                : undefined,
            marker,
          );
        await replied("QA-STRICT-SEED");
        const rejected: string[] = [];
        for (const kind of ["reply_to_bot", "bot_thread_participant"]) {
          const before = await cursor();
          const mark = gateway.markLogs();
          const blocked = await deliver(`QA-STRICT-BLOCKED-${kind}`, {
            bot: true,
            threadTs,
            parent: kind === "reply_to_bot" ? botUserId : HUMAN,
          });
          await until(async () => {
            const tail = asNonArrayRecord(
              await gateway.call("logs.tail", { limit: 300, maxBytes: 256000 }),
            );
            const lines = [
              ...gateway.readLogsSince(mark).split("\n"),
              ...(Array.isArray(tail.lines)
                ? tail.lines.filter((line): line is string => typeof line === "string")
                : []),
            ];
            evidence.observedRejectionReasons = [
              "bot-missing-mention",
              "bot-message",
              "missing-mention",
              "channel-denied",
              "bot-loop-guard",
            ].filter((reason) => lines.some((line) => line.includes(reason)));
            return lines.some(
              (line) => line.includes("bot-missing-mention") && line.includes(String(blocked.ts)),
            )
              ? true
              : undefined;
          }, `correlated ${kind} rejection`);
          expect(await cursor()).toBe(before);
          expect(
            posts.some((post) => String(post.text).includes(`QA-STRICT-BLOCKED-${kind}`)),
          ).toBe(false);
          rejected.push(kind);
        }
        await deliver("QA-STRICT-EXPLICIT", { bot: true, explicit: true, threadTs, parent: HUMAN });
        await replied("QA-STRICT-EXPLICIT");
        await deliver("QA-STRICT-HUMAN", { threadTs, parent: HUMAN });
        await replied("QA-STRICT-HUMAN");
        const snapshot = asNonArrayRecord(await gateway.call("config.get", {}));
        const patched = asNonArrayRecord(
          await gateway.call("config.patch", {
            baseHash: snapshot.hash,
            raw: JSON.stringify({ channels: { slack: { requireExplicitBotMention: false } } }),
            restartDelayMs: 0,
          }),
        );
        expect(patched.hash).toEqual(expect.any(String));
        await deliver("QA-STRICT-LEGACY", { bot: true, threadTs, parent: HUMAN });
        await replied("QA-STRICT-LEGACY");
        const replies = asNonArrayRecord(
          await (
            await fetch(`${manifest.endpoints.apiRoot}conversations.replies`, {
              method: "POST",
              headers: {
                authorization: `Bearer ${manifest.botToken}`,
                "content-type": "application/json",
              },
              body: JSON.stringify({ channel: CHANNEL, ts: threadTs }),
            })
          ).json(),
        );
        const stored = Array.isArray(replies.messages)
          ? replies.messages.map(asNonArrayRecord)
          : [];
        for (const marker of [
          "QA-STRICT-SEED",
          "QA-STRICT-EXPLICIT",
          "QA-STRICT-HUMAN",
          "QA-STRICT-LEGACY",
        ]) {
          expect(
            stored.filter((message) => message.text === marker && message.thread_ts === threadTs),
          ).toHaveLength(1);
        }
        expect(posts).toHaveLength(4);
        evidence.rejectedImplicitKinds = rejected;
        evidence.positiveReplies = 4;
        evidence.storedReplyReadback = true;
        evidence.modelRequestCursor = await cursor();
        evidence.passed = true;
      } catch (error) {
        bodyError = error;
      } finally {
        for (const cleanup of [
          () =>
            stopQaGatewayFixture(owner, {
              preserveToDir: path.join(artifactDir, "gateway"),
              keepTemp: false,
            }),
          () => provider?.stop(),
          () => adapter?.close(),
          () => fs.rm(directory, { recursive: true, force: true }),
        ]) {
          try {
            await cleanup();
          } catch (error) {
            cleanupErrors.push(error);
          }
        }
        evidence.cleanupComplete = cleanupErrors.length === 0;
        await fs.writeFile(
          path.join(artifactDir, "verdict.json"),
          `${JSON.stringify(evidence, null, 2)}\n`,
        );
      }
      if (bodyError || cleanupErrors.length) {
        throw new AggregateError(
          [...(bodyError ? [bodyError] : []), ...cleanupErrors],
          "Strict bot Gateway proof failed",
        );
      }
    },
  );
});
