import { execFileSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startOpenClawCrablineAdapter } from "@openclaw/crabline";
import { asNonArrayRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { createQaGatewayChild } from "../../../../extensions/qa-lab/api.js";
import { listSessionEntriesReadOnly } from "../../../../src/config/sessions/session-accessor.js";
import { stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";
import {
  startHeldSlackModelProvider,
  waitForSlackGatewayFact,
  SLACK_INFLIGHT_MODEL,
  SLACK_INFLIGHT_ROOT_TEXT,
  SLACK_INFLIGHT_FOLLOWUP_TEXT,
  SLACK_INFLIGHT_ROOT_REPLY,
  SLACK_INFLIGHT_FOLLOWUP_REPLY,
} from "./slack-inflight-gateway.fixture.js";

const CHANNEL = "C12345678";
const USER = "U12345678";
const SOURCE_OWNERS = [
  "extensions/slack/src/monitor/message-handler/dispatch.ts",
  "extensions/slack/src/monitor/message-handler/prepare.ts",
  "extensions/slack/src/monitor/message-handler/types.ts",
  "extensions/slack/src/monitor/session-run-targets.ts",
];
type Post = { channel: unknown; threadTs: unknown; text: unknown };

describe("Slack in-flight follow-up through an actual Gateway", () => {
  it(
    "accepts unmentioned thread input before the first reply and delivers the follow-up",
    { timeout: 180_000 },
    async () => {
      const repoRoot = process.cwd();
      const directory = await fs.mkdtemp(
        path.join(await fs.realpath(os.tmpdir()), "slack-inflight-gateway-"),
      );
      const artifactDir = path.join(
        repoRoot,
        ".artifacts",
        "slack-inflight-gateway",
        path.basename(directory),
      );
      await fs.mkdir(artifactDir, { recursive: true });
      const owner = createQaGatewayChild();
      let adapter: Awaited<ReturnType<typeof startOpenClawCrablineAdapter>> | undefined;
      let provider: Awaited<ReturnType<typeof startHeldSlackModelProvider>> | undefined;
      const posts: Post[] = [];
      const evidence: Record<string, unknown> = {
        kind: "actual Gateway and core follow-up execution with simulated Slack/model HTTP",
        gatewayProcess: false,
        liveSlack: false,
        coreDispatchMocked: false,
        passed: false,
        sourceHead: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
        sourceOwners: await Promise.all(
          SOURCE_OWNERS.map(async (file) => ({
            path: file,
            sha256: createHash("sha256")
              .update(await fs.readFile(path.join(repoRoot, file)))
              .digest("hex"),
          })),
        ),
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
              posts.push({ channel: body.channel, threadTs: body.thread_ts, text: body.text });
            }
          },
        });
        const slack = adapter;
        if (slack.manifest.provider !== "slack") {
          throw new Error("Expected a Slack fixture");
        }
        const manifest = slack.manifest;
        const auth = asNonArrayRecord(await slack.probe());
        const botUserId = auth.user_id;
        if (typeof botUserId !== "string") {
          throw new Error("Slack fixture auth.test omitted the bot user id");
        }
        provider = await startHeldSlackModelProvider();
        const model = provider;
        const gateway = await owner.start({
          repoRoot,
          command: {
            executablePath: process.execPath,
            argsPrefix: [path.join(repoRoot, "openclaw.mjs")],
            argsSuffix: ["--verbose"],
            cwd: repoRoot,
            usePackagedPlugins: true,
          },
          providerBaseUrl: model.baseUrl,
          providerMode: "mock-openai",
          primaryModel: SLACK_INFLIGHT_MODEL,
          alternateModel: SLACK_INFLIGHT_MODEL,
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
                consoleLevel: "info",
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
                  replyToMode: "all",
                  streaming: { mode: "off" },
                  implicitMentions: { threadParticipation: true },
                  channels: { ...config.channels?.slack?.channels, "*": { requireMention: true } },
                },
              },
            };
          },
        });
        expect(gateway.pid).toEqual(expect.any(Number));
        expect(gateway.pid).not.toBe(process.pid);
        evidence.gatewayProcess = true;
        evidence.gatewayPid = gateway.pid;
        await waitForSlackGatewayFact(
          async () => {
            const status = asNonArrayRecord(
              await gateway.call("channels.status", { probe: false }),
            );
            const accounts = asNonArrayRecord(status.channelAccounts).slack;
            return Array.isArray(accounts) &&
              accounts.some((account) => asNonArrayRecord(account).running === true)
              ? true
              : undefined;
          },
          "Slack HTTP plugin readiness",
          60_000,
        );

        const deliver = async (text: string, threadId?: string) => {
          const inbound = slack.createInbound({
            input: {
              conversation: { id: CHANNEL, kind: "group" },
              senderId: USER,
              text,
              ...(threadId ? { threadId } : {}),
            },
          });
          const seeded = await fetch(inbound.providerUrl, {
            method: "POST",
            headers: inbound.providerHeaders,
            body: JSON.stringify(inbound.providerBody),
          });
          expect(seeded.ok).toBe(true);
          const payload = asNonArrayRecord(await seeded.json());
          const envelope = asNonArrayRecord(payload.event);
          const event = asNonArrayRecord(envelope.event);
          const body = JSON.stringify(envelope);
          const timestamp = String(Math.floor(Date.now() / 1000));
          const signature = createHmac("sha256", manifest.signingSecret)
            .update(`v0:${timestamp}:${body}`)
            .digest("hex");
          const accepted = await fetch(`${gateway.baseUrl}/slack/events`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-slack-request-timestamp": timestamp,
              "x-slack-signature": `v0=${signature}`,
            },
            body,
          });
          expect(accepted.ok).toBe(true);
          return event;
        };
        const root = await deliver(`<@${botUserId}> ${SLACK_INFLIGHT_ROOT_TEXT}`);
        const rootTs = root.ts;
        expect(typeof rootTs).toBe("string");
        if (typeof rootTs !== "string") {
          throw new Error("Root timestamp missing");
        }
        await waitForSlackGatewayFact(
          () => (model.rootHeld ? true : undefined),
          "held first actual model request",
          60_000,
        );
        expect(posts).toEqual([]);
        const sessions = listSessionEntriesReadOnly({
          agentId: "qa",
          env: gateway.runtimeEnv,
          readConsistency: "latest",
        }).filter(
          ({ sessionKey }) =>
            sessionKey.includes(":slack:") && sessionKey.endsWith(`:thread:${rootTs}`),
        );
        expect(sessions).toHaveLength(1);
        const sessionKey = sessions[0]!.sessionKey;
        const followup = await deliver(SLACK_INFLIGHT_FOLLOWUP_TEXT, rootTs);
        expect(followup.thread_ts).toBe(rootTs);
        expect(followup.ts).not.toBe(rootTs);
        evidence.inputIds = { rootTs, followupTs: followup.ts };
        const decision = await waitForSlackGatewayFact(async () => {
          expect(model.rootHeld).toBe(true);
          expect(posts).toEqual([]);
          const history = asNonArrayRecord(
            await gateway.call("chat.history", { sessionKey, limit: 20 }),
          );
          const pending = asNonArrayRecord(history.pendingInputs).items;
          evidence.admissionObservation = {
            rootHeld: model.rootHeld,
            visiblePosts: posts.length,
            pendingCount: Array.isArray(pending) ? pending.length : 0,
            historyContainsFollowup: JSON.stringify(history.messages).includes(
              SLACK_INFLIGHT_FOLLOWUP_TEXT,
            ),
          };
          const queued = Array.isArray(pending)
            ? pending
                .map(asNonArrayRecord)
                .find(
                  (item) =>
                    item.state === "queued" &&
                    JSON.stringify(item.message).includes(SLACK_INFLIGHT_FOLLOWUP_TEXT),
                )
            : undefined;
          if (queued) {
            return { kind: "queued", state: queued.state, runId: queued.runId };
          }
          const logTail = asNonArrayRecord(
            await gateway.call("logs.tail", { limit: 200, maxBytes: 200_000 }),
          );
          const lines = [
            ...(Array.isArray(logTail.lines) ? logTail.lines : []),
            ...gateway.logs().split("\n"),
          ].filter((line): line is string => typeof line === "string");
          // This producer runs after the real room mention gate, before
          // returning the prepared input to actual core dispatch.
          const prepared = lines.some(
            (line) =>
              line.includes("slack inbound:") && line.includes(`message_ts=${String(followup.ts)}`),
          );
          if (prepared) {
            return { kind: "prepared", messageTs: followup.ts };
          }
          const rejected = lines.some(
            (line) => line.includes(String(followup.ts)) && line.includes("missing-mention"),
          );
          return rejected ? { kind: "rejected", reason: "missing-mention" } : undefined;
        }, "actual follow-up admission or explicit mention rejection");
        evidence.beforeRelease = {
          rootHeld: model.rootHeld,
          visiblePosts: posts.length,
          followupTs: followup.ts,
          decision,
        };
        expect(["queued", "prepared"]).toContain(decision.kind);
        model.releaseRoot();
        await waitForSlackGatewayFact(
          () => (model.requests.some((request) => request.followup) ? true : undefined),
          "follow-up reaching the real model HTTP request",
        );
        await waitForSlackGatewayFact(
          () =>
            posts.some((post) => post.text === SLACK_INFLIGHT_FOLLOWUP_REPLY) ? true : undefined,
          "queued answer reaching Slack HTTP",
        );
        expect(posts).toEqual([
          { channel: CHANNEL, threadTs: rootTs, text: SLACK_INFLIGHT_ROOT_REPLY },
          { channel: CHANNEL, threadTs: rootTs, text: SLACK_INFLIGHT_FOLLOWUP_REPLY },
        ]);
        const replies = await fetch(`${manifest.endpoints.apiRoot}conversations.replies`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${manifest.botToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ channel: CHANNEL, ts: rootTs }),
        });
        const replyState = asNonArrayRecord(await replies.json());
        expect(replyState.ok).toBe(true);
        const storedReplies = Array.isArray(replyState.messages)
          ? replyState.messages
              .map(asNonArrayRecord)
              .filter((message) =>
                [SLACK_INFLIGHT_ROOT_REPLY, SLACK_INFLIGHT_FOLLOWUP_REPLY].includes(
                  String(message.text),
                ),
              )
          : [];
        expect(
          storedReplies.map((message) => ({ threadTs: message.thread_ts, text: message.text })),
        ).toEqual([
          { threadTs: rootTs, text: SLACK_INFLIGHT_ROOT_REPLY },
          { threadTs: rootTs, text: SLACK_INFLIGHT_FOLLOWUP_REPLY },
        ]);
        expect(model.errors).toEqual([]);
        evidence.posts = posts;
        evidence.modelRequests = model.requests.map(({ root: hasRoot, followup: hasFollowup }) => ({
          route: "/v1/responses",
          hasRoot,
          hasFollowup,
        }));
        evidence.sameThreadReadback = true;
        evidence.passed = true;
      } catch (error) {
        bodyError = error;
        evidence.posts = posts;
        evidence.modelRequests = provider?.requests.map(
          ({ root: hasRoot, followup: hasFollowup }) => ({ hasRoot, hasFollowup }),
        );
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
        try {
          await fs.writeFile(
            path.join(artifactDir, "verdict.json"),
            `${JSON.stringify(evidence, null, 2)}\n`,
          );
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      if (bodyError || cleanupErrors.length) {
        throw new AggregateError(
          [...(bodyError ? [bodyError] : []), ...cleanupErrors],
          `Slack in-flight Gateway proof failed; evidence: ${artifactDir}`,
        );
      }
    },
  );
});
