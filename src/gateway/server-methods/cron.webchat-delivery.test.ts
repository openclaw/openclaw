import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { Value } from "typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PROTOCOL_VERSION } from "../../../packages/gateway-protocol/src/version.js";
import { createOperationalRunInstanceRef } from "../../agents/admitted-run-context.js";
import { createCronTool } from "../../agents/tools/cron-tool.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import {
  replaceSessionEntry,
  resetSessionEntryLifecycle,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { CronService } from "../../cron/service.js";
import { createNoopLogger } from "../../cron/service.test-harness.js";
import type { CronDelivery } from "../../cron/types.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createDirectOutboundTestAdapter,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { isRecord } from "../../utils.js";
import {
  normalizeSessionDeliveryState,
  type DeliveryContext,
} from "../../utils/delivery-context.shared.js";
import { createAgentRuntimeApprovalAuthorityValidator } from "../agent-runtime-approval-authority.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { cronHandlers } from "./cron.js";
import type { GatewayClient } from "./types.js";

const sessionKey = "agent:main:dashboard:webchat-conversation";
afterEach(() => resetPluginRuntimeStateForTest());

async function withWebchatTool(
  check: (fixture: {
    add: (
      delivery?: CronDelivery,
      target?: "current" | "isolated",
    ) => ReturnType<ReturnType<typeof createCronTool>["execute"]>;
    tool: ReturnType<typeof createCronTool>;
    cron: CronService;
    revoke: () => void;
    creatorStorePath: string;
  }) => Promise<void>,
  storedContext: DeliveryContext = { channel: "webchat", to: sessionKey },
  channelsEnabled = true,
) {
  await withOpenClawTestState({ layout: "home" }, async (state) => {
    const sessionStorePath = path.join(state.sessionsDir(), "sessions.json");
    const cfg: OpenClawConfig = {
      agents: { entries: { main: { workspace: state.workspaceDir } } },
      session: { store: sessionStorePath },
      channels: channelsEnabled
        ? { discord: { token: "test-token" }, telegram: { botToken: "test-token" } }
        : {},
      plugins: { entries: { discord: { enabled: true }, telegram: { enabled: true } } },
    };
    setRuntimeConfigSnapshot(cfg);
    setActivePluginRegistry(
      createTestRegistry(
        (channelsEnabled ? ["discord", "telegram"] : []).map((id) => ({
          pluginId: id,
          plugin: {
            ...createChannelTestPluginBase({ id, config: { isConfigured: () => true } }),
            outbound: createDirectOutboundTestAdapter({ channel: id }),
          },
          source: "test:webchat-cron",
        })),
      ),
    );
    await replaceSessionEntry(
      { agentId: "main", sessionKey, storePath: sessionStorePath },
      {
        sessionId: "webchat-source",
        updatedAt: 1,
        delivery: normalizeSessionDeliveryState({ context: storedContext }),
      },
    );
    const storePath = state.statePath("cron", "jobs.json");
    const cron = new CronService({
      scheduler: createTestGatewayScheduler(),
      nowMs: () => Date.now(),
      storePath,
      cronEnabled: false,
      defaultAgentId: "main",
      log: createNoopLogger(),
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: async () => {
        throw new Error("disabled fixture must not run an agent");
      },
    });
    const operationalRunInstance = createOperationalRunInstanceRef("webchat-cron-create");
    const authority = claimAgentRunDelegatedAuthority(operationalRunInstance);
    const revoke = () => releaseAgentRunDelegatedAuthority(authority);
    const client: GatewayClient = {
      connect: {
        minProtocol: PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
        client: { id: "test", version: "test", platform: "test", mode: "test" },
      },
      internal: {
        agentRuntimeIdentity: {
          kind: "agentRuntime",
          agentId: "main",
          sessionKey,
          operationalRunInstance,
          delegatedAuthority: { kind: "local", ...authority },
        },
      },
    };
    const context = createDirectChatContext({
      cron,
      cronStorePath: storePath,
      getRuntimeConfig: () => cfg,
      validateAgentRuntimeApprovalAuthority: createAgentRuntimeApprovalAuthorityValidator(),
    });
    const tool = createCronTool(
      {
        config: cfg,
        agentSessionKey: sessionKey,
        currentDeliveryContext: {
          channel: "webchat",
          to: sessionKey,
          accountId: "internal-account",
          threadId: "internal-thread",
        },
        creatorToolAllowlist: ["read"],
      },
      {
        callGatewayTool: async (method, _opts, params) => {
          expect(["cron.add", "cron.update", "cron.get"]).toContain(method);
          if (!isRecord(params)) {
            throw new Error("expected cron request record");
          }
          const respond = vi.fn();
          await expectDefined(
            cronHandlers[method],
            "cron handler",
          )({
            req: { type: "req", id: "webchat-cron-add", method, params },
            params,
            respond,
            context,
            client,
            isWebchatConnect: () => false,
          });
          const [ok, result, error] = expectDefined(respond.mock.calls[0], "cron response");
          if (!ok) {
            throw new Error(String(error.message));
          }
          return result;
        },
      },
    );
    try {
      await check({
        cron,
        creatorStorePath: sessionStorePath,
        revoke,
        tool,
        add: async (delivery, target = "current") => {
          return await tool.execute("webchat-condition-watcher", {
            action: "add",
            job: {
              name: "WebChat condition watcher",
              enabled: false,
              sessionTarget: target,
              schedule: { kind: "every", everyMs: 60_000 },
              payload: { kind: "agentTurn", message: "Report the condition result." },
              trigger: { script: "return { fire: false };", once: true },
              ...(delivery ? { delivery } : {}),
            },
          });
        },
      });
    } finally {
      revoke();
      cron.stop();
    }
  });
}

describe("WebChat automation creation through the tool and Gateway", () => {
  it("previews the retained binding when replaying a declaration after reset", async () => {
    await withWebchatTool(
      async ({ tool, cron, creatorStorePath }) => {
        const create = () =>
          tool.execute("declare-watcher", {
            action: "add",
            job: {
              declarationKey: "conversation-watcher",
              name: "Conversation watcher",
              enabled: false,
              sessionTarget: "isolated",
              schedule: { kind: "every", everyMs: 60_000 },
              payload: { kind: "agentTurn", message: "Reply tick." },
            },
          });
        await create();
        await resetSessionEntryLifecycle({
          storePath: creatorStorePath,
          target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
          buildNextEntry: () => ({
            sessionId: "replacement-conversation",
            lifecycleRevision: "replacement-generation",
            updatedAt: 2,
          }),
        });
        const replayed = await create();
        expect(replayed.details).toMatchObject({
          created: false,
          deliveryPreview: { detail: expect.stringContaining("original session generation") },
        });
        expect(await cron.list({ includeDisabled: true })).toHaveLength(1);
      },
      undefined,
      false,
    );
  });

  it.each([false, true])(
    "previews external delivery or the creating conversation on add and update (channels: %s)",
    async (channelsEnabled) => {
      await withWebchatTool(
        async ({ add, cron, tool }) => {
          const added = await add(
            channelsEnabled
              ? { mode: "announce", channel: "telegram", to: "recipient" }
              : undefined,
            "isolated",
          );
          const [job] = await cron.list({ includeDisabled: true });
          const updated = await tool.execute("edit-delivery", {
            action: "update",
            jobId: expectDefined(job, "created job").id,
            job: { name: "Renamed watcher" },
          });
          for (const result of [added, updated]) {
            expect(
              Value.Errors(expectDefined(tool.outputSchema, "output schema"), result.details),
            ).toEqual([]);
            expect(JSON.stringify(result.details)).not.toContain("will fail-closed");
          }
          expect(updated.details).not.toHaveProperty("deliveryPreview");
          expect(added.details).toMatchObject({
            deliveryPreview: channelsEnabled
              ? {
                  label: "announce -> telegram:recipient",
                  detail:
                    "commits to the destination conversation; sends one external notification",
                }
              : {
                  label: "announce -> creating conversation",
                  detail: "commits to this conversation (no external channel route)",
                },
          });
        },
        undefined,
        channelsEnabled,
      );
    },
  );

  it.each([
    {
      name: "ignores stale external route",
      delivery: { mode: "announce" },
      storedContext: { channel: "discord", to: "channel:stored" },
    },
    {
      name: "explicit external override",
      delivery: { mode: "announce", channel: "telegram", to: "recipient" },
      storedContext: undefined,
    },
  ] satisfies Array<{
    name: string;
    delivery: CronDelivery | undefined;
    storedContext: DeliveryContext | undefined;
  }>)("persists $name delivery", async ({ delivery, storedContext }) => {
    await withWebchatTool(async ({ add, cron }) => {
      await add(delivery);
      const jobs = await cron.list({ includeDisabled: true });
      expect(jobs).toEqual([
        expect.objectContaining({
          sessionTarget: "current",
          sessionKey,
          enabled: false,
          delivery: delivery ?? { mode: "announce" },
          payload: expect.objectContaining({ kind: "agentTurn", toolsAllow: ["read"] }),
          trigger: { script: "return { fire: false };", once: true },
        }),
      ]);
    }, storedContext);
  });

  it.each([
    {
      revoked: false,
      delivery: { mode: "announce", channel: "webchat" },
      error: "delivery.channel must be one of: discord, telegram",
    },
    {
      revoked: true,
      delivery: { mode: "announce" },
      error: "agent runtime authority is no longer active",
    },
  ] satisfies Array<{ revoked: boolean; delivery: CronDelivery; error: string }>)(
    "rejects invalid delivery or revoked authority before persistence: $revoked",
    async ({ revoked, delivery, error }) => {
      await withWebchatTool(async ({ add, cron, revoke }) => {
        if (revoked) {
          revoke();
        }
        await expect(add(delivery)).rejects.toThrow(error);
        expect(await cron.list({ includeDisabled: true })).toEqual([]);
      });
    },
  );
});
