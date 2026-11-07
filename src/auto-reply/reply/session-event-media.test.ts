import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { loadOutboundMediaFromUrl } from "openclaw/plugin-sdk/outbound-media";
import { expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import { completionConfig } from "../../agents/bash-tools.lifecycle.test-support.js";
import { runEmbeddedAgent } from "../../agents/embedded-agent.js";
import { ensureSandboxWorkspaceForSession } from "../../agents/sandbox/context.js";
import type { ChannelOutboundAdapter } from "../../channels/plugins/outbound.types.js";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { resetSystemEventsForTest } from "../../infra/system-events.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import { drainGlobalSingletonLifecycleState } from "../../shared/global-singleton.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { dispatchInboundMessageWithRoutedChannelDispatcher } from "../dispatch.js";
import { getExistingFollowupQueue } from "./queue/state.js";
import { routeReply } from "./route-reply.js";
import {
  captureSessionEventTargetForHost,
  enqueueSessionEventForHost,
} from "./session-event-handoff.js";
import { startEmbeddedTurn } from "./session-event.test-support.js";

// mock-isolation: Replace the model boundary; admission, queueing, media and delivery stay real.
vi.mock("../../agents/embedded-agent-runner/run.js", () => ({ runEmbeddedAgent: vi.fn() }));
await Promise.all([
  import("../dispatch.js"),
  import("./get-reply-from-config.runtime.js").then((runtime) =>
    runtime.prewarmConfigDrivenReplyRuntime(),
  ),
]);

it.for(["relative", "container", "mixed"] as const)(
  "delivers sandbox media through a queued host event: %s",
  async (reference, { signal }) => {
    await withOpenClawTestState(
      { label: "session-event-media", env: { OPENCLAW_TEST_FAST: "0" } },
      async (state) => {
        const config = completionConfig(state.workspaceDir);
        expectDefined(config.agents?.defaults, "fixture agent defaults").sandbox = {
          mode: "all",
          workspaceAccess: "rw",
        };
        setRuntimeConfigSnapshot(config);
        await state.writeConfig(config);
        openOpenClawStateDatabase();
        const snapshot = captureActivePluginRegistrySnapshot();
        const registry = snapshot.activeRegistry;
        expect(registry).toBeDefined();
        if (!registry) {
          throw new Error("Expected the normal reply runtime registry");
        }
        const deliveries: Array<{ text: string; bytes?: Buffer }> = [];
        const sendText: NonNullable<ChannelOutboundAdapter["sendText"]> = async (ctx) => {
          deliveries.push({ text: ctx.text });
          return { channel: "telegram", messageId: `text-${deliveries.length}` };
        };
        const sendMedia: NonNullable<ChannelOutboundAdapter["sendMedia"]> = async (ctx) => {
          const media = await loadOutboundMediaFromUrl(expectDefined(ctx.mediaUrl, "media URL"), {
            mediaAccess: ctx.mediaAccess,
            mediaLocalRoots: ctx.mediaLocalRoots,
            mediaReadFile: ctx.mediaReadFile,
          });
          deliveries.push({ text: ctx.text, bytes: media.buffer });
          return { channel: "telegram", messageId: `media-${deliveries.length}` };
        };
        const channels = createTestRegistry([
          {
            pluginId: "telegram",
            source: "test",
            plugin: {
              ...createChannelTestPluginBase({
                id: "telegram",
                capabilities: { chatTypes: ["direct"], media: true },
              }),
              messaging: {
                normalizeTarget: (raw) => raw,
                targetResolver: { looksLikeId: (raw) => raw === "-100001" },
              },
              outbound: { deliveryMode: "direct", sendText, sendMedia },
            } satisfies ChannelPlugin,
          },
        ]);
        setActivePluginRegistry({
          ...registry,
          channels: [
            ...registry.channels.filter((entry) => entry.plugin.id !== "telegram"),
            ...channels.channels,
          ],
          channelSetups: [
            ...registry.channelSetups.filter((entry) => entry.plugin.id !== "telegram"),
            ...channels.channelSetups,
          ],
        });
        const sessionKey = `agent:main:media-${reference}`;
        const started = createDeferred();
        const release = createDeferred();
        const expected = Buffer.from("Owned session attachment\n");
        let calls = 0;
        vi.mocked(runEmbeddedAgent)
          .mockReset()
          .mockImplementation(async (params) => {
            const foreground = ++calls === 1;
            await startEmbeddedTurn(params, "media model admission");
            if (foreground) {
              started.resolve();
              await release.promise;
            }
            return {
              payloads: [
                {
                  text: foreground ? "Foreground file" : "Background file",
                  mediaUrl:
                    !foreground && reference === "mixed"
                      ? undefined
                      : foreground || reference === "container"
                        ? "/workspace/exports/proof.txt"
                        : "./exports/proof.txt",
                  mediaUrls:
                    !foreground && reference === "mixed"
                      ? ["/workspace/exports/proof.txt", "/workspace/exports/missing.txt"]
                      : undefined,
                },
              ],
              meta: { durationMs: 1 },
            };
          });
        const foreground = dispatchInboundMessageWithRoutedChannelDispatcher({
          cfg: config,
          ctx: {
            Body: "Create the foreground file",
            Provider: "telegram",
            Surface: "telegram",
            ChatType: "direct",
            SessionKey: sessionKey,
            From: "-100001",
            To: "fixture-bot",
            OriginatingChannel: "telegram",
            OriginatingTo: "-100001",
            AccountId: "default",
            SenderId: "fixture-owner",
          },
          dispatcherOptions: {
            deliver: async (payload, info) => {
              const result = await routeReply({
                cfg: config,
                payload,
                channel: "telegram",
                to: "-100001",
                accountId: "default",
                agentId: "main",
                sessionKey,
                replyKind: info.kind,
              });
              if (!result.ok) {
                throw new Error(result.error ?? "Foreground delivery failed");
              }
            },
          },
        });
        void foreground.catch(() => {});
        let event: ReturnType<typeof enqueueSessionEventForHost> | undefined;
        try {
          await withinTest(
            awaitGateBeforeSettlement(
              started.promise,
              foreground,
              "Foreground completed before model admission",
            ),
            signal,
          );
          const workspace = await ensureSandboxWorkspaceForSession({
            config,
            agentId: "main",
            sessionKey,
            workspaceDir: state.workspaceDir,
          });
          expect(workspace?.workspaceAccess).toBe("rw");
          if (!workspace) {
            throw new Error("Expected the canonical sandbox workspace layout");
          }
          await fs.mkdir(path.join(workspace.workspaceDir, "exports"), { recursive: true });
          await fs.writeFile(path.join(workspace.workspaceDir, "exports/proof.txt"), expected);
          const expectedTarget = await captureSessionEventTargetForHost("main", sessionKey);
          event = enqueueSessionEventForHost("The owned background work completed", {
            agentId: "main",
            sessionKey,
            source: "exec",
            expectedTarget,
            abortSignal: signal,
          });
          await vi.waitFor(() =>
            expect(getExistingFollowupQueue(sessionKey)?.items.length).toBe(1),
          );
          release.resolve();
          await withinTest(foreground, signal);
          expect(deliveries.find((item) => item.text === "Foreground file")?.bytes).toEqual(
            expected,
          );
          const outcome = await withinTest(event.settled, signal);
          expect(outcome, outcome.error).toMatchObject({
            status: "completed",
            executionStarted: true,
            delivered: true,
          });
          const background = deliveries.find((item) =>
            reference === "mixed"
              ? item.text.startsWith("Background file")
              : item.text === "Background file",
          );
          expect(background?.bytes).toEqual(expected);
          if (reference === "mixed") {
            expect(background?.text).toContain("missing.txt");
          }
          expect(calls).toBe(2);
        } finally {
          release.resolve();
          event?.cancel();
          await Promise.allSettled([foreground, event?.settled]);
          await drainGlobalSingletonLifecycleState("restart");
          resetSystemEventsForTest();
          restoreActivePluginRegistrySnapshot(snapshot);
          vi.mocked(runEmbeddedAgent).mockReset();
        }
      },
    );
  },
);
