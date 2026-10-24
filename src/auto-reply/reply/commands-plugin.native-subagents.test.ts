import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it as baseIt, vi } from "vitest";
import { subagentRuns } from "../../agents/subagents/registry/subagent-registry-memory.js";
import { withAdminIngress } from "../../channels/message-access/operator-authority.test-support.js";
import { hasMainSessionRecoveryClaim } from "../../config/sessions/restart-recovery-state.js";
import {
  listSessionChildEntriesReadOnly,
  loadSessionEntry,
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
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
};
const declaredCommand: CommandMetadata = {
  name: "review-panel",
  requireAuth: true,
  runtimeCapabilities: ["subagents"],
};

type Fixture = {
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
      `module.exports = { id: ${JSON.stringify(pluginId)}, register(api) {
        for (const command of ${JSON.stringify(commands)}) {
          api.registerCommand({ ...command, description: "Synthetic review command", acceptsArgs: true,
            handler(ctx) { return globalThis[Symbol.for(${JSON.stringify(Symbol.keyFor(bridge))})](ctx); }
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

const it = baseIt.extend<{ fixture: Fixture }>({
  fixture: async ({ task: _task }, use) => withCommandPlugin(use),
});

describe("command-scoped native subagent boundary", () => {
  baseIt.each<[string, Partial<CommandMetadata>, string, unknown?]>([
    ["missing manifest grant", {}, "commandRuntimeCapabilities", []],
    ["public command", { requireAuth: false }, "requireAuth"],
    ["implicit authorization", { requireAuth: undefined }, "requireAuth"],
    ["unknown capability", { runtimeCapabilities: ["unknown-capability"] }, "runtimeCapabilities"],
    ["malformed capability", { runtimeCapabilities: "subagents" }, "runtimeCapabilities"],
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
        { commands: [{ ...declaredCommand, ...command }], manifestCapabilities },
      );
    },
  );

  it("rejects a direct registrar borrowing the loaded plugin's grant", async ({ fixture }) => {
    expect(select("/review-panel")).not.toBeNull();
    const spoofed = registerPluginCommand(pluginId, {
      name: "spoofed-review",
      description: "Caller-supplied plugin ID is not an admitted manifest",
      requireAuth: true,
      runtimeCapabilities: ["subagents"],
      handler: fixture.handler,
    });
    expect(spoofed).toMatchObject({ ok: false });
    expect(spoofed.error).toContain("commandRuntimeCapabilities");
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
  });

  it("withholds native runtime from ordinary and legacy command paths", async ({ fixture }) => {
    expect(await commandInvocation(fixture, "/ordinary /review-panel").run()).toEqual(
      capabilityReply(false, "/review-panel"),
    );
    // Older command surfaces cannot obtain authority from an ambient hook facade.
    expect(await handlePluginCommand(fixture.params(), true)).toEqual(capabilityReply(false));
    expect(await fixture.userInputs()).toEqual([]);
  });

  it.for(["> /review-panel", "/foreign /review-panel"])(
    "does not turn quoted or foreign text into a native command: %s",
    async (body, { fixture }) => {
      expect(select(body)).toBeNull();
      expect(await commandInvocation(fixture, body).run()).toBeNull();
      expect(fixture.handler).not.toHaveBeenCalled();
      expect(await fixture.userInputs()).toEqual([]);
    },
  );

  it.for(["external_user", "internal_system"] as const)(
    "prepares command capabilities only for admitted external input: %s",
    async (kind, { fixture }) => {
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
      expect(await fixture.userInputs()).toEqual(kind === "external_user" ? ["/review-panel"] : []);
    },
  );

  it.for(["both", "sessions_spawn", "agents_wait", "agent", "session", "commit"] as const)(
    "withholds native capability after a failed %s gate",
    async (gate, { fixture }) => {
      const invocation = commandInvocation(fixture);
      if (gate === "agent") {
        invocation.state.sessionAgentId = "different-agent";
      } else if (gate === "session") {
        invocation.state.sessionKey = "agent:main:different-session";
      } else if (gate === "commit") {
        invocation.recorder.markBlocked();
      } else {
        expectDefined(invocation.state.params.replyOptions, "reply authority").toolsAllow =
          nativeTools().filter((tool) => (gate === "both" ? tool === "read" : tool !== gate));
      }
      await expectNoCapability(fixture, invocation);
      expect(fixture.handler).toHaveBeenCalledTimes(1);
    },
  );

  it("honors a spawn hook veto after command preparation", async ({ fixture }) => {
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
    expect(beforeSpawn).toHaveBeenCalledOnce();
    expect(await fixture.userInputs()).toEqual(["/review-panel"]);
    expect([...subagentRuns.keys()]).toEqual(acceptedBefore);
    expect(
      await listSessionChildEntriesReadOnly({
        agentId: "main",
        sessionKey: invocation.params.sessionKey,
        storePath: invocation.params.storePath,
      }),
    ).toEqual([]);
  });

  it("closes retained spawn and collect references on settlement", async ({ fixture }) => {
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
  });

  it.for([
    ["owner", "preparation"],
    ["registry", "preparation"],
    ["owner", "handler"],
    ["registry", "handler"],
  ] as const)("revokes %s authority during %s", async ([change, phase], { fixture }) => {
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const pause = async () => {
      entered.resolve();
      await release.promise;
    };
    const invocation = commandInvocation(fixture);
    if (phase === "preparation") {
      invocation.state.assertCurrentBindingRoute = pause;
    } else {
      fixture.handler.mockImplementation(async (ctx) => {
        const native = expectDefined(ctx.runtimeContext?.subagents, "native capability");
        await pause();
        return native.spawn(spawnRequest).then(
          () => ({ text: "unexpected child", continueAgent: true }),
          (error: unknown) => ({ text: String(error) }),
        );
      });
    }
    const acceptedBefore = [...subagentRuns.keys()];
    const pending = invocation.run();
    await whilePaused(pending, entered, release, async () => {
      changeAuthority(fixture, change);
      release.resolve();
      const result = await pending;
      if (phase === "preparation") {
        expect(result).toEqual(reply("⚠️ Command failed. Please try again later."));
        expect(fixture.handler).not.toHaveBeenCalled();
        await expectUncommitted(fixture, invocation);
      } else {
        expect(result?.reply?.text).toMatch(
          change === "owner"
            ? /authority.*changed|authority.*revoked/i
            : /^Error: Plugin command runtime is no longer active\.$/,
        );
        expect(result?.shouldContinue).toBe(false);
      }
      expect([...subagentRuns.keys()]).toEqual(acceptedBefore);
    });
  });

  it("does not arm recovery while a committed command awaits", async ({ fixture }) => {
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
  });
});
