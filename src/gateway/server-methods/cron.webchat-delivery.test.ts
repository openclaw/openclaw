import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCronTool } from "../../agents/tools/cron-tool.js";
import * as gatewayModule from "../../agents/tools/gateway.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { CronService } from "../../cron/service.js";
import type { CronDelivery } from "../../cron/types.js";
import { releaseAgentRunDelegatedAuthority } from "../../infra/agent-run-registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createDirectOutboundTestAdapter,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { isRecord } from "../../utils.js";
import {
  normalizeSessionDeliveryState,
  type DeliveryContext,
} from "../../utils/delivery-context.shared.js";
import { createAgentRuntimeApprovalAuthorityValidator } from "../agent-runtime-approval-authority.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { callCron, createReadService } from "./cron-read.test-support.js";
import { createCronCallerClient } from "./cron.validation.test-support.js";

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
  }) => Promise<void>,
  storedContext: DeliveryContext = { channel: "webchat", to: sessionKey },
  channelsEnabled = true,
) {
  await withOpenClawTestState({ layout: "home" }, async (state) => {
    const sessionStorePath = path.join(state.sessionsDir(), "sessions.json");
    const cfg: OpenClawConfig = {
      agents: {
        entries: { main: { workspace: state.workspaceDir } },
        defaults: { model: "openai/gpt-4.1" },
      },
      session: { store: sessionStorePath },
      channels: channelsEnabled
        ? { discord: { token: "test-token" }, telegram: { botToken: "test-token" } }
        : {},
      plugins: { entries: { discord: { enabled: true }, telegram: { enabled: true } } },
    };
    await state.writeAuthProfiles({
      version: 1,
      profiles: {
        "openai:webchat-fixture": {
          type: "api_key",
          provider: "openai",
          key: "synthetic-webchat-inference-key",
        },
      },
    });
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
    const cron = createReadService({
      storePath,
      cronEnabled: false,
      defaultAgentId: "main",
      enqueueSystemEvent: vi.fn(),
      runIsolatedAgentJob: async () => {
        throw new Error("disabled fixture must not run an agent");
      },
    });
    const client = createCronCallerClient("main", undefined, sessionKey);
    const revoke = () => {
      const authority = client.internal?.agentRuntimeIdentity?.delegatedAuthority;
      if (authority?.kind === "local") {
        releaseAgentRunDelegatedAuthority(authority);
      }
    };
    const context = createDirectChatContext({
      cron,
      cronStorePath: storePath,
      getRuntimeConfig: () => cfg,
      validateAgentRuntimeApprovalAuthority: createAgentRuntimeApprovalAuthorityValidator(),
    });
    const gatewaySpy = vi
      .spyOn(gatewayModule, "callGatewayTool")
      .mockImplementation(async (method, _opts, params) => {
        expect(["cron.add", "cron.update", "cron.get"]).toContain(method);
        if (!isRecord(params)) {
          throw new Error("expected cron request record");
        }
        const respond = await callCron(context, method, params, { client });
        const [ok, result, error] = expectDefined(respond.mock.calls[0], "cron response");
        if (!ok) {
          throw new Error(expectDefined(error, "cron error response").message);
        }
        return result;
      });
    try {
      const tool = createCronTool({
        config: cfg,
        agentSessionKey: sessionKey,
        currentDeliveryContext: {
          channel: "webchat",
          to: sessionKey,
          accountId: "internal-account",
          threadId: "internal-thread",
        },
        creatorToolAllowlist: ["read"],
      });
      await check({
        cron,
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
      gatewaySpy.mockRestore();
      revoke();
      cron.stop();
    }
  });
}

describe("WebChat automation creation through the tool and Gateway", () => {
  it("previews the creating conversation on add, but not a name-only update", async () => {
    await withWebchatTool(
      async ({ add, cron, tool }) => {
        const added = await add(undefined, "isolated");
        const [job] = await cron.list({ includeDisabled: true });
        const updated = await tool.execute("edit-delivery", {
          action: "update",
          jobId: expectDefined(job, "created job").id,
          job: { name: "Renamed watcher" },
        });
        expect(updated.details).not.toHaveProperty("deliveryPreview");
        expect(added.details).toMatchObject({
          deliveryPreview: {
            label: "announce -> creating conversation",
            detail: "commits to this conversation (no external channel route)",
          },
        });
      },
      undefined,
      false,
    );
  });

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
      const added = await add(delivery);
      if (delivery?.channel === "telegram") {
        expect(added.details).toMatchObject({
          deliveryPreview: {
            label: "announce -> telegram:recipient",
            detail: "commits to the destination conversation; sends one external notification",
          },
        });
      }
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
