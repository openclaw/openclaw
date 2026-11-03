import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestAdmittedRunContext } from "../../agents/admitted-run-context.test-support.js";
import {
  createCronCreatorAuthorityCapability,
  runWithCronCreatorAuthorityCapability,
} from "../../agents/cron-creator-authority-context.js";
import { createCronTool } from "../../agents/tools/cron-tool.js";
import {
  getGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../../agents/tools/gateway-caller-context.js";
import { withAdminIngress } from "../../channels/message-access/operator-authority.test-support.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/config.js";
import type { AgentRuntimeIdentity } from "../../gateway/agent-runtime-identity-token.js";
import {
  getCronManagementAuthority,
  getCronManagementChannelRequester,
  withCronManagementGrant,
} from "../../gateway/cron-creator-authority-grant.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import { bindCommandOwnerAuthority, getCommandOwnerAuthority } from "../command-owner-authority.js";
import type { AgentTurnParams } from "./agent-runner-execution.types.js";
import { runReplyAgent } from "./agent-runner.runtime.js";
import {
  createFollowupTurnTestTurn,
  createFollowupTurnTestTypingController,
  executeFollowupTurnForTest,
  getFollowupTurnTestState,
  resetFollowupTurnTestState,
} from "./followup-turn-execution.test-support.js";
import type { runPreparedReply } from "./get-reply-run.js";
import { registerQueuedCronFinalEffectCases } from "./get-reply-run.queued-cron-final-effect.test-support.js";
import { createInboundBody, createSessionBody, ownerParams } from "./get-reply-run.test-support.js";
import { collectQueuedInputs } from "./queue.collection.test-support.js";
import { resolveFollowupAbortSignal, type FollowupRun } from "./queue/types.js";

type OwnerFixture = Parameters<Parameters<typeof withAdminIngress>[0]>[0];
type Turn = ReturnType<typeof createFollowupTurnTestTurn>;
export function registerQueuedCronAuthorityCases(harness: {
  runPrepared: (
    overrides?: Partial<Parameters<typeof runPreparedReply>[0]>,
  ) => ReturnType<typeof runPreparedReply>;
}) {
  const state = getFollowupTurnTestState();
  beforeEach(resetFollowupTurnTestState);
  registerQueuedCronFinalEffectCases({ captureSource, execute, collectQueuedInputs });

  type SourceOptions = Partial<Parameters<typeof runPreparedReply>[0]>;
  type OwnerContext = Awaited<ReturnType<OwnerFixture["context"]>>;

  async function captureSource(
    context: OwnerContext,
    cfg: OwnerFixture["cfg"],
    overrides: SourceOptions = {},
  ) {
    const prepared = ownerParams();
    let queued: FollowupRun | undefined;
    let ingressScope: NonNullable<AgentTurnParams["opts"]>["cronCreatorAuthorityCapability"];
    vi.mocked(runReplyAgent).mockImplementationOnce(async ({ followupRun, opts }) => {
      queued = followupRun;
      ingressScope = opts?.cronCreatorAuthorityCapability;
      return undefined;
    });
    await harness.runPrepared({
      ...prepared,
      cfg,
      conversation: undefined,
      command: { ...prepared.command, senderId: context.SenderId, senderIsOwner: true },
      ctx: {
        ...context,
        MessageThreadId: "same-thread",
        ...createInboundBody("list all automations"),
      },
      sessionCtx: {
        ...context,
        MessageThreadId: "same-thread",
        ...createSessionBody("list all automations"),
      },
      opts: { runId: "original-ingress-" + crypto.randomUUID() },
      ...overrides,
    });
    expect(queued).toBeDefined();
    return { queued: queued!, ingressScope };
  }

  function execute(
    turn: Turn,
    oldScope?: NonNullable<AgentTurnParams["opts"]>["cronCreatorAuthorityCapability"],
    callbackIsHeartbeat = false,
  ) {
    return executeFollowupTurnForTest({
      turn,
      defaults: {
        typing: createFollowupTurnTestTypingController(),
        typingMode: "never",
        defaultModel: "claude",
        opts: { cronCreatorAuthorityCapability: oldScope, isHeartbeat: callbackIsHeartbeat },
      },
      onToolResult: vi.fn(async () => {}),
      onCompactionNoticePayload: vi.fn(async () => {}),
    });
  }

  async function withQueuedOwner(
    run: (
      turn: Turn,
      fixture: OwnerFixture,
      ingressScope: NonNullable<AgentTurnParams["opts"]>["cronCreatorAuthorityCapability"],
    ) => Promise<void>,
    overrides?: (context: OwnerContext, config: OwnerFixture["cfg"]) => SourceOptions,
    channelId: "slack" | "discord" = "slack",
  ) {
    await withAdminIngress(
      async (fixture) => {
        const context = await fixture.context(fixture.admins[0]!.identity.senderId);
        expect(getCommandOwnerAuthority(context)?.isCurrent()).toBe(true);
        const captured = await captureSource(
          context,
          fixture.cfg,
          overrides?.(context, fixture.cfg),
        );
        const turn = createFollowupTurnTestTurn({
          runId: "queued-owner-run",
          config: fixture.cfg,
          queued: captured.queued,
        });
        await run(turn, fixture, captured.ingressScope);
      },
      "role",
      channelId,
    );
  }

  function installAutomationProbe(
    turn: Turn,
    expectedManagement: boolean,
    beforeCall?: () => Promise<void>,
  ) {
    const { operationalRunInstance } = createTestAdmittedRunContext(turn.runId);
    const delegated = claimAgentRunDelegatedAuthority(operationalRunInstance);
    const identity: AgentRuntimeIdentity = {
      kind: "agentRuntime",
      agentId: "main",
      sessionKey: turn.queued.run.sessionKey ?? "main",
      operationalRunInstance,
      delegatedAuthority: { ...delegated, kind: "local" },
    };
    const calls: string[] = [];
    const requesters: ReturnType<typeof getCronManagementChannelRequester>[] = [];
    let retainedTool: ReturnType<typeof createCronTool> | undefined;
    state.execute.mockImplementation(async (params: AgentTurnParams) => {
      await withGatewayToolCallerIdentity(
        { ...identity, approvalAuthority: delegated },
        async () => {
          const tool = createCronTool(
            { runId: params.opts?.runId, agentSessionKey: identity.sessionKey },
            {
              callGatewayTool: async <T>(method: string) => {
                const grant = getGatewayToolCallerIdentity()?.cronManagementGrant;
                expect(Boolean(grant)).toBe(expectedManagement);
                if (!grant) {
                  calls.push("restricted");
                  return { jobs: [], total: 0, hasMore: false } as T;
                }
                return await withCronManagementGrant(grant, identity, method, async () => {
                  getCronManagementAuthority(identity)!();
                  requesters.push(getCronManagementChannelRequester(identity));
                  calls.push(method);
                  return { jobs: [], total: 0, hasMore: false } as T;
                });
              },
            },
          );
          expect(JSON.stringify(tool.parameters).includes('"on-exit"')).toBe(expectedManagement);
          retainedTool = tool;
          await beforeCall?.();
          await tool.execute("list", { action: "list" });
        },
      );
      return { runId: turn.runId, outcome: { kind: "rejected", payload: { text: "done" } } };
    });
    return {
      calls,
      requesters,
      retainedTool: () => retainedTool!,
      release: () => releaseAgentRunDelegatedAuthority(delegated),
    };
  }

  describe("queued owner automation authority", () => {
    it("issues a fresh run grant after the immediate ingress scope has settled", async () => {
      await withQueuedOwner(async (turn, _fixture, oldScope) => {
        expect(oldScope).toBeDefined();
        expect(oldScope!.active).toBe(false);
        const probe = installAutomationProbe(turn, true);
        try {
          await collectQueuedInputs([turn.queued], 1, undefined, async (queued) => {
            turn.queued = queued;
            await execute(turn, oldScope, true);
          });
          expect(probe.calls).toEqual(["cron.list"]);
          const opts = state.execute.mock.calls[0]![0].opts;
          expect(opts.cronCreatorAuthorityCapability).not.toBe(oldScope);
          expect(opts.cronCreatorAuthorityCapability.runId).toBe(turn.runId);
          await expect(
            probe.retainedTool().execute("late-list", { action: "list" }),
          ).rejects.toThrow(/Automation admin grant/);
        } finally {
          probe.release();
        }
      });
    });

    it.each([
      "non-owner",
      "heartbeat",
      "room-event",
      "internal",
      "spawned",
      "replay",
      "inherited",
    ] as const)("retains the original producer eligibility for %s", async (kind) => {
      const inherited =
        kind === "inherited"
          ? createCronCreatorAuthorityCapability(
              "inherited-run",
              { kind: "external", channel: "slack" },
              { source: "channel-owner", isCurrent: () => true },
            )!
          : undefined;
      try {
        await withQueuedOwner(
          async (turn) => {
            expect(turn.queued.createChannelCronAuthority).toBeUndefined();
            // This tests the producer contract even for heartbeat, which real admission drops.
            const probe = installAutomationProbe(turn, false);
            try {
              await execute(turn, inherited);
              expect(probe.calls).toEqual(["restricted"]);
            } finally {
              probe.release();
            }
          },
          (context) => {
            const input = {
              ...context,
              ...(kind === "room-event" ? { InboundEventKind: "room_event" as const } : {}),
              ...(kind === "internal"
                ? {
                    InputProvenance: {
                      kind: "internal_system" as const,
                      sourceTool: "test-system",
                    },
                  }
                : {}),
            };
            return {
              command: {
                ...ownerParams().command,
                senderId: context.SenderId,
                senderIsOwner: kind !== "non-owner",
              },
              ctx: { ...input, ...createInboundBody("list automations") },
              sessionCtx: { ...input, ...createSessionBody("list automations") },
              ...(kind === "spawned"
                ? {
                    sessionEntry: {
                      sessionId: "child-session",
                      updatedAt: 1,
                      spawnedBy: "agent:parent:main",
                    },
                  }
                : {}),
              opts: {
                isHeartbeat: kind === "heartbeat",
                suppressNextUserMessagePersistence: kind === "replay",
                ...(inherited ? { cronCreatorAuthorityCapability: inherited } : {}),
              },
            };
          },
        );
      } finally {
        if (inherited) {
          runWithCronCreatorAuthorityCapability(inherited, () => {});
        }
      }
    });

    it("keeps unbranded configured-owner queued records restricted", async () => {
      try {
        await withQueuedOwner(
          async (turn, _fixture, ingressScope) => {
            expect(getCommandOwnerAuthority(turn.queued.run)).toBeUndefined();
            expect(ingressScope?.requesterOwner?.isCurrent()).toBe(true);
            const probe = installAutomationProbe(turn, false);
            try {
              await execute(turn);
              expect(probe.calls).toEqual(["restricted"]);
            } finally {
              probe.release();
            }
          },
          (context, cfg) => {
            const configured = {
              ...cfg,
              commands: { ...cfg.commands, ownerAllowFrom: ["slack:" + context.SenderId] },
            };
            setRuntimeConfigSnapshot(configured);
            const wire = wireRoundTrip(context);
            return {
              cfg: configured,
              ctx: { ...wire, ...createInboundBody("list automations") },
              sessionCtx: { ...wire, ...createSessionBody("list automations") },
            };
          },
        );
      } finally {
        clearRuntimeConfigSnapshot();
      }
    });

    it("captures the original canonical owner and Discord transport alias", async () => {
      await withQueuedOwner(
        async (turn, _fixture, ingressScope) => {
          expect(ingressScope?.requesterOwner).toMatchObject({
            channel: "discord",
            accountId: "team",
            senderId: "100",
          });
          turn.queued.run.senderId = "later-sender";
          turn.queued.run.messageProvider = "slack";
          turn.queued.run.agentAccountId = "later-account";
          turn.queued.originatingAccountId = "later-route";
          const probe = installAutomationProbe(turn, true);
          try {
            await execute(turn);
            expect(probe.calls).toEqual(["cron.list"]);
            expect(
              state.execute.mock.calls[0]![0].opts.cronCreatorAuthorityCapability.requesterOwner,
            ).toMatchObject({ channel: "discord", accountId: "team", senderId: "100" });
            expect(probe.requesters).toEqual([
              {
                version: 1,
                channel: "discord",
                accountId: "team",
                senderId: "transport-alias",
              },
            ]);
          } finally {
            probe.release();
          }
        },
        (context) => ({
          ctx: {
            ...context,
            ...createInboundBody("list automations"),
            SenderId: "transport-alias",
          },
          sessionCtx: {
            ...context,
            ...createSessionBody("list automations"),
            SenderId: "transport-alias",
          },
        }),
        "discord",
      );
    });

    it("does not replace the captured source check with a newer owner", async () => {
      await withQueuedOwner(async (turn, fixture) => {
        fixture.replaceGatewayContext();
        const replacement = await fixture.context(fixture.admins[0]!.identity.senderId);
        bindCommandOwnerAuthority(turn.queued.run, getCommandOwnerAuthority(replacement)!);
        expect(getCommandOwnerAuthority(turn.queued.run)?.isCurrent()).toBe(true);
        const probe = installAutomationProbe(turn, false);
        try {
          await execute(turn);
          expect(probe.calls).toEqual(["restricted"]);
        } finally {
          probe.release();
        }
      });
    });

    it("preserves original authority through queued overflow summaries", async () => {
      await withQueuedOwner(async (turn) => {
        const inputs = [1, 2, 3].map((index) =>
          Object.assign({}, turn.queued, {
            messageId: "overflow-" + index,
            prompt: "source " + index,
            summaryLine: "source " + index,
          }),
        );
        let index = 0;
        const outputs = await collectQueuedInputs(
          inputs,
          2,
          undefined,
          async (queued) => {
            const queuedTurn = createFollowupTurnTestTurn({
              ...turn,
              queued,
              runId: "overflow-run-" + ++index,
              operation: createFollowupTurnTestTurn().operation,
            });
            expect(queued.createChannelCronAuthority).toBe(turn.queued.createChannelCronAuthority);
            const probe = installAutomationProbe(queuedTurn, true);
            try {
              await execute(queuedTurn);
              expect(probe.calls).toEqual(["cron.list"]);
            } finally {
              probe.release();
            }
          },
          { cap: 1, dropPolicy: "summarize" },
        );
        expect(outputs).toHaveLength(2);
      });
    });

    it.each([
      "non-owner",
      "serialized",
      "forged",
      "room-event",
      "system",
      "spawned",
      "replay",
      "owner-revoked",
      "host-replaced",
      "host-retired",
    ] as const)("does not borrow callback authority for %s queued input", async (kind) => {
      await withQueuedOwner(async (turn, fixture) => {
        if (kind === "non-owner") {
          turn.queued.run.senderIsOwner = false;
        }
        if (kind === "serialized") {
          turn.queued.run = wireRoundTrip(turn.queued.run);
        }
        if (kind === "forged") {
          for (const symbol of Object.getOwnPropertySymbols(turn.queued.run)) {
            Reflect.set(turn.queued.run, symbol, { isCurrent: () => true });
          }
        }
        if (kind === "room-event") {
          turn.queued.currentInboundEventKind = "room_event";
        }
        if (kind === "system") {
          turn.queued.run.inputProvenance = { kind: "internal_system", sourceTool: "test-system" };
        }
        if (kind === "spawned") {
          turn.queued.run.spawnedBy = "agent:parent:main";
        }
        if (kind === "replay") {
          turn.queued.run.suppressNextUserMessagePersistence = true;
        }
        if (kind === "owner-revoked") {
          await fixture.activatePolicy({
            roles: {
              default: "member",
              definitions: { admin: { scopes: [], agents: "*", sessions: { others: "none" } } },
            },
          });
        }
        if (kind === "host-replaced") {
          fixture.replaceGatewayContext();
        }
        if (kind === "host-retired") {
          fixture.retire();
        }
        const borrowed = createCronCreatorAuthorityCapability(
          turn.runId,
          { kind: "external", channel: "slack" },
          { source: "channel-owner", isCurrent: () => true },
        )!;
        const probe = installAutomationProbe(turn, false);
        try {
          await execute(turn, borrowed);
          expect(probe.calls).toEqual(["restricted"]);
          expect(
            state.execute.mock.calls[0]![0].opts.cronCreatorAuthorityCapability,
          ).toBeUndefined();
        } finally {
          runWithCronCreatorAuthorityCapability(borrowed, () => {});
          probe.release();
        }
      });
    });

    it("rechecks a captured grant after owner policy changes before the RPC", async () => {
      await withQueuedOwner(async (turn, fixture) => {
        const probe = installAutomationProbe(turn, true, async () => {
          await fixture.activatePolicy({
            roles: {
              default: "member",
              definitions: { admin: { scopes: [], agents: "*", sessions: { others: "none" } } },
            },
          });
        });
        try {
          await expect(execute(turn)).rejects.toThrow(/Automation admin grant/);
          expect(probe.calls).toEqual([]);
        } finally {
          probe.release();
        }
      });
    });

    it.each([
      "current",
      "missing-first-owner",
      "forged-first-owner",
      "replaced-first-host",
      "revoked-after-bind",
    ] as const)(
      "checks every collected source without depending on audit evidence: %s",
      async (kind) => {
        await withQueuedOwner(async (turn, fixture) => {
          const first = {
            ...turn.queued,
            messageId: "source-1",
            prompt: "first source prompt",
            run: { ...turn.queued.run },
          };
          let firstCurrent = true;
          if (kind === "revoked-after-bind") {
            const original = getCommandOwnerAuthority(first.run)!;
            bindCommandOwnerAuthority(first.run, {
              ...original,
              isCurrent: () => firstCurrent && original.isCurrent(),
            });
          }
          if (kind === "missing-first-owner") {
            first.run = wireRoundTrip(first.run);
          }
          if (kind === "forged-first-owner") {
            for (const symbol of Object.getOwnPropertySymbols(first.run)) {
              Reflect.set(first.run, symbol, { isCurrent: () => true });
            }
          }
          if (kind === "replaced-first-host") {
            fixture.replaceGatewayContext();
          }
          const last = {
            ...turn.queued,
            messageId: "source-2",
            prompt: "last source prompt",
            run: { ...turn.queued.run },
          };
          const context = await fixture.context(fixture.admins[0]!.identity.senderId);
          bindCommandOwnerAuthority(last.run, getCommandOwnerAuthority(context)!);
          expect(getCommandOwnerAuthority(last.run)?.isCurrent()).toBe(true);
          const collected = await collectQueuedInputs(
            [first, last],
            1,
            undefined,
            async (queued) => {
              expect(queued.prompt).toContain("first source prompt");
              expect(queued.prompt).toContain("last source prompt");
              turn.queued = queued;
              const probe = installAutomationProbe(
                turn,
                kind === "current" || kind === "revoked-after-bind",
                kind === "revoked-after-bind"
                  ? async () => {
                      firstCurrent = false;
                    }
                  : undefined,
              );
              try {
                if (kind === "revoked-after-bind") {
                  await expect(execute(turn)).rejects.toThrow(/Automation admin grant/);
                  expect(probe.calls).toEqual([]);
                } else {
                  await execute(turn);
                  expect(probe.calls).toEqual(kind === "current" ? ["cron.list"] : ["restricted"]);
                }
              } finally {
                probe.release();
              }
            },
          );
          expect(collected).toHaveLength(1);
        });
      },
    );

    it.each(["account", "sender", "source-policy", "system-source", "source-factory"] as const)(
      "keeps different %s inputs in separate queue groups",
      async (kind) => {
        await withQueuedOwner(async (turn) => {
          const first = {
            ...turn.queued,
            messageId: "source-1",
            prompt: "first source prompt",
            run: { ...turn.queued.run },
          };
          const last = {
            ...turn.queued,
            messageId: "source-2",
            prompt: "last source prompt",
            run: { ...turn.queued.run },
          };
          if (kind === "account") {
            last.originatingAccountId = "replacement-installation";
          }
          if (kind === "sender") {
            last.run.senderId = "U00000101";
          }
          if (kind === "source-policy") {
            last.run.conversationToolPolicy = { allow: ["automations"] };
          }
          if (kind === "source-factory") {
            last.createChannelCronAuthority = undefined;
          }
          if (kind === "system-source") {
            last.run.inputProvenance = { kind: "internal_system", sourceTool: "test-system" };
          }
          expect(await collectQueuedInputs([first, last], 2)).toHaveLength(2);
        });
      },
    );

    it("cancels an old account source when its monitor aborts, while the new source can run", async () => {
      await withQueuedOwner(async (turn) => {
        const retired = new AbortController();
        const first = {
          ...turn.queued,
          messageId: "old-installation",
          prompt: "retired source prompt",
          abortSignal: retired.signal,
        };
        const last = {
          ...turn.queued,
          messageId: "current-installation",
          prompt: "current source prompt",
        };
        const collected = await collectQueuedInputs(
          [first, last],
          2,
          () => retired.abort(),
          async (queued) => {
            const signal = resolveFollowupAbortSignal(queued)!;
            const queuedTurn = {
              ...turn,
              queued,
              operation: { ...createFollowupTurnTestTurn().operation, abortSignal: signal },
            };
            if (signal.aborted) {
              await expect(execute(queuedTurn)).rejects.toThrow();
              expect(state.execute).not.toHaveBeenCalled();
              return;
            }
            expect(queued.prompt).toContain("current source prompt");
            expect(queued.prompt).not.toContain("retired source prompt");
            const probe = installAutomationProbe(queuedTurn, true);
            try {
              await execute(queuedTurn);
              expect(probe.calls).toEqual(["cron.list"]);
            } finally {
              probe.release();
            }
          },
        );
        expect(collected).toHaveLength(2);
        expect(state.execute).toHaveBeenCalledOnce();
      });
    });
  });

  function wireRoundTrip<T>(value: T): T {
    // This intentionally models a wire roundtrip, which cannot retain host capabilities.
    const wire = JSON.stringify(value);
    return JSON.parse(wire);
  }
}
