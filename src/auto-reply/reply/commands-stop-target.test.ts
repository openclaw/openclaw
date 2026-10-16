// Tests stop command target resolution across active sessions and channel routes.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getActivePluginRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { resolveCommandAuthorization } from "../command-auth.js";
import { handleStopCommand } from "./commands-session-abort.js";
import { buildSessionCommandTestParams } from "./commands-session-params.test-support.js";
import type { HandleCommandsParams } from "./commands-types.js";

type AbortOutcome = ReturnType<
  ReturnType<typeof import("./abort-operation.js").prepareSessionRunTargetAbort>
>;

function outcome(active = false, aborted = false, retirement?: Promise<void>): AbortOutcome {
  return { active, aborted, retirement };
}

const abortEmbedded = vi.hoisted(() => vi.fn());
const hookEvent = vi.hoisted(() => vi.fn(() => ({})));
const persistAbort = vi.hoisted(() =>
  vi.fn<typeof import("./commands-session-store.js").persistAbortTargetEntry>(async () => true),
);
const resolveEntry = vi.hoisted(() => vi.fn(() => ({ entry: undefined, key: undefined })));
const stopChildren = vi.hoisted(() =>
  vi.fn<typeof import("./abort-operation.js").stopSubagentsForRequester>(async (params) => {
    await params.beforeKill?.(() => {});
    return { stopped: 0, failed: 0 };
  }),
);
const abortTarget = vi.hoisted(() => vi.fn<(params: unknown) => AbortOutcome>(() => outcome()));
const formatReply = vi.hoisted(() => vi.fn(() => "⚙️ Agent was aborted."));

// mock-isolation: Abort only the fixture run, never a live embedded agent.
vi.mock("../../agents/embedded-agent.js", () => ({
  abortEmbeddedAgentRun: abortEmbedded,
}));

// mock-isolation: Stop-target assertions do not depend on process-global verbose logging.
vi.mock("../../globals.js", () => ({ logVerbose: vi.fn() }));

// mock-isolation: Record hook delivery without invoking installed operator hooks.
vi.mock("../../hooks/internal-hooks.js", () => ({
  createInternalHookEvent: hookEvent,
  triggerInternalHook: vi.fn(async () => undefined),
}));

vi.mock("./abort-cutoff.js", () => ({
  resolveAbortCutoffFromContext: vi.fn(() => undefined),
  shouldPersistAbortCutoff: vi.fn(() => false),
}));

vi.mock(import("./abort-operation.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  prepareSessionRunTargetAbort: (params: unknown) =>
    Object.assign(() => abortTarget(params), {
      requestRunIds: new Set<string>(),
    }),
  stopSubagentsForRequester: stopChildren,
}));

vi.mock("./abort-trigger-text.js", () => ({ isAbortTrigger: vi.fn(() => false) }));

// mock-isolation: Do not mutate the process-global abort-memory registry.
vi.mock("./abort-primitives.js", () => ({ setAbortMemory: vi.fn() }));

// mock-isolation: Reply formatting is fixed so the test isolates target selection and effects.
vi.mock("./abort.js", () => ({ formatAbortReplyText: formatReply }));

// mock-isolation: Observe persistence calls without reading or writing operator session state.
vi.mock("./commands-session-store.js", () => ({
  persistAbortTargetEntry: persistAbort,
  resolveCommandSessionEntryForKey: resolveEntry,
}));

vi.mock("./reply-run-registry.js", () => ({
  resolveReplyOperationsForSession: vi.fn(() => []),
}));

const formatAllowFrom = ({ allowFrom }: { allowFrom: Array<string | number> }) =>
  allowFrom.map((entry) => String(entry).trim()).filter(Boolean);

function expectStoppedReply(result: Awaited<ReturnType<typeof handleStopCommand>>, text: string) {
  expect(result).toEqual({ shouldContinue: false, reply: { text } });
}

let previousPluginRegistry: ReturnType<typeof getActivePluginRegistry>;

function registerOwnerEnforcingTelegramPlugin() {
  const plugin = createOutboundTestPlugin({ id: "telegram", outbound: { deliveryMode: "direct" } });
  plugin.commands = { enforceOwnerForCommands: true };
  plugin.config = {
    listAccountIds: () => ["default"],
    resolveAccount: () => ({}),
    resolveAllowFrom: () => ["*"],
    formatAllowFrom,
  };
  setActivePluginRegistry(createTestRegistry([{ pluginId: "telegram", plugin, source: "test" }]));
}

function buildStopParams(): HandleCommandsParams {
  return buildSessionCommandTestParams(
    {
      commandBodyNormalized: "/stop",
      rawBodyNormalized: "/stop",
      isAuthorizedSender: true,
      senderIsOwner: true,
      senderId: "owner",
      channel: "telegram",
      surface: "telegram",
      ownerList: [],
    },
    {
      cfg: { commands: { text: true }, channels: { telegram: { allowFrom: ["*"] } } },
      ctx: {
        Provider: "telegram",
        Surface: "telegram",
        CommandSource: "text",
        CommandTargetSessionKey: "agent:target:telegram:direct:123",
      },
      sessionKey: "agent:main:telegram:slash-session",
      sessionEntry: { sessionId: "wrapper-session-id", updatedAt: Date.now() },
      sessionStore: {},
      storePath: "/tmp/sessions.json",
    },
  );
}

describe("handleStopCommand target fallback", () => {
  beforeEach(() => {
    previousPluginRegistry = getActivePluginRegistry();
    vi.clearAllMocks();
    abortTarget.mockReturnValue(outcome());
    persistAbort.mockResolvedValue(true);
  });

  afterEach(() => {
    if (previousPluginRegistry) {
      setActivePluginRegistry(previousPluginRegistry);
    } else {
      resetPluginRuntimeStateForTest();
    }
  });

  it("does not fall back to the wrapper session when a distinct target session is missing from store", async () => {
    const params = buildStopParams();

    const result = await handleStopCommand(params, true);

    expectStoppedReply(result, "⚙️ Agent was aborted.");
    expect(abortTarget).toHaveBeenCalledWith({
      agentId: "target",
      key: "agent:target:telegram:direct:123",
      sessionId: undefined,
    });
    expect(abortEmbedded).not.toHaveBeenCalledWith("wrapper-session-id");
    const persistAbortTargetParams = persistAbort.mock.calls[0]?.[0];
    expect(persistAbortTargetParams).toMatchObject({
      key: "agent:target:telegram:direct:123",
      entry: undefined,
      storePath: "/tmp/sessions.json",
    });
    expect(persistAbortTargetParams?.sessionStore).toBe(params.sessionStore);
    const stopSubagentsParams = stopChildren.mock.calls[0]?.[0];
    expect(stopSubagentsParams?.cfg).toBe(params.cfg);
    expect(stopSubagentsParams?.requesterSessionKey).toBe("agent:target:telegram:direct:123");
    expect(hookEvent).toHaveBeenCalledWith("command", "stop", "agent:target:telegram:direct:123", {
      sessionEntry: undefined,
      sessionId: undefined,
      commandSource: "telegram",
      senderId: "owner",
    });
  });

  it.each([
    ["finalizing", "Agent reply is already finalizing and can no longer be aborted.", 0],
    [
      "child stop failures",
      "⚙️ Agent was aborted. One sub-agent could not be stopped. Retry /stop.",
      1,
    ],
  ] as const)("reports %s in the stop reply", async (_name, text, failed) => {
    if (failed) {
      stopChildren.mockResolvedValueOnce({ stopped: 0, failed });
    } else {
      abortTarget.mockReturnValue(outcome(true));
    }
    formatReply.mockReturnValueOnce(text);
    expectStoppedReply(await handleStopCommand(buildStopParams(), true), text);
    expect(formatReply).toHaveBeenCalledWith(0, failed ? undefined : "finalizing", failed);
    if (!failed) {
      expect(persistAbort).not.toHaveBeenCalled();
    }
  });

  it.each([false, true])(
    "joins cleanup without granting rejected cancellation authority (accepted=%s)",
    async (accepted) => {
      const params = buildStopParams();
      const cleanupError = new Error("parent cancellation failed");
      const descendantError = new Error("descendant cancellation failed");
      const descendantCancellation = vi.fn(() => {
        throw descendantError;
      });
      abortTarget.mockReturnValueOnce(outcome(true, accepted, Promise.reject(cleanupError)));
      stopChildren.mockImplementationOnce(async (request) => {
        await request.beforeKill?.(() => {});
        descendantCancellation();
        return { stopped: 0, failed: 0 };
      });

      const stopping = handleStopCommand(params, true);
      if (accepted) {
        await expect(stopping).rejects.toMatchObject({ errors: [descendantError, cleanupError] });
        expect(descendantCancellation).toHaveBeenCalledOnce();
      } else {
        await expect(stopping).rejects.toBe(cleanupError);
        expect(descendantCancellation).not.toHaveBeenCalled();
      }
    },
  );

  it("rejects native stop commands from non-owner senders when the plugin enforces owner-only commands", async () => {
    registerOwnerEnforcingTelegramPlugin();
    const params = buildStopParams();
    params.cfg.commands = { text: true, allowFrom: { "*": ["*"] } };
    params.ctx = {
      ...params.ctx,
      ChatType: "group",
      From: "telegram:999",
      SenderId: "999",
      CommandSource: "native",
    };
    const auth = resolveCommandAuthorization({
      ctx: params.ctx,
      cfg: params.cfg,
      commandAuthorized: true,
    });
    params.command.senderId = auth.senderId;
    params.command.senderIsOwner = auth.senderIsOwner;
    params.command.isAuthorizedSender = auth.isAuthorizedSender;
    params.command.from = auth.from;
    params.command.to = auth.to;

    const result = await handleStopCommand(params, true);

    expect(auth).toMatchObject({ senderIsOwner: false, isAuthorizedSender: false });
    expectStoppedReply(result, "You are not authorized to use this command.");
    expect(abortTarget).not.toHaveBeenCalled();
    expect(persistAbort).not.toHaveBeenCalled();
    expect(hookEvent).not.toHaveBeenCalled();
    expect(stopChildren).not.toHaveBeenCalled();
  });
});
