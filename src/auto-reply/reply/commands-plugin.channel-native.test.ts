import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as EmbeddedAgent from "../../agents/embedded-agent.js";
import { runEmbeddedAgent } from "../../agents/embedded-agent.js";
import { withAdminIngress } from "../../channels/message-access/operator-authority.test-support.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import {
  loadSessionEntry,
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resetGlobalHookRunner } from "../../plugins/hook-runner-global.js";
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
import { setUserProfileRole } from "../../state/user-profile-writes.worker.js";
import { getCommandOwnerAuthority } from "../command-owner-authority.js";
import { withReplyDispatcher } from "../dispatch-dispatcher.js";
import { dispatchInboundMessage } from "../dispatch.js";
import type { ReplyPayload } from "../types.js";
import { resetInboundDedupe } from "./inbound-dedupe.js";
import { createReplyDispatcher } from "./reply-dispatcher.js";

vi.mock("../../agents/embedded-agent.js", async (importOriginal) => ({
  ...(await importOriginal<typeof EmbeddedAgent>()),
  runEmbeddedAgent: vi.fn(),
}));

const pluginId = "channel-command-controller";
type Handler = (ctx: PluginCommandContext) => PluginCommandResult | Promise<PluginCommandResult>;
type Probe = { subagents: boolean; scheduledTurns: boolean; userInputs: unknown[] };
type Sender = {
  senderId?: string;
  verified?: boolean;
  commandAuthorized?: boolean;
  /** Another linked operator's authority, supplied by a caller instead of this ingress. */
  foreignOperatorAuthority?: true;
};

type Fixture = {
  handler: ReturnType<typeof vi.fn<Handler>>;
  probe: (ctx: PluginCommandContext) => Promise<Probe>;
  /** Sends text through the real channel ingress, dispatch, reply resolver and command owner. */
  send: (body: string, sender?: Sender) => Promise<(string | undefined)[]>;
  userInputs: () => Promise<unknown[]>;
  userInputKeys: () => Promise<string[]>;
  demoteAdmin: () => void;
};

// A third-party plugin loaded from disk. Its handler is the only test-owned code on the
// path: ingress authority, command dispatch, transcript commitment and native policy all
// use their production owners. Nothing injects a run id, recorder or request scope.
async function withChannelCommandPlugin(
  run: (fixture: Fixture) => Promise<void>,
  options: {
    commandsAllowFrom?: string[];
    channelId?: "discord" | "slack";
    authority?: "role" | "identity-grant";
  } = {},
) {
  const channelId = options.channelId ?? "discord";
  await withAdminIngress(
    async ({ cfg, state, admins, context, gateway }) => {
      const bridge = Symbol.for(`openclaw.channel-command-native-test.${randomUUID()}`);
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
      // Distinguishes the source-keyed turn the native gate commits from the reply mirror's.
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
          defaults: {
            workspace: state.workspaceDir,
            skipBootstrap: true,
            model: { primary: "mock-openai/gpt-5.6-luna" },
            models: { "mock-openai/gpt-5.6-luna": { agentRuntime: { id: "openclaw" } } },
          },
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
      };
      Object.assign(cfg, nextConfig);
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey, storePath },
        { sessionId: "channel-parent", lifecycleRevision: "revision-1", updatedAt: 1 },
      );
      await state.writeConfig(cfg);
      setRuntimeConfigSnapshot(cfg);
      let registry: PluginRegistry | undefined;
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
          // Channel accounts run inside their Gateway context resolver, without a
          // request-local client or context (server-channels startChannel).
          await withPluginRuntimeGatewayContextResolver(
            () => gateway,
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
        await run({
          handler,
          probe,
          send,
          userInputs,
          userInputKeys,
          demoteAdmin: () => setUserProfileRole(admins[0]!.profile.id, "member"),
        });
      } finally {
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
            // The facade is operational under the channel requester, not merely present.
            listed = await expectDefined(native.list, "native list")({});
            return { text: JSON.stringify(await probe(ctx)) };
          });
          expect(readProbe(await send("/review-panel"))).toEqual({
            subagents: true,
            scheduledTurns: false,
            // Committed before the handler runs, as on Gateway ingress.
            userInputs: ["/review-panel"],
          });
          expect(listed).toEqual([]);
          // Scheduled turns follow the command's own declaration.
          expect(readProbe(await send("/review-schedule"))).toEqual({
            subagents: true,
            scheduledTurns: true,
            userInputs: ["/review-panel", "/review-schedule"],
          });
          // The committed input is the channel's redacted command form.
          expect(readProbe(await send("/review-panel login code: 482913"))).toMatchObject({
            subagents: true,
            userInputs: [
              "/review-panel",
              "/review-schedule",
              "/review-panel login code: [login code redacted]",
            ],
          });
          // Each message has one source-keyed input; the reply mirror adds only replies.
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
        return { continueAgent: true };
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
      // The continuing agent's source-keyed input joins the committed command turn; a
      // differently keyed commitment would append a second input or fail restart recovery.
      expect(continuation).toEqual({
        runId: expect.any(String),
        receiptSessionId: "channel-parent",
        inputsAtRun: ["/review-panel"],
      });
      expect(await userInputs()).toEqual(["/review-panel"]);
      expect(await userInputKeys()).toEqual(["channel-user:v1:"]);
    });
  });

  it("rechecks the channel operator on every native call", async () => {
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
      expect(await send("/review-panel")).toEqual(["demoted"]);
      expect(failure).toEqual(new Error("Channel operator authority changed; send a new request."));
    });
  });

  it("does not run an unauthorized channel command", async () => {
    await withChannelCommandPlugin(async ({ handler, send, userInputKeys }) => {
      expect(await send("/review-panel", { commandAuthorized: false })).toEqual([
        expect.stringMatching(/requires authorization/u),
      ]);
      expect(handler).not.toHaveBeenCalled();
      // Only the existing delivered-command mirror; no native turn was committed.
      expect(await userInputKeys()).toEqual(["command-input:"]);
    });
  });

  it("withholds the capability from authorized senders without operator authority", async () => {
    await withChannelCommandPlugin(
      async ({ handler, send, demoteAdmin, userInputKeys }) => {
        // Nothing is committed before the handler; earlier lines are earlier messages' mirrors.
        const mirrored = [{ type: "text", text: "/review-schedule" }];
        const withheld = (earlier: number) => ({
          subagents: false,
          scheduledTurns: false,
          userInputs: Array.from({ length: earlier }, () => mirrored),
        });
        // The channel lets anyone run the command; native authority still needs a link.
        expect(readProbe(await send("/review-schedule", { senderId: "unlinked-sender" }))).toEqual(
          withheld(0),
        );
        expect(readProbe(await send("/review-schedule", { verified: false }))).toEqual(withheld(1));
        // A caller cannot lend this message another person's operator authority.
        expect(
          readProbe(await send("/review-schedule", { foreignOperatorAuthority: true })),
        ).toEqual(withheld(2));
        demoteAdmin();
        expect(readProbe(await send("/review-schedule"))).toEqual(withheld(3));
        expect(handler).toHaveBeenCalledTimes(4);
        // Only the existing delivered-command mirror recorded these inputs.
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
