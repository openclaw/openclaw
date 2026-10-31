import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expectDefined } from "@openclaw/normalization-core";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as EmbeddedAgent from "../../agents/embedded-agent.js";
import { runEmbeddedAgent } from "../../agents/embedded-agent.js";
import { subagentRuns } from "../../agents/subagents/registry/subagent-registry-memory.js";
import { prepareSubagentRunsByRunIds } from "../../agents/subagents/registry/subagent-registry.js";
import {
  closeSwarmScheduler,
  isSwarmRunActive,
  listSwarmRunReservationIds,
  releaseSwarmRun,
} from "../../agents/subagents/swarm/swarm-scheduler.js";
import { enqueueSwarmRun } from "../../agents/subagents/swarm/swarm-scheduler.lifecycle.test-support.js";
import { withAdminIngress } from "../../channels/message-access/operator-authority.test-support.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import {
  loadSessionEntry,
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createAgentRuntimeApprovalAuthorityValidator } from "../../gateway/agent-runtime-approval-authority.js";
import { invalidateOperatorRolePolicy } from "../../gateway/operator-role-policy.js";
import { createDirectChatContext } from "../../gateway/server-chat.agent-events.test-helpers.js";
import { createGatewayInstanceRuntime } from "../../gateway/server-instance-runtime.js";
import { createRequestGatewayMethodRegistry } from "../../gateway/server-methods.js";
import { GatewayScheduler } from "../../infra/gateway-scheduler.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../plugins/hook-runner-global.js";
import { addTestHook } from "../../plugins/hooks.test-fixtures.js";
import {
  bindLegacyPluginSdkResourceHost,
  LegacyPluginSdkResourceHost,
} from "../../plugins/legacy-sdk-resource-host.js";
import { loadOpenClawPlugins } from "../../plugins/loader.js";
import { waitForPluginCacheRetirement } from "../../plugins/plugin-cache.js";
import type { PluginRegistry } from "../../plugins/registry-types.js";
import {
  disposePluginRegistryInstances,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import { withPluginRuntimeGatewayContextResolver } from "../../plugins/runtime/gateway-request-scope.js";
import type { PluginCommandContext, PluginCommandResult } from "../../plugins/types.js";
import { trackAsyncWork } from "../../shared/async-work-scope.js";
import { changeCanonicalUserChannelIdentity } from "../../state/user-channel-identity-operations.js";
import { setCanonicalUserProfileRole } from "../../state/user-profile-writes.js";
import { setUserProfileRole } from "../../state/user-profile-writes.worker.js";
import { getCommandOwnerAuthority } from "../command-owner-authority.js";
import { withReplyDispatcher } from "../dispatch-dispatcher.js";
import { dispatchInboundMessage } from "../dispatch.js";
import type { ReplyPayload } from "../types.js";
import { createReplyAgentDefaults } from "./get-reply-config.test-support.js";
import { resetInboundDedupe } from "./inbound-dedupe.js";
import { createReplyDispatcher } from "./reply-dispatcher.js";

vi.mock("../../agents/embedded-agent.js", async (importOriginal) => ({
  ...(await importOriginal<typeof EmbeddedAgent>()),
  runEmbeddedAgent: vi.fn(),
}));
// Children never launch; the isolated fixture has no provider catalog.
const modelChoice = vi.hoisted(() => ({ stub: false }));
vi.mock("../../agents/model-runtime-choice.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../agents/model-runtime-choice.js")>();
  return {
    ...actual,
    prepareModelChoice: async (params: Parameters<typeof actual.prepareModelChoice>[0]) =>
      modelChoice.stub
        ? { kind: "automatic" as const, ref: { provider: "openai", model: "gpt-4.1" } }
        : await actual.prepareModelChoice(params),
  };
});

const pluginId = "channel-command-controller";
type Handler = (ctx: PluginCommandContext) => PluginCommandResult | Promise<PluginCommandResult>;
type Probe = { subagents: boolean; scheduledTurns: boolean; userInputs: unknown[] };
type Sender = {
  senderId?: string;
  verified?: boolean;
  commandAuthorized?: boolean;
  foreignOperatorAuthority?: true;
};

type AuthorityChange = "demotion" | "role removal" | "identity unlink";

type Fixture = {
  handler: ReturnType<typeof vi.fn<Handler>>;
  probe: (ctx: PluginCommandContext) => Promise<Probe>;
  send: (body: string, sender?: Sender) => Promise<(string | undefined)[]>;
  userInputs: () => Promise<unknown[]>;
  userInputKeys: () => Promise<string[]>;
  demoteAdmin: () => void;
  changeAuthority: (change: AuthorityChange) => Promise<void>;
  narrowAdminRoleUnannounced: () => void;
  otherAdminProfileId: string;
  holdChildCapacity: () => { release: () => void; expectQueued: (runId: string) => void };
};

// Only the disk-loaded plugin handler is test-owned; ingress, persistence and policy are real.
async function withChannelCommandPlugin(
  run: (fixture: Fixture) => Promise<void>,
  options: {
    commandsAllowFrom?: string[];
    channelId?: "discord" | "slack";
    authority?: "role" | "identity-grant";
    nativeChildren?: true;
  } = {},
) {
  const channelId = options.channelId ?? "discord";
  await withAdminIngress(
    async ({ cfg, state, admins, context, gateway, resolveGatewayContext }) => {
      const bridge = Symbol.for(`openclaw.channel-command-native-test.${randomUUID()}`);
      gateway.resolveGatewayContext = resolveGatewayContext;
      const storePath = path.join(state.sessionsDir("main"), "sessions.json");
      const sessionKey = `agent:main:${channelId}:channel:maintainers`;
      const messages = async (role: "user" | "assistant") => {
        const entry = loadSessionEntry({ agentId: "main", sessionKey, storePath });
        const events = await loadTranscriptEvents({
          agentId: "main",
          sessionKey,
          storePath,
          sessionId: expectDefined(entry?.sessionId, "requester session"),
        });
        return events.flatMap((event) => {
          const record = asOptionalRecord(event);
          const message = asOptionalRecord(record?.message);
          return record?.type === "message" && message?.role === role ? [message] : [];
        });
      };
      const userInputs = async () => (await messages("user")).map((message) => message.content);
      const userInputKeys = async () =>
        (await messages("user")).map((message) =>
          String(message.idempotencyKey).replace(/^(channel-user:v1:|command-input:).*$/u, "$1"),
        );
      const probe = async (ctx: PluginCommandContext): Promise<Probe> => ({
        subagents: ctx.runtimeContext?.subagents !== undefined,
        scheduledTurns: ctx.runtimeContext?.scheduledTurns !== undefined,
        userInputs: await userInputs(),
      });
      const handler = vi.fn<Handler>(async (ctx) => ({ text: JSON.stringify(await probe(ctx)) }));
      Reflect.set(globalThis, bridge, handler);
      const pluginDir = state.path("channel-controller-plugin");
      await fs.mkdir(pluginDir);
      const pluginFile = path.join(pluginDir, "index.cjs");
      await fs.writeFile(
        path.join(pluginDir, "openclaw.plugin.json"),
        JSON.stringify({
          id: pluginId,
          configSchema: { type: "object", additionalProperties: false, properties: {} },
          contracts: {
            commandRuntimeCapabilities: ["subagents", "scheduledTurns"],
            sessionScheduledTurns: ["requester-command"],
          },
        }),
      );
      const commands = [
        { name: "review-panel", requireAuth: true, runtimeCapabilities: ["subagents"] },
        {
          name: "review-schedule",
          requireAuth: true,
          runtimeCapabilities: ["subagents", "scheduledTurns"],
        },
      ];
      await fs.writeFile(
        pluginFile,
        `module.exports = { id: ${JSON.stringify(pluginId)}, register(api) {
        for (const command of ${JSON.stringify(commands)}) {
          api.registerCommand({ ...command, description: "Synthetic channel command",
            acceptsArgs: true,
            handler(ctx) {
              return globalThis[Symbol.for(${JSON.stringify(Symbol.keyFor(bridge))})](ctx);
            }
          });
        }
      } };`,
      );
      const nextConfig: OpenClawConfig = {
        ...cfg,
        agents: {
          defaults: createReplyAgentDefaults(state.workspaceDir),
        },
        commands: {
          ...cfg.commands,
          text: true,
          ...(options.commandsAllowFrom
            ? { allowFrom: { [channelId]: options.commandsAllowFrom } }
            : {}),
        },
        session: { ...cfg.session, store: storePath },
        plugins: {
          allow: [pluginId],
          load: { paths: [pluginFile] },
          entries: { [pluginId]: { enabled: true } },
        },
        // One slot keeps capacity holds deterministic.
        ...(options.nativeChildren ? { tools: { swarm: { maxConcurrent: 1 } } } : {}),
      };
      Object.assign(cfg, nextConfig);
      if (options.nativeChildren) {
        modelChoice.stub = true;
        Object.assign(
          gateway,
          createDirectChatContext({
            getRuntimeConfig: () => cfg,
            resolveGatewayContext,
            validateAgentRuntimeApprovalAuthority: createAgentRuntimeApprovalAuthorityValidator(),
            getGatewayMethodRegistry: () => createRequestGatewayMethodRegistry(),
            trackExecution: trackAsyncWork,
          }),
        );
      }
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey, storePath },
        { sessionId: "channel-parent", lifecycleRevision: "revision-1", updatedAt: 1 },
      );
      await state.writeConfig(cfg);
      setRuntimeConfigSnapshot(cfg);
      await using gatewayResources = new AsyncDisposableStack();
      if (options.nativeChildren) {
        const runtime = createGatewayInstanceRuntime({
          getContext: () => gateway,
          getMethodRegistry: () => createRequestGatewayMethodRegistry(),
          isDispatchAvailable: () => true,
        });
        gateway.lifecycleRuntime = runtime.lifecycle;
        gatewayResources.defer(() => runtime.close());
      }
      const scheduler = new GatewayScheduler();
      gatewayResources.defer(() => scheduler.stop());
      const sdkHost = new LegacyPluginSdkResourceHost();
      gatewayResources.defer(() => sdkHost.close());
      sdkHost.bindScheduler(scheduler);
      bindLegacyPluginSdkResourceHost(resolveGatewayContext, sdkHost);
      let registry: PluginRegistry | undefined;
      const blockers: string[] = [];
      const previousSubagentRuns = new Set(subagentRuns.keys());
      try {
        registry = loadOpenClawPlugins({
          config: cfg,
          workspaceDir: state.workspaceDir,
          cache: false,
          logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        });
        setActivePluginRegistry(registry);
        expect(registry.diagnostics.filter((entry) => entry.pluginId === pluginId)).toEqual([]);
        const send: Fixture["send"] = async (body, sender = {}) => {
          const ctx = await context(
            sender.senderId ?? admins[0]!.identity.senderId,
            sender.verified ?? true,
            "team",
            {
              messageId: randomUUID(),
              message: { rawBody: body },
              access: { commands: { authorized: sender.commandAuthorized ?? true } },
            },
          );
          expect(ctx.SessionKey).toBe(sessionKey);
          const operatorAuthority = sender.foreignOperatorAuthority
            ? getCommandOwnerAuthority(await context(admins[1]!.identity.senderId))
                ?.operatorAuthority
            : undefined;
          if (sender.foreignOperatorAuthority) {
            expect(operatorAuthority).toBeDefined();
          }
          const replies: ReplyPayload[] = [];
          const dispatcher = createReplyDispatcher({
            deliver: async (payload) => {
              replies.push(payload);
            },
          });
          // Match startChannel's resolver without inheriting a request-local client.
          await withPluginRuntimeGatewayContextResolver(
            resolveGatewayContext,
            () =>
              withReplyDispatcher({
                dispatcher,
                run: () =>
                  dispatchInboundMessage({
                    ctx,
                    cfg,
                    dispatcher,
                    ...(operatorAuthority ? { replyOptions: { operatorAuthority } } : {}),
                  }),
              }),
            { inheritRequestScope: false },
          );
          return replies.map((reply) => reply.text);
        };
        const admin = admins[0]!;
        await run({
          handler,
          probe,
          send,
          userInputs,
          userInputKeys,
          demoteAdmin: () => setUserProfileRole(admin.profile.id, "member"),
          changeAuthority: async (change) => {
            if (change === "demotion" || change === "role removal") {
              await setCanonicalUserProfileRole(
                admin.profile.id,
                change === "demotion" ? "member" : null,
                { onCommitted: invalidateOperatorRolePolicy },
              );
              return;
            }
            await changeCanonicalUserChannelIdentity("unlink", admin.profile.id, admin.identity);
          },
          otherAdminProfileId: admins[1]!.profile.id,
          narrowAdminRoleUnannounced: () => {
            const roles = expectDefined(cfg.gateway?.roles, "operator roles");
            roles.definitions.admin = { ...roles.definitions.admin!, scopes: ["operator.read"] };
          },
          holdChildCapacity: () => {
            const loaded = expectDefined(registry, "loaded registry");
            addTestHook({
              registry: loaded,
              pluginId,
              hookName: "before_tool_call",
              handler: (
                event: { toolName: string },
                hookCtx: { sessionKey?: string; runId?: string },
              ) => {
                if (event.toolName !== "sessions_spawn" || blockers.length > 0) {
                  return undefined;
                }
                const parent = expectDefined(hookCtx.sessionKey, "spawn requester");
                const runId = expectDefined(hookCtx.runId, "spawn requester turn");
                const blocker = "capacity-" + runId;
                blockers.push(blocker);
                enqueueSwarmRun({
                  groupId: JSON.stringify(["main", parent, "swarm:" + parent + ":" + runId]),
                  runId: blocker,
                  maxConcurrent: 1,
                  activeRunIds: [],
                  start: async () => {},
                  onStartFailure: () => true,
                });
                return undefined;
              },
            });
            initializeGlobalHookRunner(loaded);
            return {
              release: () => {
                for (const blocker of blockers.splice(0)) {
                  releaseSwarmRun(blocker);
                }
              },
              expectQueued: (runId) => {
                expect(blockers).toHaveLength(1);
                expect(isSwarmRunActive(blockers[0]!)).toBe(true);
                expect(listSwarmRunReservationIds()).toContain(runId);
                expect(isSwarmRunActive(runId)).toBe(false);
              },
            };
          },
        });
      } finally {
        const revokedChildren = [...subagentRuns.values()].filter(
          (entry) =>
            !previousSubagentRuns.has(entry.runId) &&
            entry.requesterSessionKey === sessionKey &&
            entry.collectorLaunchCleanupPending &&
            entry.execution.outcome?.error ===
              "Channel operator authority changed; send a new request.",
        );
        // Revocation cleanup dispatches through the still-live Gateway lifecycle.
        await closeSwarmScheduler(resolveGatewayContext);
        for (const child of revokedChildren) {
          expect
            .soft(
              loadSessionEntry({
                agentId: child.childAgentId ?? "main",
                sessionKey: child.childSessionKey,
                storePath,
              }),
              "revoked native child session is physically deleted before fixture retirement",
            )
            .toBeUndefined();
          expect.soft(subagentRuns.get(child.runId)?.collectorLaunchCleanupPending).toBe(false);
        }
        for (const blocker of blockers.splice(0)) {
          releaseSwarmRun(blocker);
        }
        Reflect.deleteProperty(globalThis, bridge);
        resetGlobalHookRunner();
        resetPluginRuntimeStateForTest();
        if (registry) {
          await expect(disposePluginRegistryInstances(registry)).resolves.toMatchObject({
            failures: [],
          });
        }
        await expect(waitForPluginCacheRetirement()).resolves.toMatchObject({ failures: [] });
      }
    },
    options.authority ?? "role",
    channelId,
  );
}

function readProbe(texts: (string | undefined)[]): Probe {
  expect(texts).toHaveLength(1);
  return JSON.parse(expectDefined(texts[0], "command reply")) as Probe;
}

afterEach(() => {
  modelChoice.stub = false;
  resetInboundDedupe();
  vi.mocked(runEmbeddedAgent).mockReset();
});

describe("plugin command native capabilities through channel ingress", () => {
  it.each([
    { channelId: "discord", authority: "role" },
    { channelId: "slack", authority: "identity-grant" },
  ] as const)(
    "grants an authorized $channelId sender with $authority operator authority a live runtime",
    async (options) => {
      await withChannelCommandPlugin(
        async ({ handler, probe, send, userInputs, userInputKeys }) => {
          let listed: unknown;
          handler.mockImplementationOnce(async (ctx) => {
            const native = expectDefined(
              ctx.runtimeContext?.subagents,
              "channel command capability",
            );
            listed = await expectDefined(native.list, "native list")({});
            return { text: JSON.stringify(await probe(ctx)) };
          });
          expect(readProbe(await send("/review-panel"))).toEqual({
            subagents: true,
            scheduledTurns: false,
            userInputs: ["/review-panel"],
          });
          expect(listed).toEqual([]);
          expect(readProbe(await send("/review-schedule"))).toEqual({
            subagents: true,
            scheduledTurns: true,
            userInputs: ["/review-panel", "/review-schedule"],
          });
          expect(readProbe(await send("/review-panel login code: 482913"))).toMatchObject({
            subagents: true,
            userInputs: [
              "/review-panel",
              "/review-schedule",
              "/review-panel login code: [login code redacted]",
            ],
          });
          expect(await userInputKeys()).toEqual([
            "channel-user:v1:",
            "channel-user:v1:",
            "channel-user:v1:",
          ]);
          expect(await userInputs()).toHaveLength(3);
          expect(runEmbeddedAgent).not.toHaveBeenCalled();
        },
        options,
      );
    },
  );

  it("continues the agent on the same committed user input", async () => {
    await withChannelCommandPlugin(async ({ handler, probe, send, userInputs, userInputKeys }) => {
      handler.mockImplementationOnce(async (ctx) => {
        expect(await probe(ctx)).toMatchObject({
          subagents: true,
          userInputs: ["/review-panel"],
        });
        return { continueAgent: true, suppressReply: true };
      });
      let continuation:
        | { runId?: string; receiptSessionId?: string; inputsAtRun: unknown[] }
        | undefined;
      vi.mocked(runEmbeddedAgent).mockImplementationOnce(async (params) => {
        continuation = {
          runId: params.runId,
          receiptSessionId: params.userTurnTranscriptRecorder?.getAdmissionReceipt()?.sessionId,
          inputsAtRun: await userInputs(),
        };
        return { payloads: [{ text: "Continued." }], meta: { durationMs: 1 } };
      });
      expect(await send("/review-panel")).toEqual(["Continued."]);
      expect(runEmbeddedAgent).toHaveBeenCalledTimes(1);
      expect(continuation).toEqual({
        runId: expect.any(String),
        receiptSessionId: "channel-parent",
        inputsAtRun: ["/review-panel"],
      });
      expect(await userInputs()).toEqual(["/review-panel"]);
      expect(await userInputKeys()).toEqual(["channel-user:v1:"]);
    });
  });

  it("rechecks the channel operator on every native call and fences the revoked turn", async () => {
    await withChannelCommandPlugin(async ({ handler, send, demoteAdmin }) => {
      let failure: unknown;
      handler.mockImplementationOnce(async (ctx) => {
        const native = expectDefined(ctx.runtimeContext?.subagents, "channel command capability");
        demoteAdmin();
        failure = await native.spawn({ requestId: "after-demotion", task: "Review" }).then(
          () => undefined,
          (error: unknown) => error,
        );
        return { text: "demoted" };
      });
      expect(await send("/review-panel")).toEqual([]);
      expect(failure).toEqual(new Error("Channel operator authority changed; send a new request."));
    });
  });

  it("does not run an unauthorized channel command", async () => {
    await withChannelCommandPlugin(async ({ handler, send, userInputKeys }) => {
      expect(await send("/review-panel", { commandAuthorized: false })).toEqual([
        expect.stringMatching(/requires authorization/u),
      ]);
      expect(handler).not.toHaveBeenCalled();
      expect(await userInputKeys()).toEqual(["command-input:"]);
    });
  });

  it("withholds the capability from authorized senders without operator authority", async () => {
    await withChannelCommandPlugin(
      async ({ handler, send, demoteAdmin, userInputKeys }) => {
        const mirrored = [{ type: "text", text: "/review-schedule" }];
        const withheld = (earlier: number) => ({
          subagents: false,
          scheduledTurns: false,
          userInputs: Array.from({ length: earlier }, () => mirrored),
        });
        expect(readProbe(await send("/review-schedule", { senderId: "unlinked-sender" }))).toEqual(
          withheld(0),
        );
        expect(readProbe(await send("/review-schedule", { verified: false }))).toEqual(withheld(1));
        expect(
          readProbe(await send("/review-schedule", { foreignOperatorAuthority: true })),
        ).toEqual(withheld(2));
        demoteAdmin();
        expect(readProbe(await send("/review-schedule"))).toEqual(withheld(3));
        expect(handler).toHaveBeenCalledTimes(4);
        expect(await userInputKeys()).toEqual([
          "command-input:",
          "command-input:",
          "command-input:",
          "command-input:",
        ]);
      },
      { commandsAllowFrom: ["*"] },
    );
  });
});

describe("channel requester revocation of native children", () => {
  const revocation = new Error("Channel operator authority changed; send a new request.");

  async function queueChild(fixture: Fixture) {
    const capacity = fixture.holdChildCapacity();
    let accepted: { runId: string; childSessionKey: string } | undefined;
    fixture.handler.mockImplementationOnce(async (ctx) => {
      const native = expectDefined(ctx.runtimeContext?.subagents, "channel command capability");
      accepted = await native.spawn({
        requestId: "queued-review",
        task: "Review the synthetic change",
        context: "isolated",
      });
      return { text: "queued" };
    });
    expect(await fixture.send("/review-panel")).toEqual(["queued"]);
    const child = expectDefined(accepted, "accepted child");
    capacity.expectQueued(child.runId);
    expect(subagentRuns.get(child.runId)?.execution.status).toBe("queued");
    return { child, capacity };
  }

  async function expectRefused(child: { runId: string; childSessionKey: string }) {
    await vi.waitFor(
      () => {
        expect(subagentRuns.get(child.runId)?.execution.status).toBe("terminal");
        expect(listSwarmRunReservationIds()).not.toContain(child.runId);
      },
      { timeout: 10_000 },
    );
    // Completed cleanup can evict resident payloads; the public reader retains the result.
    const prepared = await prepareSubagentRunsByRunIds([child.runId]);
    expect(prepared.consume((runs) => runs.get(child.runId))).toMatchObject({
      ready: true,
      value: {
        execution: { outcome: { status: "error", error: revocation.message } },
        endedReason: "subagent-error",
        completion: { resultText: revocation.message },
        collectorCompletion: { status: "failed" },
      },
    });
    expect(runEmbeddedAgent).not.toHaveBeenCalled();
  }

  it.each(["demotion", "role removal", "identity unlink"] as const)(
    "fails a queued child on %s without waiting for capacity",
    async (change) => {
      await withChannelCommandPlugin(
        async (fixture) => {
          const { child, capacity } = await queueChild(fixture);
          await fixture.changeAuthority(change);
          await expectRefused(child);
          // The lane is still full: revocation, not a launch attempt, settled the child.
          expect(listSwarmRunReservationIds()).toEqual([expect.stringMatching(/^capacity-/u)]);
          capacity.release();
        },
        { nativeChildren: true },
      );
    },
  );

  it("refuses a queued child at its launch check when no revocation is published", async () => {
    await withChannelCommandPlugin(
      async (fixture) => {
        const { child, capacity } = await queueChild(fixture);
        fixture.narrowAdminRoleUnannounced();
        // Nothing announced the change, so the child is still waiting for its slot.
        await delay(50);
        capacity.expectQueued(child.runId);
        capacity.release();
        await expectRefused(child);
      },
      { nativeChildren: true },
    );
  });

  it("keeps a queued child of a still-authorized sender waiting for capacity", async () => {
    await withChannelCommandPlugin(
      async (fixture) => {
        const { child, capacity } = await queueChild(fixture);
        // Another person's committed change rechecks this sender without revoking it.
        await setCanonicalUserProfileRole(fixture.otherAdminProfileId, "member", {
          onCommitted: invalidateOperatorRolePolicy,
        });
        await delay(50);
        capacity.expectQueued(child.runId);
        expect(subagentRuns.get(child.runId)?.execution.status).toBe("queued");
        // The subscription stays live for the sender's own later change.
        await fixture.changeAuthority("demotion");
        await expectRefused(child);
        capacity.release();
      },
      { nativeChildren: true },
    );
  });
});
