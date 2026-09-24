import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PROTOCOL_VERSION } from "../../../packages/gateway-protocol/src/version.js";
import { createOperationalRunInstanceRef } from "../../agents/admitted-run-context.js";
import { createCronTool } from "../../agents/tools/cron-tool.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
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
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { isRecord } from "../../utils.js";
import {
  normalizeSessionDeliveryState,
  type DeliveryContext,
} from "../../utils/delivery-context.shared.js";
import { createAgentRuntimeApprovalAuthorityValidator } from "../agent-runtime-identity-token.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { cronHandlers } from "./cron.js";
import type { GatewayClient } from "./types.js";

const sessionKey = "agent:main:dashboard:webchat-conversation";
afterEach(() => resetPluginRuntimeStateForTest());

async function withWebchatTool(
  check: (fixture: {
    add: (delivery?: CronDelivery) => Promise<void>;
    cron: CronService;
    revoke: () => void;
  }) => Promise<void>,
  storedContext: DeliveryContext = { channel: "webchat", to: sessionKey },
) {
  await withOpenClawTestState({ layout: "home" }, async (state) => {
    const sessionStorePath = path.join(state.sessionsDir(), "sessions.json");
    const cfg: OpenClawConfig = {
      agents: { entries: { main: { workspace: state.workspaceDir } } },
      session: { store: sessionStorePath },
      channels: { discord: { token: "test-token" }, telegram: { botToken: "test-token" } },
      plugins: { entries: { discord: { enabled: true }, telegram: { enabled: true } } },
    };
    setRuntimeConfigSnapshot(cfg);
    setActivePluginRegistry(
      createTestRegistry(
        ["discord", "telegram"].map((id) => ({
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
          expect(method).toBe("cron.add");
          if (!isRecord(params)) {
            throw new Error("expected cron.add request record");
          }
          const respond = vi.fn();
          await expectDefined(
            cronHandlers["cron.add"],
            "cron.add handler",
          )({
            req: { type: "req", id: "webchat-cron-add", method, params },
            params,
            respond,
            context,
            client,
            isWebchatConnect: () => false,
          });
          const [ok, result, error] = expectDefined(respond.mock.calls[0], "cron.add response");
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
        revoke,
        add: async (delivery) => {
          await tool.execute("webchat-condition-watcher", {
            action: "add",
            job: {
              name: "WebChat condition watcher",
              enabled: false,
              sessionTarget: "current",
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
  it.each([false, true])(
    "persists current-session announce (explicit delivery: %s)",
    async (explicit) => {
      await withWebchatTool(async ({ add, cron }) => {
        await add(explicit ? { mode: "announce" } : undefined);
        expect(await cron.list({ includeDisabled: true })).toEqual([
          expect.objectContaining({
            sessionTarget: "current",
            sessionKey,
            enabled: false,
            delivery: { mode: "announce" },
            payload: expect.objectContaining({ kind: "agentTurn", toolsAllow: ["read"] }),
            trigger: { script: "return { fire: false };", once: true },
          }),
        ]);
      });
    },
  );

  it("does not pin an older stored external route onto a live WebChat job", async () => {
    await withWebchatTool(
      async ({ add, cron }) => {
        await add({ mode: "announce" });
        const [job] = await cron.list({ includeDisabled: true });
        expect(job?.delivery).toEqual({ mode: "announce" });
      },
      { channel: "discord", to: "channel:stored" },
    );
  });

  it.each(["webchat", "not-a-channel"])(
    "rejects an explicit %s channel before persistence",
    async (channel) => {
      await withWebchatTool(async ({ add, cron }) => {
        await expect(add({ mode: "announce", channel })).rejects.toThrow(
          "delivery.channel must be one of: discord, telegram",
        );
        expect(await cron.list({ includeDisabled: true })).toEqual([]);
      });
    },
  );

  it("preserves an explicit configured external delivery override", async () => {
    await withWebchatTool(async ({ add, cron }) => {
      const delivery: CronDelivery = { mode: "announce", channel: "telegram", to: "recipient" };
      await add(delivery);
      const [job] = await cron.list({ includeDisabled: true });
      expect(job?.delivery).toEqual(delivery);
    });
  });

  it("does not persist a route-less announce after creator authority is revoked", async () => {
    await withWebchatTool(async ({ add, cron, revoke }) => {
      revoke();
      await expect(add({ mode: "announce" })).rejects.toThrow(
        "agent runtime authority is no longer active",
      );
      expect(await cron.list({ includeDisabled: true })).toEqual([]);
    });
  });
});
