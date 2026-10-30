import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import type { ServerResponse } from "node:http";
import path from "node:path";
import { text as readText } from "node:stream/consumers";
import { assert, describe, expect, it } from "vitest";
import {
  writeOpenAiResponsesSse,
  writeOpenAiResponsesText,
} from "../../test/helpers/openai-responses-sse.js";
import { createDeferred } from "../../test/helpers/promise.js";
import type {
  ChannelOutboundAdapter,
  ChannelOutboundPayloadContext,
} from "../channels/plugins/outbound.types.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { loadSessionEntry, loadTranscriptEventsSync } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { peekSystemEvents } from "../infra/system-events.js";
import { createWarnLogCapture } from "../logging/test-helpers/warn-log-capture.js";
import { withServer } from "../plugin-sdk/test-helpers/http-test-server.js";
import { initializeGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { addTestHook } from "../plugins/hooks.test-helpers.js";
import { captureActivePluginRegistrySnapshot } from "../plugins/runtime.js";
import { getActiveGatewayRootWorkCount } from "../process/gateway-work-admission.js";
import type { Deferred } from "../shared/deferred.js";
import { closeSkillsWatchers } from "../skills/runtime/refresh.js";
import {
  activateTestChannelRegistry,
  createChannelTestPluginBase,
  createTestRegistry,
} from "../test-utils/channel-plugins.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { GatewayClient } from "./client.js";
import type { GatewayServer } from "./server.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";

type ProviderRequest = {
  model?: string;
  input?: Array<{
    type?: string;
    role?: string;
    output?: unknown;
    content?: Array<{ text?: string }>;
  }>;
};
type Action = { action: string; name: string; [key: string]: unknown };
type Change = {
  skillName: string;
  action: string;
  actor: string;
  runId: string;
  versionId?: string;
  sessionKey: string;
};
type HistoryMessage = {
  role?: string;
  content?: unknown;
  openclawDeliveryMirror?: unknown;
  idempotencyKey?: string;
};

function toolResponse(
  response: ServerResponse,
  args: Record<string, unknown>,
  id: string,
  name: string,
) {
  const item = {
    type: "function_call",
    id: `fc_${id}`,
    call_id: id,
    name,
    arguments: JSON.stringify(args),
    status: "completed",
  };
  writeOpenAiResponsesSse(response, [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, status: "in_progress", arguments: "" },
    },
    {
      type: "response.function_call_arguments.done",
      item_id: item.id,
      output_index: 0,
      arguments: item.arguments,
    },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: `resp_${id}`,
        status: "completed",
        output: [item],
        usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
      },
    },
  ]);
}

const originalSkill =
  "---\nname: contract-release\ndescription: Verify a release using independently checked receipts.\n---\n# Release\nCheck health.\n";
const createdSkill =
  "---\nname: contract-created\ndescription: Reuse a verified release receipt before publishing.\n---\n# Receipt\nCheck the receipt.\n";

async function withReview(
  actions: Action[],
  run: (fixture: {
    gateway: { client: GatewayClient; server: Pick<GatewayServer, "close"> };
    sessionKey: string;
    skillFile: string;
    createdFile: string;
    reviewRequests: ProviderRequest[];
    replayRequests: ProviderRequest[];
    started: Deferred;
    release: Deferred;
    changes: () => Promise<Change[]>;
    history: () => Promise<HistoryMessage[]>;
    foreground: (iterations?: number, key?: string) => Promise<void>;
    replay: () => Promise<void>;
    failure: { findText: (needle: string) => Promise<string | undefined> };
    sends: ChannelOutboundPayloadContext[];
    eventsAtSend: string[][];
    replyHooks: { count: number };
  }) => Promise<void>,
  options: {
    holdAt?: number;
    failAt?: number;
    channel?: "telegram" | "slack";
    deliveryFailure?: boolean;
    mode?: "auto" | "propose";
  } = {},
) {
  const state = await createOpenClawTestState({
    layout: "home",
    prefix: "openclaw-review-contract-",
    env: {
      OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
      OPENCLAW_SKIP_CHANNELS: "1",
      OPENCLAW_SKIP_GMAIL_WATCHER: "1",
      OPENCLAW_SKIP_CRON: "1",
      OPENCLAW_SKIP_CANVAS_HOST: "1",
      OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
      OPENCLAW_SKIP_PROVIDERS: "1",
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    },
  });
  const sessionKey = `agent:main:${options.channel ?? "dashboard"}:direct:review-contract-${randomUUID()}`;
  const skillFile = path.join(state.agentDir(), "workshop-skills", "contract-release", "SKILL.md");
  const createdFile = path.join(
    state.agentDir(),
    "workshop-skills",
    "contract-created",
    "SKILL.md",
  );
  const started = createDeferred();
  const release = createDeferred();
  const reviewRequests: ProviderRequest[] = [];
  const replayRequests: ProviderRequest[] = [];
  const providerErrors: unknown[] = [];
  const sends: ChannelOutboundPayloadContext[] = [];
  const eventsAtSend: string[][] = [];
  const replyHooks = { count: 0 };
  let gateway: { client: GatewayClient; server: Pick<GatewayServer, "close"> } | undefined;
  let mode: "foreground" | "review" | "replay" = "foreground";
  let remaining = 0;
  let serial = 0;
  const failure = createWarnLogCapture("review-contract");
  try {
    await fs.mkdir(path.dirname(skillFile), { recursive: true });
    await fs.writeFile(skillFile, originalSkill);
    await fs.mkdir(state.workspaceDir, { recursive: true });
    await fs.writeFile(
      path.join(state.workspaceDir, "receipt.txt"),
      "Public generation matches release.\n",
    );
    await withServer(
      (request, response) => {
        void (async () => {
          if (request.url !== "/v1/responses" || request.method !== "POST") {
            response.writeHead(404).end();
            return;
          }
          const payload = JSON.parse(await readText(request)) as ProviderRequest;
          serial += 1;
          if (mode === "foreground") {
            remaining -= 1;
            if (remaining > 0) {
              toolResponse(response, { path: "receipt.txt" }, `fg_${serial}`, "read");
            } else {
              writeOpenAiResponsesText(response, {
                text: "RECEIPTS_VERIFIED",
                messageId: `fg_${serial}`,
                responseId: `fg_${serial}`,
              });
            }
            return;
          }
          if (mode === "replay") {
            replayRequests.push(payload);
            writeOpenAiResponsesText(response, {
              text: "REPLAY_COMPLETE",
              messageId: `replay_${serial}`,
              responseId: `replay_${serial}`,
            });
            return;
          }
          const step = reviewRequests.length;
          reviewRequests.push(payload);
          if (step === (options.holdAt ?? 0)) {
            started.resolve();
            await release.promise;
          }
          if (step === options.failAt) {
            response.writeHead(400, { "content-type": "application/json" }).end(
              JSON.stringify({
                error: { message: "CONTRACT_PROVIDER_FAILURE", type: "invalid_request_error" },
              }),
            );
          } else if (actions[step]) {
            // Background review exposes skill_workshop directly, without Tool Search.
            toolResponse(response, actions[step], `review_${serial}`, "skill_workshop");
          } else {
            writeOpenAiResponsesText(response, {
              text: "NO_REPLY",
              messageId: `review_${serial}`,
              responseId: `review_${serial}`,
            });
          }
        })().catch((error: unknown) => {
          providerErrors.push(error);
          response.writeHead(500).end(String(error));
        });
      },
      async (baseUrl) => {
        const provider = buildMockOpenAiResponsesProvider(`${baseUrl}/v1`, "review-contract");
        const token = "isolated-review-contract-token";
        const config = {
          agents: {
            defaults: {
              workspace: state.workspaceDir,
              skipBootstrap: true,
              model: { primary: provider.modelRef },
              models: {
                [provider.modelRef]: { params: { transport: "sse", openaiWsWarmup: false } },
              },
            },
          },
          gateway: { auth: { mode: "token", token } },
          models: { mode: "replace", providers: { [provider.providerId]: provider.config } },
          plugins: { slots: { memory: "none" } },
          tools: { profile: "coding" },
          skills: {
            load: { watch: false },
            workshop: {
              autonomous: {
                mode: options.mode ?? "auto",
                channelNotices: Boolean(options.channel),
              },
            },
          },
        } satisfies OpenClawConfig;
        const active = await startGatewayWithClient({
          cfg: config,
          configPath: state.configPath,
          token,
          scopes: ["operator.admin", "operator.read", "operator.write"],
        });
        gateway = active;
        if (options.channel) {
          const channel = options.channel;
          const renderPresentation: NonNullable<ChannelOutboundAdapter["renderPresentation"]> = ({
            payload,
            presentation,
          }) => ({
            ...payload,
            channelData: { contract: { buttons: presentation.blocks } },
          });
          await activateTestChannelRegistry(
            createTestRegistry([
              {
                pluginId: channel,
                source: "test",
                plugin: {
                  ...createChannelTestPluginBase({ id: channel }),
                  outbound: {
                    deliveryMode: "direct",
                    presentationCapabilities: { supported: true, buttons: true },
                    renderPresentation,
                    sendText: async () => {
                      throw new Error("The structured Undo notice must use sendPayload");
                    },
                    sendPayload: async (context: ChannelOutboundPayloadContext) => {
                      sends.push(context);
                      eventsAtSend.push(peekSystemEvents(sessionKey));
                      if (options.deliveryFailure) {
                        throw new Error("CONTRACT_CHANNEL_FAILURE");
                      }
                      return { channel, messageId: "contract-notice-message" };
                    },
                  },
                },
              },
            ]),
          );
        }
        const registry = captureActivePluginRegistrySnapshot().activeRegistry;
        if (!registry) {
          throw new Error("Gateway plugin registry was not initialized");
        }
        addTestHook({
          registry,
          pluginId: "review-contract-observer",
          hookName: "before_agent_reply",
          eligibleTriggers: ["user"],
          handler: () => {
            replyHooks.count += 1;
          },
        });
        initializeGlobalHookRunner(registry);
        const foreground = async (iterations = 10, key = sessionKey) => {
          mode = "foreground";
          remaining = iterations;
          const accepted = await active.client.request<{ runId: string; status: string }>("agent", {
            sessionKey: key,
            ...(options.channel ? { channel: options.channel, to: "4321" } : {}),
            message: "Check release receipts individually and remember the verified procedure.",
            deliver: false,
            idempotencyKey: randomUUID(),
          });
          expect(accepted.status).toBe("accepted");
          const completed = await active.client.request<{ status: string }>(
            "agent.wait",
            { runId: accepted.runId, timeoutMs: 45_000 },
            { timeoutMs: 50_000 },
          );
          expect(completed.status).toBe("ok");
          expect(remaining).toBe(0);
          mode = "review";
        };
        const history = async () =>
          (
            await active.client.request<{ messages: HistoryMessage[] }>("chat.history", {
              sessionKey,
              limit: 200,
            })
          ).messages;
        const changes = async () =>
          (
            await active.client.request<{ changes: Change[] }>("skills.workshop.changes", {
              agentId: "main",
            })
          ).changes;
        await run({
          gateway: active,
          sessionKey,
          skillFile,
          createdFile,
          reviewRequests,
          replayRequests,
          started,
          release,
          changes,
          history,
          foreground,
          failure,
          sends,
          eventsAtSend,
          replyHooks,
          replay: async () => {
            mode = "replay";
            const accepted = await active.client.request<{ runId: string }>("agent", {
              sessionKey,
              message: "CONTRACT_REPLAY: acknowledge the current state without using tools.",
              deliver: false,
              idempotencyKey: randomUUID(),
            });
            expect(
              await active.client.request(
                "agent.wait",
                { runId: accepted.runId, timeoutMs: 45_000 },
                { timeoutMs: 50_000 },
              ),
            ).toMatchObject({ status: "ok" });
          },
        });
        expect(providerErrors).toEqual([]);
      },
    );
  } finally {
    release.resolve();
    failure.cleanup();
    if (gateway) {
      await disconnectGatewayClient(gateway.client);
      await gateway.server.close({ reason: "Review contract cleanup" });
    }
    await closeSkillsWatchers(true);
    await state.cleanup();
  }
}

async function waitForNotice(history: () => Promise<HistoryMessage[]>) {
  await expect
    .poll(async () => JSON.stringify(await history()), { timeout: 80_000, interval: 100 })
    .toContain("💾 Learned:");
  return (await history()).filter((message) => JSON.stringify(message).includes("💾 Learned:"));
}

const editActions: Action[] = [
  { action: "view", name: "contract-release" },
  {
    action: "patch",
    name: "contract-release",
    old_text: "Check health.",
    new_text: "Check the generation.",
    reason: "check the generation",
  },
  {
    action: "patch",
    name: "contract-release",
    old_text: "Check the generation.",
    new_text: "Check the generation and receipt.",
    reason: "check the generation and receipt",
  },
  {
    action: "create",
    name: "contract-created",
    content: createdSkill,
    reason: "reuse the receipt",
  },
  {
    action: "patch",
    name: "contract-created",
    old_text: "Check the receipt.",
    new_text: "Check the signed receipt.",
    reason: "check signature",
  },
];

describe("Workshop review through the real Gateway", () => {
  it(
    "groups notices, preserves creation, excludes notices from replay, and serializes undo of a real review",
    { timeout: 150_000 },
    async () => {
      await withReview(editActions, async (fixture) => {
        for (const segment of ["cron", "hook", "subagent"]) {
          await fixture.foreground(10, `agent:main:${segment}:excluded-contract`);
        }
        // Two real embedded completions, not a mocked scheduler event, accumulate to ten.
        await fixture.foreground(5);
        expect(fixture.reviewRequests).toHaveLength(0);
        await fixture.foreground(5);
        const hooksAfterForeground = fixture.replyHooks.count;
        expect(hooksAfterForeground).toBeGreaterThan(0);
        await fixture.started.promise;
        fixture.release.resolve();
        const notices = await waitForNotice(fixture.history);
        expect(notices).toHaveLength(1);
        expect(fixture.replyHooks.count).toBe(hooksAfterForeground);
        const changes = await fixture.changes();
        expect(changes).toHaveLength(4);
        expect(
          changes.every(
            (change) => change.actor === "review" && change.sessionKey === fixture.sessionKey,
          ),
        ).toBe(true);
        const firstChange = changes[0];
        assert.isDefined(firstChange);
        const runId = firstChange.runId;
        expect(runId).toMatch(/^skill-workshop-review:[0-9a-f-]{36}$/);
        const text =
          '💾 Learned: updated `contract-release` (check the generation and receipt); created `contract-created` (reuse the receipt). Say "undo" to revert this skill change.';
        const notice = notices[0];
        assert.isDefined(notice);
        expect(JSON.stringify(notice.content)).toContain(JSON.stringify(text).slice(1, -1));
        expect(notice.openclawDeliveryMirror).toEqual({
          kind: "skill-workshop-change",
          agentId: "main",
          runId,
          skills: [
            {
              name: "contract-release",
              action: "updated",
              summary: "check the generation and receipt",
            },
            { name: "contract-created", action: "created", summary: "reuse the receipt" },
          ],
        });
        const scope = {
          agentId: "main",
          sessionKey: fixture.sessionKey,
          storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
        };
        const entry = loadSessionEntry(scope);
        expect(entry).toBeDefined();
        const persisted = loadTranscriptEventsSync({ ...scope, sessionId: entry!.sessionId });
        expect(JSON.stringify(persisted)).toContain(`skill-workshop-notice:${runId}`);
        const events = peekSystemEvents(fixture.sessionKey).join("\n");
        const firstVersion = changes.findLast(
          (change) => change.skillName === "contract-release",
        )?.versionId;
        expect(events).toContain(
          `skill_workshop action=restore name=contract-release version=${firstVersion}`,
        );
        expect(events).toContain(
          'skill_workshop action=archive name=contract-created reason="undo"',
        );
        await fixture.replay();
        expect(fixture.replayRequests).toHaveLength(1);
        const replayRequest = fixture.replayRequests[0];
        assert.isDefined(replayRequest);
        const replayAssistants = replayRequest.input?.filter((item) => item.role === "assistant");
        expect(JSON.stringify(replayAssistants)).not.toContain("💾 Learned:");
        const undo = () =>
          fixture.gateway.client.request<{ status: string; changes: Change[] }>(
            "skills.workshop.undo",
            { agentId: "main", runId },
          );
        if (!firstVersion) {
          throw new Error("The first review edit did not retain its undo version");
        }
        const snapshot = path.join(
          path.dirname(path.dirname(fixture.skillFile)),
          ".archive",
          "contract-release",
          firstVersion,
        );
        const heldSnapshot = `${snapshot}.held`;
        await fs.rename(snapshot, heldSnapshot);
        try {
          await expect(undo()).rejects.toThrow("saved before it is no longer kept");
          expect(await fs.readFile(fixture.skillFile, "utf8")).toBe(
            originalSkill.replace("Check health.", "Check the generation and receipt."),
          );
          expect(await fs.readFile(fixture.createdFile, "utf8")).toBe(
            createdSkill.replace("Check the receipt.", "Check the signed receipt."),
          );
          expect(await fixture.changes()).toHaveLength(4);
        } finally {
          await fs.rename(heldSnapshot, snapshot);
        }
        const results = await Promise.all([undo(), undo()]);
        expect(results.map((result) => result.status).toSorted()).toEqual([
          "already-undone",
          "undone",
        ]);
        expect(
          results
            .flatMap((result) => result.changes)
            .map((change) => [change.skillName, change.action] as const)
            .toSorted(
              ([leftName, leftAction], [rightName, rightAction]) =>
                leftName.localeCompare(rightName) || leftAction.localeCompare(rightAction),
            ),
        ).toEqual([
          ["contract-created", "archive"],
          ["contract-release", "restore"],
        ]);
        expect(await fs.readFile(fixture.skillFile, "utf8")).toBe(originalSkill);
        await expect(fs.access(fixture.createdFile)).rejects.toThrow();
        expect(
          (await fixture.changes()).filter(
            (change) => change.runId === runId.replace("review:", "undo:"),
          ),
        ).toHaveLength(2);
        expect(peekSystemEvents(fixture.sessionKey).join("\n")).toContain(
          "The user already undid background skill review",
        );
        const requestsBeforeCommand = fixture.replayRequests.length;
        await fixture.gateway.client.request("chat.send", {
          sessionKey: fixture.sessionKey,
          message: `/learn undo ${runId.slice("skill-workshop-review:".length)}`,
          idempotencyKey: randomUUID(),
        });
        await expect
          .poll(async () => JSON.stringify(await fixture.history()), {
            timeout: 15_000,
            interval: 100,
          })
          .toContain("That skill change was already undone.");
        expect(fixture.replayRequests).toHaveLength(requestsBeforeCommand);
        await expect(
          fixture.gateway.client.request("skills.workshop.undo", {
            agentId: "main",
            runId: `skill-workshop-review:${randomUUID()}`,
          }),
        ).rejects.toThrow("No skill changes recorded");
      });
    },
  );

  it("announces changes committed before a provider failure", { timeout: 150_000 }, async () => {
    await withReview(
      editActions.slice(0, 2),
      async (fixture) => {
        await fixture.foreground();
        await fixture.started.promise;
        fixture.release.resolve();
        const notices = await waitForNotice(fixture.history);
        expect(notices).toHaveLength(1);
        expect(JSON.stringify(notices)).toContain("check the generation");
        expect(await fs.readFile(fixture.skillFile, "utf8")).toBe(
          originalSkill.replace("Check health.", "Check the generation."),
        );
        expect(await fixture.changes()).toHaveLength(1);
        await expect
          .poll(() => fixture.failure.findText("skill experience review failed"), {
            timeout: 15_000,
          })
          .toContain("skill experience review failed");
      },
      { failAt: 2 },
    );
  });

  it(
    "fences a reset after a committed edit: no second edit, notice, or undo event reaches the new generation",
    { timeout: 150_000 },
    async () => {
      await withReview(
        editActions.slice(0, 3),
        async (fixture) => {
          await fixture.foreground();
          await fixture.started.promise;
          expect(await fixture.changes()).toHaveLength(1);
          await fixture.gateway.client.request("sessions.reset", { key: fixture.sessionKey });
          fixture.release.resolve();
          await expect
            .poll(() => fixture.failure.findText("skill experience review failed"), {
              timeout: 30_000,
            })
            .toContain("skill experience review failed");
          expect(await fs.readFile(fixture.skillFile, "utf8")).toBe(
            originalSkill.replace("Check health.", "Check the generation."),
          );
          expect(await fixture.changes()).toHaveLength(1);
          expect(JSON.stringify(await fixture.history())).not.toContain("💾 Learned:");
          expect(peekSystemEvents(fixture.sessionKey).join("\n")).not.toContain(
            "background skill review just changed",
          );
        },
        { holdAt: 2 },
      );
    },
  );
  it.each(["permission", "deletion", "rewind"] as const)(
    "V6: refuses the first review write after source %s",
    { timeout: 150_000 },
    async (mutation) => {
      await withReview(
        editActions.slice(0, 2),
        async (fixture) => {
          await fixture.foreground();
          await fixture.started.promise;
          if (mutation === "permission") {
            await fixture.gateway.client.request("sessions.patch", {
              key: fixture.sessionKey,
              permissionMode: "read-only",
            });
          } else if (mutation === "deletion") {
            await fixture.gateway.client.request("sessions.delete", { key: fixture.sessionKey });
          } else {
            const history = await fixture.gateway.client.request<{
              messages: Array<{ role: string; __openclaw?: { id?: string } }>;
            }>("chat.history", { sessionKey: fixture.sessionKey });
            const entryId = history.messages.find((message) => message.role === "user")?.[
              "__openclaw"
            ]?.id;
            expect(entryId).toBeTruthy();
            await fixture.gateway.client.request("sessions.rewind", {
              sessionKey: fixture.sessionKey,
              entryId,
            });
          }
          fixture.release.resolve();
          await expect
            .poll(() => fixture.failure.findText("skill experience review failed"), {
              timeout: 30_000,
            })
            .toContain("skill experience review failed");
          expect(await fs.readFile(fixture.skillFile, "utf8")).toBe(originalSkill);
          expect(await fixture.changes()).toEqual([]);
          expect(peekSystemEvents(fixture.sessionKey).join("\n")).not.toContain(
            "background skill review just changed",
          );
        },
        { holdAt: 1 },
      );
    },
  );

  it.each([false, true])(
    "N3 N5: sends an opted-in channel notice with Undo (delivery failure: %s)",
    { timeout: 150_000 },
    async (deliveryFailure) => {
      await withReview(
        editActions.slice(0, 2),
        async (fixture) => {
          await fixture.foreground();
          await fixture.started.promise;
          fixture.release.resolve();
          if (deliveryFailure) {
            await expect
              .poll(() => fixture.failure.findText("skill workshop notice delivery failed"), {
                timeout: 80_000,
              })
              .toContain("skill workshop notice delivery failed");
            expect(JSON.stringify(await fixture.history())).not.toContain("💾 Learned:");
          } else {
            const notices = await waitForNotice(fixture.history);
            expect(notices).toHaveLength(1);
            const notice = notices[0];
            assert.isDefined(notice);
            // The session records its own notice once, with the marker; the send adds no copy.
            expect(notice.openclawDeliveryMirror).toMatchObject({
              kind: "skill-workshop-change",
            });
          }
          expect(
            fixture.sends,
            await fixture.failure.findText("skill workshop notice delivery failed"),
          ).toHaveLength(1);
          const firstChange = (await fixture.changes())[0];
          assert.isDefined(firstChange);
          const runId = firstChange.runId;
          expect(fixture.sends[0]).toMatchObject({
            to: "4321",
            payload: {
              text: '💾 Learned: updated `contract-release` (check the generation). Say "undo" to revert this skill change.',
              channelData: {
                contract: {
                  buttons: [
                    {
                      type: "buttons",
                      buttons: [
                        {
                          label: "Undo",
                          action: {
                            type: "command",
                            command: `/learn undo ${runId.slice("skill-workshop-review:".length)}`,
                          },
                        },
                      ],
                    },
                  ],
                },
              },
            },
          });
          const eventsAtSend = fixture.eventsAtSend[0];
          assert.isDefined(eventsAtSend);
          expect(eventsAtSend.join("\n")).toContain(
            "skill_workshop action=restore name=contract-release version=",
          );
          expect(peekSystemEvents(fixture.sessionKey).join("\n")).toContain(
            "skill_workshop action=restore name=contract-release version=",
          );
        },
        { channel: "telegram", deliveryFailure },
      );
    },
  );
  it(
    "V5: a propose-mode review saves a draft, changes no skill, and announces nothing",
    { timeout: 150_000 },
    async () => {
      const drafted = originalSkill.replace("Check health.", "Check the generation.");
      await withReview(
        [
          { action: "view", name: "contract-release" },
          {
            action: "patch",
            name: "contract-release",
            old_text: "Check health.",
            new_text: "Check the generation.",
            reason: "check the generation",
          },
          {
            action: "draft",
            name: "contract-release",
            content: drafted,
            reason: "check the generation",
          },
        ],
        async (fixture) => {
          fixture.release.resolve();
          await fixture.foreground();
          // view, refused patch, draft, then the closing reply.
          await expect
            .poll(() => fixture.reviewRequests.length, { timeout: 80_000, interval: 100 })
            .toBe(4);
          // A provider request is not completion: the review holds Gateway root work
          // until its closing notice step has run.
          await expect
            .poll(() => getActiveGatewayRootWorkCount(), { timeout: 30_000, interval: 100 })
            .toBe(0);
          const draftsDir = path.join(path.dirname(path.dirname(fixture.skillFile)), ".drafts");
          const [draftId, ...others] = await fs.readdir(draftsDir);
          expect(others).toEqual([]);
          expect(draftId).toMatch(/^contract-release-[0-9a-f]{8}$/);
          expect(await fs.readFile(path.join(draftsDir, draftId!, "SKILL.md"), "utf8")).toBe(
            drafted,
          );
          expect(await fs.readFile(fixture.skillFile, "utf8")).toBe(originalSkill);
          expect(await fixture.changes()).toEqual([]);
          expect(JSON.stringify(await fixture.history())).not.toContain("💾 Learned:");
          expect(
            await fixture.gateway.client.request<{ drafts: Array<{ id: string }> }>(
              "skills.workshop.list",
              { agentId: "main" },
            ),
          ).toMatchObject({
            mode: "propose",
            drafts: [
              { id: draftId, skillName: "contract-release", summary: "check the generation" },
            ],
          });
        },
        { mode: "propose" },
      );
    },
  );
});
