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
    sessionStorePath: string;
    cronStorePath: string;
    operator: (method: string, params: Record<string, unknown>) => Promise<unknown>;
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
        sessionStorePath,
        cronStorePath: storePath,
        operator: async (method, params) => {
          const respond = await callCron(context, method, params);
          const [ok, result, error] = expectDefined(respond.mock.calls[0], "cron response");
          if (!ok) {
            throw new Error(expectDefined(error, "cron error response").message);
          }
          return result;
        },
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
  it("guides schema-eager reminder retries without silently discarding authored fields", async () => {
    await withWebchatTool(async ({ tool, cron }) => {
      const at = new Date(Date.now() + 3_600_000).toISOString();
      const args = {
        action: "add",
        gatewayUrl: "",
        gatewayToken: "",
        job: {
          name: "basketball-reminder",
          enabled: false,
          schedule: { kind: "at", at, everyMs: 1, anchorMs: 0, expr: "", tz: "", staggerMs: 0 },
          trigger: { script: "return { fire: true };", once: true },
          payload: {
            kind: "systemEvent",
            text: "Reminder: play basketball!",
            message: "",
            model: "",
          },
          delivery: {
            mode: "announce",
            channel: "telegram",
            to: "synthetic-recipient",
            threadId: "",
            failureDestination: { channel: "", to: "", accountId: "", mode: "announce" },
          },
          deleteAfterRun: true,
        },
        patch: { name: "", schedule: { kind: "at", at: "" }, trigger: null },
      };
      await expect(tool.execute("blank-destination", args)).rejects.toThrow(
        "omit delivery.failureDestination if unused, or supply a valid target. No changes were saved. Retry with corrected arguments; do not report success unless the retry succeeds.",
      );
      expect(await cron.list({ includeDisabled: true })).toEqual([]);

      // This main-session reminder needs no separate delivery destination.
      const retry = { ...args, job: { ...args.job, delivery: undefined } };
      await expect(tool.execute("incompatible-trigger", retry)).rejects.toThrow(
        'schedule.kind="at" cannot include trigger. Remove trigger for a one-time reminder, or use a recurring every/cron schedule. No changes were saved. Retry with corrected arguments; do not report success unless the retry succeeds.',
      );
      expect(await cron.list({ includeDisabled: true })).toEqual([]);

      await tool.execute("corrected-reminder", {
        ...retry,
        job: { ...retry.job, trigger: undefined },
      });
      expect(await cron.list({ includeDisabled: true })).toEqual([
        expect.objectContaining({
          name: "basketball-reminder",
          enabled: false,
          schedule: { kind: "at", at },
          sessionTarget: "main",
          payload: { kind: "systemEvent", text: "Reminder: play basketball!" },
          deleteAfterRun: true,
        }),
      ]);
    });
  });

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

describe("internal notification conversation through the tool and Gateway", () => {
  const inboxKey = "agent:main:dashboard:automation-inbox";

  async function addWatcher(tool: ReturnType<typeof createCronTool>, cron: CronService) {
    await tool.execute("inbox-watcher", {
      action: "add",
      job: {
        name: "Inbox watcher",
        enabled: false,
        sessionTarget: "isolated",
        schedule: { kind: "every", everyMs: 60_000 },
        payload: { kind: "agentTurn", message: "Report the condition result." },
      },
    });
    const [job] = await cron.list({ includeDisabled: true });
    return expectDefined(job, "created job");
  }

  it("selects, reads back, rebinds, and clears the destination without moving the source", async () => {
    await withWebchatTool(
      async ({ tool, cron, sessionStorePath, cronStorePath }) => {
        await replaceSessionEntry(
          { agentId: "main", sessionKey: inboxKey, storePath: sessionStorePath },
          { sessionId: "inbox-generation-1", updatedAt: 1 },
        );
        const created = await addWatcher(tool, cron);
        const source = cron.getJob(created.id)?.sourceConversation;
        expect(source).toMatchObject({ sessionKey, sessionId: "webchat-source" });

        const updated = await tool.execute("select-inbox", {
          action: "update",
          jobId: created.id,
          job: { delivery: { mode: "announce", sessionKey: inboxKey } },
        });
        expect(updated.details).toMatchObject({
          delivery: { mode: "announce", sessionKey: inboxKey },
        });
        expect(updated.details).not.toHaveProperty("deliveryConversation");
        const selected = expectDefined(cron.getJob(created.id), "selected job");
        expect(selected.deliveryConversation).toEqual({
          sessionKey: inboxKey,
          sessionId: "inbox-generation-1",
        });
        expect(selected.sourceConversation).toEqual(source);
        expect(selected.sessionTarget).toBe("isolated");
        expect(selected.delivery).toEqual({ mode: "announce", sessionKey: inboxKey });

        // The public key and private generation both survive the SQLite codec and reload.
        const reloaded = createReadService({
          storePath: cronStorePath,
          cronEnabled: false,
          defaultAgentId: "main",
          enqueueSystemEvent: vi.fn(),
          runIsolatedAgentJob: async () => {
            throw new Error("reloaded fixture must not run an agent");
          },
        });
        try {
          await reloaded.list({ includeDisabled: true });
          expect(reloaded.getJob(created.id)).toMatchObject({
            delivery: { mode: "announce", sessionKey: inboxKey },
            deliveryConversation: { sessionKey: inboxKey, sessionId: "inbox-generation-1" },
            sourceConversation: source,
          });
        } finally {
          reloaded.stop();
        }

        // Re-sending the same key after a reset rebinds the current generation.
        await replaceSessionEntry(
          { agentId: "main", sessionKey: inboxKey, storePath: sessionStorePath },
          { sessionId: "inbox-generation-2", updatedAt: 2 },
        );
        await tool.execute("rebind-inbox", {
          action: "update",
          jobId: created.id,
          job: { delivery: { sessionKey: inboxKey } },
        });
        expect(cron.getJob(created.id)?.deliveryConversation).toEqual({
          sessionKey: inboxKey,
          sessionId: "inbox-generation-2",
        });

        const cleared = await tool.execute("clear-inbox", {
          action: "update",
          jobId: created.id,
          job: { delivery: { sessionKey: null } },
        });
        expect(cleared.details).toMatchObject({ delivery: { mode: "announce" } });
        const restored = expectDefined(cron.getJob(created.id), "cleared job");
        expect(restored.delivery).toEqual({ mode: "announce" });
        expect(restored.deliveryConversation).toBeUndefined();
        expect(restored.sourceConversation).toEqual(source);
      },
      undefined,
      false,
    );
  });

  it("keeps a silent job silent while its notices use the selected conversation", async () => {
    await withWebchatTool(
      async ({ tool, cron, sessionStorePath }) => {
        await replaceSessionEntry(
          { agentId: "main", sessionKey: inboxKey, storePath: sessionStorePath },
          { sessionId: "inbox-generation-1", updatedAt: 1 },
        );
        await tool.execute("quiet-watcher", {
          action: "add",
          job: {
            name: "Quiet watcher",
            enabled: false,
            sessionTarget: "isolated",
            schedule: { kind: "every", everyMs: 60_000 },
            payload: { kind: "agentTurn", message: "Check quietly." },
            delivery: { mode: "none", sessionKey: inboxKey },
            failureAlert: { after: 2, cooldownMs: 3_600_000 },
          },
        });
        const [created] = await cron.list({ includeDisabled: true });
        const id = expectDefined(created, "created job").id;
        const binding = { sessionKey: inboxKey, sessionId: "inbox-generation-1" };
        expect(cron.getJob(id)).toMatchObject({
          delivery: { mode: "none", sessionKey: inboxKey },
          deliveryConversation: binding,
          failureAlert: { after: 2, cooldownMs: 3_600_000 },
        });

        const update = (delivery: Record<string, unknown>) =>
          tool.execute("edit-quiet", { action: "update", jobId: id, job: { delivery } });
        // Moving between the supported modes keeps the destination; webhook clears it.
        await update({ mode: "announce" });
        expect(cron.getJob(id)).toMatchObject({
          delivery: { mode: "announce", sessionKey: inboxKey },
          deliveryConversation: binding,
        });
        await update({ mode: "none" });
        expect(cron.getJob(id)).toMatchObject({
          delivery: { mode: "none", sessionKey: inboxKey },
          deliveryConversation: binding,
        });
        await update({ mode: "webhook", to: "https://hooks.example.test/cron" });
        expect(cron.getJob(id)?.delivery).not.toHaveProperty("sessionKey");
        expect(cron.getJob(id)?.deliveryConversation).toBeUndefined();

        await update({ mode: "none", to: null, sessionKey: inboxKey });
        expect(cron.getJob(id)).toMatchObject({
          delivery: { mode: "none", sessionKey: inboxKey },
          deliveryConversation: binding,
        });
        await update({ sessionKey: null });
        expect(cron.getJob(id)?.delivery).toEqual({ mode: "none" });
        expect(cron.getJob(id)?.deliveryConversation).toBeUndefined();
      },
      undefined,
      false,
    );
  });

  it("routes a main-session script job's notices without enabling its results", async () => {
    await withWebchatTool(
      async ({ cron, sessionStorePath, operator }) => {
        await replaceSessionEntry(
          { agentId: "main", sessionKey: inboxKey, storePath: sessionStorePath },
          { sessionId: "inbox-generation-1", updatedAt: 1 },
        );
        const added = (await operator("cron.add", {
          name: "Main script watcher",
          enabled: false,
          agentId: "main",
          sessionTarget: "main",
          wakeMode: "next-heartbeat",
          schedule: { kind: "every", everyMs: 60_000 },
          payload: { kind: "script", script: "return {};" },
          delivery: { mode: "none" },
          failureAlert: { after: 2, cooldownMs: 3_600_000 },
        })) as { id: string };
        const binding = { sessionKey: inboxKey, sessionId: "inbox-generation-1" };
        // Announce would turn on result delivery that main-session jobs do not support.
        await expect(
          operator("cron.update", {
            jobId: added.id,
            patch: { delivery: { sessionKey: inboxKey } },
          }),
        ).rejects.toThrow('use delivery.mode="none" to send only failure and safety notices');
        const selected = (await operator("cron.update", {
          jobId: added.id,
          patch: { delivery: { mode: "none", sessionKey: inboxKey } },
        })) as Record<string, unknown>;
        expect(selected).toMatchObject({ delivery: { mode: "none", sessionKey: inboxKey } });
        expect(selected).not.toHaveProperty("deliveryConversation");
        await operator("cron.update", { jobId: added.id, patch: { name: "Renamed watcher" } });
        expect(cron.getJob(added.id)).toMatchObject({
          delivery: { mode: "none", sessionKey: inboxKey },
          deliveryConversation: binding,
          failureAlert: { after: 2, cooldownMs: 3_600_000 },
        });
        await operator("cron.update", {
          jobId: added.id,
          patch: { delivery: { sessionKey: null } },
        });
        expect(cron.getJob(added.id)?.delivery).toBeUndefined();
        expect(cron.getJob(added.id)?.deliveryConversation).toBeUndefined();
      },
      undefined,
      false,
    );
  });

  it.each([
    {
      name: "a missing conversation",
      delivery: { mode: "announce", sessionKey: "agent:main:dashboard:missing" },
      error: "delivery.sessionKey conversation agent:main:dashboard:missing was not found",
    },
    {
      name: "another agent's conversation",
      delivery: { mode: "announce", sessionKey: "agent:other:dashboard:inbox" },
      error: "session target outside caller scope",
    },
    {
      name: "an explicit external target",
      delivery: { mode: "announce", sessionKey: inboxKey, channel: "telegram", to: "recipient" },
      error: "delivery.sessionKey cannot be combined with",
    },
    {
      name: "webhook delivery",
      delivery: { mode: "webhook", to: "https://hooks.example.test/cron", sessionKey: inboxKey },
      error: 'delivery.sessionKey requires delivery.mode="announce" or "none"',
    },
  ])("rejects $name before persistence", async ({ delivery, error }) => {
    await withWebchatTool(async ({ tool, cron, sessionStorePath }) => {
      await replaceSessionEntry(
        { agentId: "main", sessionKey: inboxKey, storePath: sessionStorePath },
        { sessionId: "inbox-generation-1", updatedAt: 1 },
      );
      const created = await addWatcher(tool, cron);
      const before = cron.getJob(created.id);
      await expect(
        tool.execute("reject-inbox", {
          action: "update",
          jobId: created.id,
          job: { delivery },
        }),
      ).rejects.toThrow(error);
      expect(cron.getJob(created.id)).toEqual(before);
    });
  });
});
