import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, vi } from "vitest";
import { subagentRuns } from "../../agents/subagents/registry/subagent-registry-memory.js";
import { withAdminIngress } from "../../channels/message-access/operator-authority.test-support.js";
import { hasMainSessionRecoveryClaim } from "../../config/sessions/restart-recovery-state.js";
import {
  listSessionChildEntriesReadOnly,
  loadSessionEntry,
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  createRestartSafeChatRequest,
  resolveRestartSafeChatAdmission,
} from "../../gateway/server-methods/chat-restart-recovery.js";
// This deprecated public entrypoint is the caller-controlled registrar under test.
import { registerPluginCommand } from "../../plugin-sdk/plugin-runtime.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../plugins/hook-runner-global.js";
import { addTestHook } from "../../plugins/hooks.test-fixtures.js";
import { loadOpenClawPlugins } from "../../plugins/loader.js";
import { waitForPluginCacheRetirement } from "../../plugins/plugin-cache.js";
import {
  createPluginCommandRuntime,
  matchPluginCommandInvocation,
} from "../../plugins/plugin-command-runtime.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import type { PluginRegistry } from "../../plugins/registry-types.js";
import {
  disposePluginRegistryInstances,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import { withPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import type { NativeSubagentRuntime } from "../../plugins/runtime/types-native-subagent.js";
import type { PluginCommandContext, PluginCommandResult } from "../../plugins/types.js";
import { createDeferredCore, type Deferred } from "../../shared/deferred.js";
import { setUserProfileRole } from "../../state/user-profile-writes.worker.js";
import { getCommandOwnerAuthority } from "../command-owner-authority.js";
import { handlePluginCommand } from "./commands-plugin.js";
import {
  createPersistedPluginCommandParams,
  createPluginCommandDispatchState,
  createPluginCommandInvocation,
} from "./commands-plugin.test-support.js";
import type { HandleCommandsParams } from "./commands-types.js";
import { runWithCommandNativeSubagents } from "./dispatch-native-subagent.js";

const pluginId = "command-controller";
const spawnRequest = { requestId: "review", task: "Review the synthetic change" };
type Handler = (ctx: PluginCommandContext) => PluginCommandResult | Promise<PluginCommandResult>;
type CommandMetadata = {
  name: string;
  requireAuth?: boolean;
  runtimeCapabilities?: unknown;
  channels?: string[];
};
const declaredCommand: CommandMetadata = {
  name: "review-panel",
  requireAuth: true,
  runtimeCapabilities: ["subagents"],
};

type Fixture = {
  cfg: OpenClawConfig;
  registry: PluginRegistry;
  params: (body?: string) => HandleCommandsParams;
  handler: ReturnType<typeof vi.fn<Handler>>;
  userInputs: () => Promise<unknown[]>;
  revokeOwner: () => void;
};

// The fixture is a third-party plugin loaded from disk, not an injected registry record.
// Only its application handler crosses this bridge; registration, selection, authority,
// native tool policy, and command lifetime all use their production owners.
async function withCommandPlugin(
  run: (fixture: Fixture) => Promise<void>,
  options: { commands?: CommandMetadata[]; manifestCapabilities?: unknown } = {},
) {
  await withAdminIngress(async ({ cfg, state, admins, context, gateway }) => {
    const bridge = Symbol.for(`openclaw.command-native-test.${randomUUID()}`);
    const handler = vi.fn<Handler>((ctx) => ({
      text: JSON.stringify({
        subagents: ctx.runtimeContext?.subagents !== undefined,
        args: ctx.args,
      }),
    }));
    Reflect.set(globalThis, bridge, handler);
    const pluginDir = state.path("controller-plugin");
    await fs.mkdir(pluginDir);
    const pluginFile = path.join(pluginDir, "index.cjs");
    await fs.writeFile(
      path.join(pluginDir, "openclaw.plugin.json"),
      JSON.stringify({
        id: pluginId,
        configSchema: { type: "object", additionalProperties: false, properties: {} },
        contracts: {
          commandRuntimeCapabilities:
            options.manifestCapabilities === undefined
              ? ["subagents"]
              : options.manifestCapabilities,
        },
      }),
    );
    const commands = options.commands ?? [declaredCommand, { name: "ordinary" }];
    await fs.writeFile(
      pluginFile,
      `module.exports = { id: ` +
        JSON.stringify(pluginId) +
        `, register(api) {
        for (const command of ` +
        JSON.stringify(commands) +
        `) {
          api.registerCommand({ ...command, description: "Synthetic review command", acceptsArgs: true,
            handler(ctx) { return globalThis[Symbol.for(` +
        JSON.stringify(Symbol.keyFor(bridge)) +
        `)](ctx); }
          });
        }
      } };`,
    );
    cfg.agents = { defaults: { workspace: state.workspaceDir } };
    cfg.commands = { ...cfg.commands, text: true };
    const storePath = path.join(state.sessionsDir("main"), "sessions.json");
    cfg.session = { ...cfg.session, store: storePath };
    cfg.plugins = {
      allow: [pluginId],
      load: { paths: [pluginFile] },
      entries: { [pluginId]: { enabled: true } },
    };
    const inbound = await context(admins[0]!.identity.senderId);
    expectDefined(getCommandOwnerAuthority(inbound)?.operatorAuthority, "real ingress authority");
    const sessionKey = expectDefined(inbound.SessionKey, "real ingress session key");
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey, storePath },
      { sessionId: "command-parent", lifecycleRevision: "revision-1", updatedAt: 1 },
    );
    await state.writeConfig(cfg);
    const params = createPersistedPluginCommandParams(cfg, inbound, state, sessionKey, storePath);
    const userInputs = async () => {
      const events = await loadTranscriptEvents({
        agentId: "main",
        sessionKey,
        storePath,
        sessionId: "command-parent",
      });
      return events.flatMap((event) => {
        const record = asOptionalRecord(event);
        const message = asOptionalRecord(record?.message);
        return record?.type === "message" && message?.role === "user" ? [message.content] : [];
      });
    };
    let registry: PluginRegistry | undefined;
    try {
      registry = loadOpenClawPlugins({
        config: cfg,
        workspaceDir: state.workspaceDir,
        cache: false,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      });
      setActivePluginRegistry(registry);
      if (options.commands === undefined) {
        expect(
          registry.diagnostics.filter((diagnostic) => diagnostic.pluginId === pluginId),
          "the valid declaring plugin must load without registration refusals",
        ).toEqual([]);
      }
      await withPluginRuntimeGatewayRequestScope(
        {
          context: gateway,
          resolveGatewayContext: () => gateway,
          pluginRegistry: registry,
          isWebchatConnect: () => false,
        },
        () =>
          run({
            cfg,
            registry: expectDefined(registry, "loaded registry"),
            params,
            handler,
            userInputs,
            revokeOwner: () => setUserProfileRole(admins[0]!.profile.id, "member"),
          }),
      );
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
  });
}

function select(body: string) {
  return matchPluginCommandInvocation(createPluginCommandRuntime(), body, { channel: "discord" });
}

const nativeTools = () => ["sessions_spawn", "agents_wait", "read"];
const commandInvocation = (fixture: Fixture, body = "/review-panel") =>
  createPluginCommandInvocation(fixture.params(body), nativeTools());
type Invocation = ReturnType<typeof commandInvocation>;
const reply = (text: string) => ({ shouldContinue: false, reply: { text } });
const capabilityReply = (subagents: boolean, args?: string) =>
  reply(JSON.stringify({ subagents, args }));

async function expectUncommitted(fixture: Fixture, invocation: Invocation) {
  expect(invocation.recorder.getAdmissionReceipt()).toBeUndefined();
  expect(await fixture.userInputs()).toEqual([]);
}

async function expectNoCapability(fixture: Fixture, invocation: Invocation) {
  expect(await invocation.run()).toEqual(capabilityReply(false));
  await expectUncommitted(fixture, invocation);
}

function changeAuthority(fixture: Fixture, change: "owner" | "registry") {
  if (change === "owner") {
    fixture.revokeOwner();
  } else {
    setActivePluginRegistry(createEmptyPluginRegistry());
  }
}

// Keep the early-settlement guard and unconditional release identical for every race.
async function whilePaused<T>(
  pending: Promise<T>,
  entered: Deferred,
  release: Deferred,
  run: () => Promise<void>,
) {
  try {
    expect(
      await Promise.race([entered.promise.then(() => "entered"), pending.then(() => "finished")]),
    ).toBe("entered");
    await run();
  } finally {
    release.resolve();
    await pending;
  }
}

afterEach(() => {
  resetGlobalHookRunner();
  resetPluginRuntimeStateForTest();
});

describe("command-scoped native subagent boundary", () => {
  it.each<[string, CommandMetadata, string, unknown?]>([
    ["missing manifest grant", declaredCommand, "commandRuntimeCapabilities", []],
    ["public command", { ...declaredCommand, requireAuth: false }, "requireAuth"],
    [
      "implicit authorization default",
      { ...declaredCommand, requireAuth: undefined },
      "requireAuth",
    ],
    [
      "unknown runtime capability",
      { ...declaredCommand, runtimeCapabilities: ["unknown-capability"] },
      "runtimeCapabilities",
    ],
    [
      "malformed runtime capability",
      { ...declaredCommand, runtimeCapabilities: "subagents" },
      "runtimeCapabilities",
    ],
  ])(
    "refuses %s at the real loader registration boundary",
    async (_name, command, reason, manifestCapabilities) => {
      await withCommandPlugin(
        async (fixture) => {
          expect(select("/review-panel")).toBeNull();
          expect(
            fixture.registry.diagnostics.some((diagnostic) => diagnostic.message.includes(reason)),
          ).toBe(true);
          expect(await handlePluginCommand(fixture.params(), true)).toBeNull();
          expect(fixture.handler).not.toHaveBeenCalled();
          expect(await fixture.userInputs()).toEqual([]);
        },
        { commands: [command], manifestCapabilities },
      );
    },
  );

  it("does not let the public direct registrar borrow a loaded plugin's manifest grant", () =>
    withCommandPlugin(async (fixture) => {
      expect(fixture.registry.plugins.find((plugin) => plugin.id === pluginId)).toMatchObject({
        status: "loaded",
        contracts: { commandRuntimeCapabilities: ["subagents"] },
      });
      const spoofed = registerPluginCommand(pluginId, {
        name: "spoofed-review",
        description: "Caller-supplied plugin ID is not an admitted manifest",
        requireAuth: true,
        runtimeCapabilities: ["subagents"],
        handler: fixture.handler,
      });
      expect(spoofed).toMatchObject({ ok: false });
      expect(spoofed.error).toContain("commandRuntimeCapabilities");
      expect(select("/spoofed-review")).toBeNull();
      expect(await commandInvocation(fixture, "/spoofed-review").run()).toBeNull();
      expect(fixture.handler).not.toHaveBeenCalled();

      // The deprecated registrar remains usable for ordinary commands, without authority grants.
      expect(
        registerPluginCommand(pluginId, {
          name: "legacy-command",
          description: "Ordinary direct SDK command",
          handler: fixture.handler,
        }),
      ).toEqual({ ok: true });
      expect(await commandInvocation(fixture, "/legacy-command").run()).toEqual(
        capabilityReply(false),
      );
      expect(await fixture.userInputs()).toEqual([]);
    }));

  it("withholds native runtime from ordinary and legacy command paths", () =>
    withCommandPlugin(async (fixture) => {
      expect(await commandInvocation(fixture, "/ordinary /review-panel").run()).toEqual(
        capabilityReply(false, "/review-panel"),
      );
      // Older command surfaces cannot obtain authority from an ambient hook facade.
      expect(await handlePluginCommand(fixture.params(), true)).toEqual(capabilityReply(false));
      expect(await fixture.userInputs()).toEqual([]);
    }));

  it("commits command input before the handler and reuses that commitment on agent continuation", () =>
    withCommandPlugin(async (fixture) => {
      const invocation = commandInvocation(fixture);
      fixture.handler.mockImplementation(async (ctx) => {
        expect(ctx.runtimeContext?.subagents).toBeDefined();
        expect(await fixture.userInputs()).toEqual(["/review-panel"]);
        expect(invocation.recorder.getAdmissionReceipt()).toMatchObject({
          agentId: "main",
          sessionId: "command-parent",
          sessionKey: invocation.params.sessionKey,
        });
        return { continueAgent: true };
      });
      expect(await invocation.run()).toEqual({ shouldContinue: true, reply: undefined });
      const receipt = invocation.recorder.getAdmissionReceipt();
      // The continuing agent uses the same request recorder, not a second logical user input.
      await invocation.recorder.persistApproved({ expectedSessionId: "command-parent" });
      await invocation.recorder.persistFallback();
      expect(invocation.recorder.getAdmissionReceipt()).toEqual(receipt);
      expect(await fixture.userInputs()).toEqual(["/review-panel"]);
      expect(fixture.handler).toHaveBeenCalledTimes(1);
    }));

  it.each([
    "> /review-panel",
    "Please run /review-panel",
    "`/review-panel`",
    "/foreign /review-panel",
  ])("does not turn quoted or foreign text into a native command: %s", async (body) => {
    await withCommandPlugin(async (fixture) => {
      expect(select(body)).toBeNull();
      expect(await commandInvocation(fixture, body).run()).toBeNull();
      expect(fixture.handler).not.toHaveBeenCalled();
      expect(await fixture.userInputs()).toEqual([]);
    });
  });

  it("does not bind native authority for an unauthorized sender", () =>
    withCommandPlugin(async (fixture) => {
      const invocation = commandInvocation(fixture);
      invocation.params.command.isAuthorizedSender = false;
      expect(await invocation.run()).toEqual(reply("⚠️ This command requires authorization."));
      expect(fixture.handler).not.toHaveBeenCalled();
      await expectUncommitted(fixture, invocation);
    }));

  it.each(["external_user", "internal_system", "inter_session"] as const)(
    "prepares command capabilities only for admitted external input: %s",
    async (kind) => {
      await withCommandPlugin(async (fixture) => {
        const params = fixture.params();
        params.ctx.InputProvenance = { kind, sourceTool: "task_suggestion" };
        const state = createPluginCommandDispatchState(params, nativeTools());
        params.opts = {
          withCommandNativeSubagents: (binding, run) =>
            runWithCommandNativeSubagents(state, binding, run),
        };
        expect(await handlePluginCommand(params, true)).toEqual(
          capabilityReply(kind === "external_user"),
        );
        expect(await fixture.userInputs()).toEqual(
          kind === "external_user" ? ["/review-panel"] : [],
        );
      });
    },
  );

  it.each([
    { name: "both tools", allow: ["read"] },
    { name: "sessions_spawn", allow: ["read", "agents_wait"] },
    { name: "agents_wait", allow: ["read", "sessions_spawn"] },
  ])("withholds the capability when real tool policy excludes $name", async ({ allow }) => {
    await withCommandPlugin(async (fixture) => {
      const invocation = commandInvocation(fixture);
      expectDefined(invocation.state.params.replyOptions, "reply authority").toolsAllow = allow;
      await expectNoCapability(fixture, invocation);
    });
  });

  it.each(["agent", "session"] as const)(
    "withholds capability for a mismatched %s binding",
    async (binding) => {
      await withCommandPlugin(async (fixture) => {
        const invocation = commandInvocation(fixture);
        if (binding === "agent") {
          invocation.state.sessionAgentId = "different-agent";
        } else {
          invocation.state.sessionKey = "agent:main:different-session";
        }
        await expectNoCapability(fixture, invocation);
      });
    },
  );

  it("lets the handler fall back without capability when command input cannot be committed", () =>
    withCommandPlugin(async (fixture) => {
      const invocation = commandInvocation(fixture);
      invocation.recorder.markBlocked();
      expect(await invocation.run()).toEqual(capabilityReply(false));
      expect(fixture.handler).toHaveBeenCalledTimes(1);
      await expectUncommitted(fixture, invocation);
    }));

  it("honors a before_tool_call veto of sessions_spawn after real command preparation", () =>
    withCommandPlugin(async (fixture) => {
      const beforeSpawn = vi.fn((event: { toolName: string }) =>
        event.toolName === "sessions_spawn"
          ? { block: true, blockReason: "Synthetic command spawn veto" }
          : undefined,
      );
      addTestHook({
        registry: fixture.registry,
        pluginId,
        hookName: "before_tool_call",
        handler: beforeSpawn,
      });
      initializeGlobalHookRunner(fixture.registry);
      const acceptedBefore = [...subagentRuns.keys()];
      fixture.handler.mockImplementation(async (ctx) => {
        const native = expectDefined(ctx.runtimeContext?.subagents, "prepared command capability");
        try {
          await native.spawn(spawnRequest);
          return { text: "unexpected child", continueAgent: true };
        } catch (error) {
          return { text: error instanceof Error ? error.message : String(error) };
        }
      });
      const invocation = commandInvocation(fixture);
      expect(await invocation.run()).toEqual(reply("Native subagent spawn was not accepted."));
      expect(beforeSpawn).toHaveBeenCalledTimes(1);
      expect(await fixture.userInputs()).toEqual(["/review-panel"]);
      expect([...subagentRuns.keys()]).toEqual(acceptedBefore);
      expect(
        await listSessionChildEntriesReadOnly({
          agentId: "main",
          sessionKey: invocation.params.sessionKey,
          storePath: invocation.params.storePath,
        }),
      ).toEqual([]);
      expect(fixture.handler).toHaveBeenCalledTimes(1);
    }));

  it("closes retained spawn and collect references when the real command invocation settles", () =>
    withCommandPlugin(async (fixture) => {
      let native: NativeSubagentRuntime | undefined;
      fixture.handler.mockImplementation((ctx) => {
        native = ctx.runtimeContext?.subagents;
        return { text: "saved" };
      });
      expect(await commandInvocation(fixture).run()).toEqual(reply("saved"));
      const retained = expectDefined(native, "retained native capability");
      await expect(retained.spawn(spawnRequest)).rejects.toSatisfy((error: unknown) =>
        String(error).includes("command invocation closed"),
      );
      await expect(retained.collect({ ids: ["child"], timeoutSeconds: 0 })).rejects.toSatisfy(
        (error: unknown) => String(error).includes("command invocation closed"),
      );
    }));

  it.each(["owner", "registry"] as const)(
    "revokes %s authority while a real admitted command awaits",
    async (change) => {
      await withCommandPlugin(async (fixture) => {
        const entered = createDeferredCore();
        const resume = createDeferredCore();
        fixture.handler.mockImplementation(async (ctx) => {
          const native = expectDefined(ctx.runtimeContext?.subagents, "native capability");
          entered.resolve();
          await resume.promise;
          try {
            await native.spawn(spawnRequest);
            return { text: "unexpected child", continueAgent: true };
          } catch (error) {
            return { text: String(error) };
          }
        });
        const acceptedBefore = [...subagentRuns.keys()];
        const pending = commandInvocation(fixture).run();
        await whilePaused(pending, entered, resume, async () => {
          changeAuthority(fixture, change);
          resume.resolve();
          const result = await pending;
          expect(result?.reply?.text).toMatch(
            change === "owner"
              ? /authority.*changed|authority.*revoked/i
              : /^Error: Plugin command runtime is no longer active\.$/,
          );
          expect(result?.shouldContinue).toBe(false);
          expect([...subagentRuns.keys()]).toEqual(acceptedBefore);
        });
      });
    },
  );

  it.each(["owner", "registry"] as const)(
    "rejects %s changes during real command preparation before entering the handler",
    async (change) => {
      await withCommandPlugin(async (fixture) => {
        const prepared = createDeferredCore();
        const release = createDeferredCore();
        const invocation = commandInvocation(fixture);
        invocation.state.assertCurrentBindingRoute = async () => {
          prepared.resolve();
          await release.promise;
        };
        const pending = invocation.run();
        await whilePaused(pending, prepared, release, async () => {
          changeAuthority(fixture, change);
          release.resolve();
          expect(await pending).toEqual(reply("⚠️ Command failed. Please try again later."));
          expect(fixture.handler).not.toHaveBeenCalled();
          await expectUncommitted(fixture, invocation);
        });
      });
    },
  );

  it("does not arm an agent restart-recovery claim while a committed command handler awaits", () =>
    withCommandPlugin(async (fixture) => {
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const invocation = commandInvocation(fixture);
      fixture.handler.mockImplementation(async (ctx) => {
        expect(ctx.runtimeContext?.subagents).toBeDefined();
        expect(await fixture.userInputs()).toEqual(["/review-panel"]);
        entered.resolve();
        await release.promise;
        return { text: "command finished" };
      });
      const pending = invocation.run();
      await whilePaused(pending, entered, release, async () => {
        const persisted = expectDefined(
          loadSessionEntry({
            agentId: "main",
            sessionKey: invocation.params.sessionKey,
            storePath: invocation.params.storePath,
          }),
          "committed requester session",
        );
        expect(hasMainSessionRecoveryClaim(persisted)).toBe(false);
        expect(invocation.recorder.getAdmissionReceipt()).toMatchObject({
          sessionId: persisted.sessionId,
        });
        release.resolve();
        expect(await pending).toEqual(reply("command finished"));
      });
    }));

  it("keeps restart-safe normal and literal Goal requests admissible with the declaring plugin loaded", () =>
    withCommandPlugin(async (fixture) => {
      initializeGlobalHookRunner(fixture.registry);
      const params = fixture.params();
      const entry = expectDefined(params.sessionEntry, "direct parent session");
      const identity = { operationId: "literal-goal", issuedAtMs: Date.now() };
      for (const goalOperation of [
        undefined,
        {
          ...identity,
          action: "start",
          requestFingerprint: "goal-start-receipt",
          objective: "/review-panel is literal Goal objective text",
        },
        {
          ...identity,
          action: "resume",
          requestFingerprint: "goal-resume-receipt",
          goalId: "literal-goal",
        },
      ] as const) {
        const request = await createRestartSafeChatRequest({
          eligible: true,
          senderIsOwner: true,
          message: goalOperation
            ? "/review-panel is literal Goal objective text"
            : "Continue the review",
          cfg: fixture.cfg,
          goalOperation,
        });
        expect(request).toBeDefined();
        expect(
          resolveRestartSafeChatAdmission({
            cfg: fixture.cfg,
            agentId: "main",
            sessionKey: params.sessionKey,
            sessionId: entry.sessionId,
            storePath: path.join(params.workspaceDir, "restart-sessions.json"),
            clientRunId: "restart-safe-request",
            context: {},
            entry,
            initialSessionEntry: entry,
            acpMeta: null,
            now: Date.now(),
            placement: undefined,
            request,
          }),
        ).toMatchObject({ requestFingerprint: request?.fingerprint });
      }
      expect(fixture.handler).not.toHaveBeenCalled();
      expect(await fixture.userInputs()).toEqual([]);
    }));
});
