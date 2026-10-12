// Covers exec approval forwarding to channel plugins.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { ChannelPlugin } from "../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../config/config.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import {
  baseRequest,
  type NativeRouteFixture,
  emptyRegistry,
  flushPendingDelivery,
  telegramApprovalPlugin,
  discordApprovalPlugin,
  defaultRegistry,
  getFirstDeliveryText,
  requireRecord,
  requireFirstCallArg,
  requireFirstPayload,
  makeTargetsCfg,
  TARGETS_CFG,
  createForwarder,
  stopForwarderFixtures,
} from "./exec-approval-forwarder.test-support.js";
import type { ExecApprovalRequest } from "./exec-approvals.js";

const { mockLogError } = vi.hoisted(() => ({ mockLogError: vi.fn() }));
vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    subsystem: "gateway/exec-approvals",
    isEnabled: () => false,
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: mockLogError,
    fatal: vi.fn(),
    raw: vi.fn(),
    child: vi.fn(),
  }),
}));

afterEach(async () => {
  await stopForwarderFixtures();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function makeSessionCfg(options: { discordExecApprovalsEnabled?: boolean } = {}): OpenClawConfig {
  return {
    ...(options.discordExecApprovalsEnabled
      ? {
          channels: {
            discord: {
              execApprovals: {
                enabled: true,
                approvers: ["123"],
              },
            },
          },
        }
      : {}),
    approvals: { exec: { enabled: true, mode: "session" } },
  } as OpenClawConfig;
}

describe("exec approval forwarder", () => {
  beforeEach(() => {
    setActivePluginRegistry(defaultRegistry);
  });

  afterEach(() => {
    setActivePluginRegistry(emptyRegistry);
  });

  it("forwards to session target and resolves", async () => {
    vi.useFakeTimers();
    const cfg = {
      approvals: { exec: { enabled: true, mode: "session" } },
    } as OpenClawConfig;

    const { deliver, forwarder } = createForwarder({
      cfg,
      resolveSessionTarget: () => ({ channel: "slack", to: "U1" }),
    });

    await expect(forwarder.handleRequested(baseRequest)).resolves.toBe(true);
    expect(deliver).toHaveBeenCalledTimes(1);

    await forwarder.handleResolved({
      id: baseRequest.id,
      decision: "allow-once",
      resolvedBy: "slack:U1",
      ts: 2000,
    });
    expect(deliver).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(baseRequest.expiresAtMs - baseRequest.createdAtMs);
    expect(deliver).toHaveBeenCalledTimes(2);
  });

  it("joins started delivery and its queued real resolution while stopping future expiry", async () => {
    vi.useFakeTimers();
    const pendingDelivery = createDeferred();
    const resolvedDelivery = createDeferred();
    const resolvedEntered = createDeferred();
    const deliveryOrder: string[] = [];
    const deliver = vi.fn(async (params: { payloads?: Array<{ text?: string }> }) => {
      const kind = params.payloads?.[0]?.text?.includes("required") ? "pending" : "resolved";
      deliveryOrder.push(kind);
      if (kind === "pending") {
        await pendingDelivery.promise;
      } else {
        resolvedEntered.resolve();
        await resolvedDelivery.promise;
      }
      return [];
    });
    const { forwarder } = createForwarder({ cfg: TARGETS_CFG, deliver });
    let stopping: Promise<void> | undefined;
    let stopped = false;
    try {
      await expect(forwarder.handleRequested(baseRequest)).resolves.toBe(true);
      await forwarder.handleResolved({
        id: baseRequest.id,
        decision: "allow-once",
        resolvedBy: "reviewer",
        ts: 2000,
      });
      stopping = forwarder.stop().then(() => {
        stopped = true;
      });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(stopped).toBe(false);
      expect(deliveryOrder).toEqual(["pending"]);
      pendingDelivery.resolve();
      await resolvedEntered.promise;
      expect(stopped).toBe(false);
      resolvedDelivery.resolve();
      await stopping;
      expect(deliveryOrder).toEqual(["pending", "resolved"]);
      await expect(forwarder.handleRequested({ ...baseRequest, id: "late" })).resolves.toBe(false);
      await forwarder.handleResolved({
        id: "late",
        decision: "deny",
        resolvedBy: "reviewer",
        ts: 3000,
        request: baseRequest.request,
      });
      expect(deliveryOrder).toEqual(["pending", "resolved"]);
    } finally {
      pendingDelivery.resolve();
      resolvedDelivery.resolve();
      await (stopping ?? forwarder.stop());
    }
  });

  it.each(["resolution", "expiry"] as const)(
    "keeps pending delivery ahead of %s",
    async (terminal) => {
      vi.useFakeTimers();
      const lookupEntered = createDeferred();
      const target = createDeferred<{ channel: "slack"; to: string }>();
      const pendingDelivery = createDeferred();
      const deliveryOrder: string[] = [];
      const deliver = vi.fn(async (params: { payloads?: Array<{ text?: string }> }) => {
        const kind = params.payloads?.[0]?.text?.includes("required") ? "pending" : terminal;
        deliveryOrder.push(kind);
        if (kind === "pending") {
          await pendingDelivery.promise;
        }
        return [];
      });
      const resolveSessionTarget = vi.fn(() => {
        lookupEntered.resolve();
        return target.promise;
      });
      const { forwarder } = createForwarder({
        cfg: makeSessionCfg(),
        deliver,
        resolveSessionTarget,
      });
      const requested = forwarder.handleRequested(baseRequest);
      try {
        await lookupEntered.promise;
        if (terminal === "resolution") {
          await forwarder.handleResolved({
            id: baseRequest.id,
            decision: "allow-once",
            resolvedBy: "slack:U1",
            ts: 2000,
          });
        }
        target.resolve({ channel: "slack", to: "U1" });
        await expect(requested).resolves.toBe(true);
        expect(deliver).toHaveBeenCalledTimes(1);
        expect(deliveryOrder).toEqual(["pending"]);
        if (terminal === "expiry") {
          await vi.advanceTimersByTimeAsync(baseRequest.expiresAtMs - 1000);
          expect(deliveryOrder).toEqual(["pending"]);
        }
        pendingDelivery.resolve();
        await forwarder.stop();
        expect(deliver).toHaveBeenCalledTimes(2);
        expect(deliveryOrder).toEqual(["pending", terminal]);
        expect(resolveSessionTarget).toHaveBeenCalledOnce();
      } finally {
        target.resolve({ channel: "slack", to: "U1" });
        pendingDelivery.resolve();
        await requested.catch(() => {});
        await forwarder.stop();
      }
    },
  );

  it("does not arm new expiry while an admitted route lookup finishes during stop", async () => {
    vi.useFakeTimers();
    const lookupEntered = createDeferred();
    const target = createDeferred<{ channel: "slack"; to: string }>();
    const delivery = createDeferred();
    const sent: string[] = [];
    const { forwarder } = createForwarder({
      cfg: makeSessionCfg(),
      resolveSessionTarget: () => {
        lookupEntered.resolve();
        return target.promise;
      },
      deliver: vi.fn(async (params: { payloads?: Array<{ text?: string }> }) => {
        sent.push(params.payloads?.[0]?.text ?? "");
        await delivery.promise;
        return [];
      }),
    });
    const requested = forwarder.handleRequested(baseRequest);
    let stopping: Promise<void> | undefined;
    try {
      await lookupEntered.promise;
      stopping = forwarder.stop();
      target.resolve({ channel: "slack", to: "U1" });
      await expect(requested).resolves.toBe(true);
      await vi.advanceTimersByTimeAsync(10_000);
      delivery.resolve();
      await stopping;
      expect(sent).toHaveLength(1);
      expect(sent[0]).toContain("required");
    } finally {
      target.resolve({ channel: "slack", to: "U1" });
      delivery.resolve();
      await requested.catch(() => {});
      await (stopping ?? forwarder.stop());
    }
  });

  it("deduplicates session and explicit approval targets through normalized route identity", async () => {
    vi.useFakeTimers();
    const cfg = {
      approvals: {
        exec: {
          enabled: true,
          mode: "both",
          targets: [{ channel: "telegram", to: "-100999", accountId: "bot", threadId: "77" }],
        },
      },
    } as OpenClawConfig;

    const { deliver, forwarder } = createForwarder({
      cfg,
      resolveSessionTarget: () => ({
        channel: "telegram",
        to: "-100999",
        accountId: "bot",
        threadId: 77,
      }),
    });

    await expect(forwarder.handleRequested(baseRequest)).resolves.toBe(true);
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it("calls outbound beforeDeliverPayload before exec approval delivery", async () => {
    const beforeDeliverPayload = vi.fn();
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "telegram",
          plugin: telegramApprovalPlugin,
          source: "test",
        },
        {
          pluginId: "discord",
          plugin: discordApprovalPlugin,
          source: "test",
        },
        {
          pluginId: "slack",
          plugin: {
            ...createChannelTestPluginBase({ id: "slack" as ChannelPlugin["id"] }),
            outbound: {
              deliveryMode: "direct",
              beforeDeliverPayload,
            },
          } satisfies Pick<ChannelPlugin, "id" | "meta" | "capabilities" | "config" | "outbound">,
          source: "test",
        },
      ]),
    );

    const { deliver, forwarder } = createForwarder({ cfg: TARGETS_CFG });
    await expect(forwarder.handleRequested(baseRequest)).resolves.toBe(true);
    await flushPendingDelivery();
    expect(deliver).toHaveBeenCalled();
    const hookParams = requireFirstCallArg(beforeDeliverPayload, "beforeDeliverPayload params");
    expect(hookParams.hint).toEqual({ kind: "approval-pending", approvalKind: "exec" });
    const target = requireRecord(hookParams.target, "delivery target");
    expect(target.channel).toBe("slack");
    expect(target.to).toBe("U123");
  });

  describe("telegram session target with native exec approvals configured", () => {
    const cfg = {
      approvals: { exec: { enabled: true, mode: "session" } },
      channels: {
        telegram: { execApprovals: { enabled: true, approvers: ["123"], target: "channel" } },
      },
    } as OpenClawConfig;
    const telegramRequest = {
      ...baseRequest,
      request: {
        ...baseRequest.request,
        turnSourceChannel: "telegram",
        turnSourceTo: "-100999",
        turnSourceThreadId: "77",
        turnSourceAccountId: "default",
      },
    };
    const resolveSessionTarget = () => ({ channel: "telegram", to: "-100999", threadId: 77 });

    it.each([
      { name: "no native handler is running", nativeRoutes: [] },
      {
        name: "only another account's native handler is running",
        nativeRoutes: [{ channel: "telegram", accountId: "ops" }],
      },
      {
        name: "only another channel's native handler is running",
        nativeRoutes: [{ channel: "discord", accountId: "default" }],
      },
    ])("forwards the text prompt when $name", async ({ nativeRoutes }) => {
      vi.useFakeTimers();
      const { deliver, forwarder } = createForwarder({ cfg, resolveSessionTarget, nativeRoutes });

      await expect(forwarder.handleRequested(telegramRequest)).resolves.toBe(true);
      expect(requireFirstCallArg(deliver, "delivery params")).toMatchObject({ to: "-100999" });
    });

    it("skips forwarding while the native handler runs and forwards again once it stops", async () => {
      vi.useFakeTimers();
      const { deliver, forwarder, nativeRoutes } = createForwarder({
        cfg,
        resolveSessionTarget,
        nativeRoutes: [{ channel: "telegram", accountId: "default" }],
      });
      await expect(forwarder.handleRequested(telegramRequest)).resolves.toBe(false);
      expect(deliver).not.toHaveBeenCalled();

      await Promise.all(nativeRoutes.map((route) => route.stop()));

      await expect(
        forwarder.handleRequested({ ...telegramRequest, id: "req-after-stop" }),
      ).resolves.toBe(true);
      expect(deliver).toHaveBeenCalledTimes(1);
    });

    it.each<{ nativeRoutes: NativeRouteFixture[]; forwarded: boolean }>([
      { nativeRoutes: [], forwarded: true },
      { nativeRoutes: [{ channel: "telegram", accountId: "default" }], forwarded: false },
      {
        nativeRoutes: [{ channel: "telegram", accountId: "default", handledKinds: ["exec"] }],
        forwarded: true,
      },
    ])(
      "gates plugin approvals on the running native handler %j",
      async ({ nativeRoutes, forwarded }) => {
        vi.useFakeTimers();
        const { deliver, forwarder } = createForwarder({
          cfg: { ...cfg, approvals: { plugin: { enabled: true, mode: "session" } } },
          resolveSessionTarget,
          nativeRoutes,
        });

        await expect(
          forwarder.handlePluginApprovalRequested?.({
            ...telegramRequest,
            id: "plugin:req-1",
            request: {
              title: "Demo",
              description: "Demo approval",
              turnSourceChannel: "telegram",
              turnSourceTo: "-100999",
              turnSourceAccountId: "default",
            },
          }),
        ).resolves.toBe(forwarded);
        expect(deliver).toHaveBeenCalledTimes(forwarded ? 1 : 0);
      },
    );

    describe("OpenClaw change approvals", () => {
      // No approvals.* forwarding config: the requesting chat is the reply path.
      const unconfigured = {
        channels: {
          telegram: { execApprovals: { enabled: true, approvers: ["123"], target: "channel" } },
        },
      } as OpenClawConfig;
      const systemAgentRequest = {
        id: "system-agent:req-1",
        request: {
          title: "OpenClaw change",
          description: "set agents.defaults.memorySearch.provider to openai",
          command: "set agents.defaults.memorySearch.provider to openai",
          proposalHash: "hash-1",
          allowedDecisions: ["allow-once", "deny"] as const,
          sessionId: "delegated-1",
          agentId: "main",
          turnSourceChannel: "telegram",
          turnSourceTo: "-100999",
          turnSourceAccountId: "default",
        },
        createdAtMs: 1000,
        expiresAtMs: 601_000,
      };

      it.each(["applied", "expired"] as const)(
        "reports the Gateway's %s terminal once after the deadline",
        async (terminal) => {
          vi.useFakeTimers();
          const texts: string[] = [];
          const deliver = vi.fn(async (params: { payloads: Array<{ text?: string }> }) => {
            texts.push(params.payloads[0]?.text ?? "");
            return [];
          });
          const { forwarder } = createForwarder({
            cfg: unconfigured,
            resolveSessionTarget,
            deliver,
          });
          await expect(
            forwarder.handleSystemAgentApprovalRequested?.(systemAgentRequest),
          ).resolves.toBe(true);
          expect(requireFirstCallArg(deliver, "delivery params")).toMatchObject({ to: "-100999" });
          const text = getFirstDeliveryText(deliver);
          expect(text).toContain("set agents.defaults.memorySearch.provider to openai");
          expect(text).toContain("/approve system-agent:req-1 allow-once|deny");
          await vi.advanceTimersByTimeAsync(systemAgentRequest.expiresAtMs);
          const resolved = {
            id: systemAgentRequest.id,
            decision: terminal === "applied" ? ("allow-once" as const) : ("deny" as const),
            ts: systemAgentRequest.expiresAtMs + (terminal === "applied" ? 1 : 0),
            request: systemAgentRequest.request,
            applicationStatus: terminal === "applied" ? ("applied" as const) : undefined,
            terminalStatus: terminal === "expired" ? ("expired" as const) : undefined,
          };
          await forwarder.handleSystemAgentApprovalResolved?.(resolved);
          if (terminal === "expired") {
            await forwarder.handleSystemAgentApprovalResolved?.(resolved);
          }
          expect(deliver).toHaveBeenCalledTimes(2);
          expect(texts.filter((entry) => /expired/i.test(entry))).toHaveLength(
            terminal === "expired" ? 1 : 0,
          );
          if (terminal === "applied") {
            expect(texts.filter((entry) => entry.includes("approved and applied"))).toHaveLength(1);
            expect(deliver).toHaveBeenLastCalledWith(
              expect.objectContaining({
                payloads: [
                  expect.objectContaining({
                    text: expect.stringContaining("approved and applied"),
                  }),
                ],
              }),
            );
          }
        },
      );

      it.each(["native", "terminal", "webchat"] as const)(
        "does not forward a %s-owned change request",
        async (origin) => {
          vi.useFakeTimers();
          const { deliver, forwarder } = createForwarder({
            cfg: unconfigured,
            resolveSessionTarget,
            nativeRoutes:
              origin === "native" ? [{ channel: "telegram", accountId: "default" }] : [],
          });
          await expect(
            forwarder.handleSystemAgentApprovalRequested?.({
              ...systemAgentRequest,
              request: {
                ...systemAgentRequest.request,
                turnSourceChannel:
                  origin === "native" ? "telegram" : origin === "webchat" ? "webchat" : undefined,
                turnSourceTo: origin === "native" ? "-100999" : undefined,
              },
            }),
          ).resolves.toBe(false);
          expect(deliver).not.toHaveBeenCalled();
        },
      );
    });
  });

  it.each(["webchat", "tui"])(
    "preserves configured session fallback for %s-originated exec approvals",
    async (turnSourceChannel) => {
      const resolveSessionTarget = vi.fn(async ({ request }) =>
        request.request.turnSourceChannel
          ? null
          : { channel: "telegram" as const, to: "123", accountId: "default" },
      );
      const cfg = {
        approvals: { exec: { enabled: true, mode: "session" } },
      } as OpenClawConfig;
      const { deliver, forwarder } = createForwarder({ cfg, resolveSessionTarget });

      await expect(
        forwarder.handleRequested({
          ...baseRequest,
          request: {
            ...baseRequest.request,
            turnSourceChannel,
          },
        }),
      ).resolves.toBe(true);
      expect(resolveSessionTarget).toHaveBeenCalledWith(
        expect.objectContaining({
          request: expect.objectContaining({
            request: expect.objectContaining({ turnSourceChannel: null }),
          }),
        }),
      );
      expect(deliver).toHaveBeenCalledTimes(1);
    },
  );

  it("attaches shared presentation approval buttons in forwarded fallback payloads", async () => {
    vi.useFakeTimers();
    const { deliver, forwarder } = createForwarder({
      cfg: makeTargetsCfg([{ channel: "telegram", to: "123" }]),
    });

    await expect(
      forwarder.handleRequested({
        ...baseRequest,
        request: {
          ...baseRequest.request,
          turnSourceChannel: "discord",
          turnSourceTo: "channel:123",
        },
      }),
    ).resolves.toBe(true);

    expect(deliver).toHaveBeenCalledTimes(1);
    const delivery = requireFirstCallArg(deliver, "delivery params");
    expect(delivery.channel).toBe("telegram");
    expect(delivery.to).toBe("123");
    const payload = requireFirstPayload(deliver);
    expect(payload.channelData?.execApproval).toEqual({ approvalId: "req-1" });
    expect(payload.presentation).toEqual({
      blocks: [
        {
          type: "buttons",
          buttons: [
            {
              label: "Allow Once",
              value: "/approve req-1 allow-once",
              style: "success",
            },
            {
              label: "Allow Always",
              value: "/approve req-1 allow-always",
              style: "primary",
            },
            {
              label: "Deny",
              value: "/approve req-1 deny",
              style: "danger",
            },
          ],
        },
      ],
    });
    expect(payload.interactive).toBeUndefined();
  });

  it.each<{ request: Partial<ExecApprovalRequest["request"]>; expectedText: string }>([
    { request: {}, expectedText: "Command: `echo hello`" },
    { request: { ask: "always" }, expectedText: "Reply with: /approve req-1 allow-once|deny" },
    {
      request: { command: "bash safe\u200B.sh" },
      expectedText: "Command: `bash safe\\u{200B}.sh`",
    },
    {
      request: { command: "echo `uname`\necho done" },
      expectedText: "```\necho `uname`\\u{A}echo done\n```",
    },
    { request: { command: "echo ```danger```" }, expectedText: "````\necho ```danger```\n````" },
  ])(
    "forwards exec metadata and policy-aware command text for $request",
    async ({ request, expectedText }) => {
      vi.useFakeTimers();
      const { deliver, forwarder } = createForwarder({ cfg: TARGETS_CFG });
      await expect(
        forwarder.handleRequested({
          ...baseRequest,
          request: { ...baseRequest.request, ...request },
        }),
      ).resolves.toBe(true);
      await Promise.resolve();
      expect(deliver).toHaveBeenCalledTimes(1);
      const execApproval = requireRecord(
        requireFirstPayload(deliver).channelData?.execApproval,
        "exec approval metadata",
      );
      expect(execApproval).toMatchObject({
        approvalId: "req-1",
        approvalKind: "exec",
        agentId: "main",
        sessionKey: "agent:main:main",
      });
      const text = getFirstDeliveryText(deliver);
      expect(text).toContain(expectedText);
      expect(text).toContain("🔒 Exec approval required");
      expect(text).toContain("Expires in: 5s");
      if (request.ask === "always") {
        expect(text).not.toContain("allow-once|allow-always|deny");
        expect(text).toContain("Allow Always is unavailable");
      } else {
        expect(text).toContain("Reply with: /approve req-1 allow-once|allow-always|deny");
      }
    },
  );

  it.each([
    {
      enabled: false,
      sessionFilter: undefined,
      sessionKey: baseRequest.request.sessionKey,
      accepted: false,
    },
    { enabled: true, sessionFilter: ["(a+)+$"], sessionKey: `${"a".repeat(28)}!`, accepted: false },
    {
      enabled: true,
      sessionFilter: ["discord:tail$"],
      sessionKey: `${"x".repeat(5000)}discord:tail`,
      accepted: true,
    },
  ])(
    "applies forwarding configuration and session filters for %j",
    async ({ enabled, sessionFilter, sessionKey, accepted }) => {
      const { deliver, forwarder } = createForwarder({
        cfg: enabled ? { approvals: { exec: { enabled, mode: "session", sessionFilter } } } : {},
        resolveSessionTarget: () => ({ channel: "slack", to: "U1" }),
      });
      await expect(
        forwarder.handleRequested({
          ...baseRequest,
          request: { ...baseRequest.request, sessionKey },
        }),
      ).resolves.toBe(accepted);
      expect(deliver).toHaveBeenCalledTimes(accepted ? 1 : 0);
    },
  );

  it.each(["disabled", "session", "cross-channel"] as const)(
    "checks the default native account for %s forwarding",
    async (mode) => {
      vi.useFakeTimers();
      const enabled = mode !== "disabled";
      const cfg: OpenClawConfig = {
        ...makeSessionCfg({ discordExecApprovalsEnabled: enabled }),
        ...(mode === "cross-channel"
          ? makeTargetsCfg([{ channel: "discord", to: "channel:123" }])
          : {}),
      };
      const { deliver, forwarder } = createForwarder({
        cfg,
        resolveSessionTarget: () => ({ channel: "discord", to: "channel:123" }),
        nativeRoutes: (mode === "cross-channel" ? ["default", "ops"] : ["default"]).map(
          (accountId) => ({ channel: "discord", accountId }),
        ),
      });
      await expect(
        forwarder.handleRequested({
          ...baseRequest,
          request: {
            ...baseRequest.request,
            ...(mode === "cross-channel"
              ? { turnSourceChannel: "telegram", turnSourceAccountId: "work" }
              : {}),
          },
        }),
      ).resolves.toBe(!enabled);
      expect(deliver).toHaveBeenCalledTimes(enabled ? 0 : 1);
    },
  );

  it("can forward resolved notices without pending cache when request payload is present", async () => {
    const { deliver, forwarder } = createForwarder({
      cfg: makeTargetsCfg([{ channel: "telegram", to: "123" }]),
    });

    await forwarder.handleResolved({
      id: "req-missing",
      decision: "allow-once",
      resolvedBy: "telegram:123",
      ts: 2000,
      request: {
        command: "echo ok",
        agentId: "main",
        sessionKey: "agent:main:main",
      },
    });

    expect(deliver).toHaveBeenCalledTimes(1);
  });

  describe("expiry delivery error handling (#83106)", () => {
    afterEach(() => {
      mockLogError.mockClear();
    });

    it("logs per-target error when expiry delivery fails without producing unhandled rejection", async () => {
      vi.useFakeTimers();
      const deliver = vi.fn().mockResolvedValue([]);
      const { forwarder } = createForwarder({ cfg: TARGETS_CFG, deliver });

      await expect(forwarder.handleRequested(baseRequest)).resolves.toBe(true);
      await flushPendingDelivery();

      // Make the expiry delivery throw — deliverToTargets catches this
      // per-target and logs it, preventing an unhandled rejection.
      deliver.mockRejectedValue(new Error("channel delivery crashed"));

      // Trigger expiry
      await vi.advanceTimersByTimeAsync(baseRequest.expiresAtMs - 1000);
      await flushPendingDelivery();

      // deliverToTargets catches per-target errors and logs them
      expect(mockLogError).toHaveBeenCalledWith(expect.stringContaining("failed to deliver"));
      expect(mockLogError).toHaveBeenCalledWith(
        expect.stringContaining("channel delivery crashed"),
      );
    });

    it("deletes pending entry before starting expiry delivery", async () => {
      vi.useFakeTimers();
      let pendingDeletedDuringDelivery = false;

      const deliver = vi
        .fn()
        .mockImplementation(async (deliveryParams: { payloads?: Array<{ text?: string }> }) => {
          const text = deliveryParams.payloads?.[0]?.text ?? "";
          if (text.includes("expired")) {
            // During expiry delivery, try to resolve the same request.
            // If pending.delete happened before delivery, handleResolved
            // will not find the entry and will not deliver a resolved notice.
            await forwarder.handleResolved({
              id: baseRequest.id,
              decision: "allow-once",
              resolvedBy: "slack:U123",
              ts: 7000,
            });
            // handleResolved returns void, but if it tried to deliver,
            // deliver would be called again. We track that below.
            pendingDeletedDuringDelivery = true;
          }
          return [];
        });

      const { forwarder } = createForwarder({ cfg: TARGETS_CFG, deliver });
      await expect(forwarder.handleRequested(baseRequest)).resolves.toBe(true);
      await flushPendingDelivery();
      deliver.mockClear();

      // Trigger expiry
      await vi.advanceTimersByTimeAsync(baseRequest.expiresAtMs - 1000);
      for (let i = 0; i < 5; i += 1) {
        await flushPendingDelivery();
      }

      expect(pendingDeletedDuringDelivery).toBe(true);
      // Only 1 delivery call (the expiry notification itself).
      // handleResolved during delivery found no pending entry because
      // pending.delete ran before deliverToTargets, so no resolved notice.
      expect(deliver).toHaveBeenCalledTimes(1);
    });
  });
});
