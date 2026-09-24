// Tests get-reply config override handling for a single inbound turn.
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createAdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import type { PreparedReplyDispatchRuntime } from "../../agents/prepared-model-runtime.js";
import { withAdminIngress } from "../../channels/message-access/operator-authority.test-support.js";
import type { OpenClawConfig } from "../../config/config.js";
import { SessionWorkStartInvalidatedError } from "../../config/sessions/lifecycle.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { createSessionDiffBaselineCaptureClaim } from "../../config/sessions/session-diff-baseline-capture.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { setUserProfileRole } from "../../state/user-profiles.js";
import { resolveCommandAuthorization } from "../command-auth.js";
import { resolveDirectHumanRequesterProfileId } from "../command-owner-authority.js";
import {
  buildGetReplyCtx,
  createGetReplyContinueDirectivesResult,
  createGetReplySessionState,
  expectResolvedTelegramTimezone,
  registerGetReplyRuntimeOverrides,
} from "./get-reply.test-fixtures.js";
import "./get-reply.test-runtime-mocks.js";
import type { InternalGetReplyOptions } from "./get-reply.types.js";
import { bindPreparedReplyDispatchRuntime } from "./prepared-reply-dispatch-context.js";
import {
  REPLY_OPERATION_RUN_STATE,
  type ReplyOperationRunState,
} from "./reply-operation-run-state.js";
import { SessionResetCleanupError } from "./session-reset-cleanup.js";

type CaptureSessionDiffBaseline =
  (typeof import("../../sessions/session-diff.js"))["captureSessionDiffBaseline"];
const mocks = vi.hoisted(() => ({
  captureSessionDiffBaseline: vi.fn<CaptureSessionDiffBaseline>(),
  resolveReplyDirectives: vi.fn(),
  initSessionState: vi.fn(),
}));
vi.mock("../../sessions/session-diff.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../sessions/session-diff.js")>()),
  captureSessionDiffBaseline: mocks.captureSessionDiffBaseline,
}));
vi.mock("./commands.runtime.js", () => ({
  handleCommands: vi.fn(async () => ({ shouldContinue: true })),
}));
registerGetReplyRuntimeOverrides(mocks);

let getReplyFromConfig: typeof import("../../plugin-sdk/reply-runtime.js").getReplyFromConfig;
let loadConfigMock: typeof import("../../config/config.js").getRuntimeConfig;
let runPreparedReplyMock: typeof import("./get-reply-run.js").runPreparedReply;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function loadGetReplyRuntimeForTest() {
  ({ getReplyFromConfig } = await import("../../plugin-sdk/reply-runtime.js"));
  ({ getRuntimeConfig: loadConfigMock } = await import("../../config/config.js"));
  ({ runPreparedReply: runPreparedReplyMock } = await import("./get-reply-run.js"));
}

async function prepareBaselineClaimSession(sessionId: string) {
  const sessionKey = `agent:main:telegram:${sessionId}`;
  const storePath = path.join(tempDirs.make("openclaw-get-reply-baseline-"), "sessions.json");
  const entry: InternalSessionEntry = {
    createdVia: "operator",
    sessionId,
    sessionDiffBaselineCapture: createSessionDiffBaselineCaptureClaim(),
    updatedAt: Date.now(),
  };
  await replaceSessionEntry({ sessionKey, storePath }, entry);
  const sessionEntryHandle = { replaceCurrent: vi.fn() };
  mocks.initSessionState.mockResolvedValueOnce(
    createGetReplySessionState({
      initialSessionEntry: entry,
      sessionEntry: entry,
      sessionEntryHandle,
      sessionId,
      sessionKey,
      sessionStore: { [sessionKey]: entry },
      storePath,
    }),
  );
  const ctx = buildGetReplyCtx({
    Body: "run after capture",
    BodyForAgent: "run after capture",
    RawBody: "run after capture",
    CommandBody: "run after capture",
    SessionKey: sessionKey,
  });
  mocks.resolveReplyDirectives.mockResolvedValueOnce(
    createGetReplyContinueDirectivesResult({
      body: "run after capture",
      abortKey: sessionKey,
      from: ctx.From ?? "telegram:user:42",
      to: ctx.To ?? "telegram:123",
      senderId: ctx.SenderId ?? "user:42",
      commandSource: "message",
      senderIsOwner: true,
      resetHookTriggered: false,
    }),
  );
  return { ctx, sessionEntryHandle, sessionKey, storePath };
}

function createPreparedDispatchRuntime(
  overrides: Partial<PreparedReplyDispatchRuntime> = {},
): PreparedReplyDispatchRuntime {
  return Object.freeze({
    agentId: "main",
    agentDir: "/tmp/prepared-model-owner",
    workspaceDir: "/tmp/prepared-model-workspace",
    config: {
      channels: { telegram: { botToken: "resolved-telegram-token" } },
      agents: {
        defaults: { userTimezone: "America/New_York" },
        list: [{ id: "main", default: true }],
      },
    },
    modelCatalog: { entries: [], routeVariants: [] },
    inboundPluginRegistry: createEmptyPluginRegistry(),
    pluginGeneration: {} as never,
    ...overrides,
  });
}

describe("getReplyFromConfig configOverride", () => {
  beforeEach(async () => {
    await loadGetReplyRuntimeForTest();
    vi.stubEnv("OPENCLAW_ALLOW_SLOW_REPLY_TESTS", "1");
    mocks.resolveReplyDirectives.mockReset();
    mocks.initSessionState.mockReset();
    mocks.captureSessionDiffBaseline.mockReset();
    vi.mocked(loadConfigMock).mockReset();
    vi.mocked(runPreparedReplyMock).mockReset();

    vi.mocked(loadConfigMock).mockReturnValue({});
    mocks.resolveReplyDirectives.mockResolvedValue({ kind: "reply", reply: { text: "ok" } });
    const sessionKey = "agent:main:telegram:123";
    const storePath = path.join(tempDirs.make("openclaw-get-reply-session-"), "sessions.json");
    const entry: InternalSessionEntry = {
      sessionId: "session-1",
      updatedAt: Date.now(),
    };
    await replaceSessionEntry({ sessionKey, storePath }, entry);
    mocks.initSessionState.mockResolvedValue(
      createGetReplySessionState({
        initialSessionEntry: entry,
        sessionEntry: entry,
        sessionEntryHandle: { replaceCurrent: vi.fn() },
        sessionKey,
        sessionStore: { [sessionKey]: entry },
        storePath,
      }),
    );
    mocks.captureSessionDiffBaseline.mockImplementation(async ({ sessionId }) => ({
      version: 1,
      sessionId,
      root: "/workspace",
      files: [],
    }));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("rejects forged operator authority at the public SDK reply entry", async () => {
    const assertCurrent = vi.fn();
    const plain = { profileId: "guest", scopes: ["operator.admin"], assertCurrent };
    const issued = createAdmittedRunOperatorAuthority(plain);
    for (const operatorAuthority of [plain, { ...issued }]) {
      const options = { runId: "forged-operator", operatorAuthority };
      await expect(getReplyFromConfig(buildGetReplyCtx(), options, {})).rejects.toThrow(
        "operator run authority must be issued by the host",
      );
    }
    expect(assertCurrent).not.toHaveBeenCalled();
    expect(loadConfigMock).not.toHaveBeenCalled();
    expect(mocks.initSessionState).not.toHaveBeenCalled();
    expect(runPreparedReplyMock).not.toHaveBeenCalled();
  });

  it("preserves linked people and their ceilings for configured command owners at the public reply entry", async () => {
    await withAdminIngress(async ({ cfg, admins, context }) => {
      setUserProfileRole(admins[1]!.profile.id, "member");
      for (const [senderId, profileId, scopes] of [
        ["100", admins[0]!.profile.id, ["operator.admin"]],
        ["101", admins[1]!.profile.id, ["operator.read", "operator.write"]],
        ["unlinked", undefined, undefined],
      ] as const) {
        cfg.commands!.ownerAllowFrom = [`discord:${senderId}`];
        const ctx = await context(senderId);
        expect(
          resolveCommandAuthorization({ cfg, ctx, commandAuthorized: true }).senderIsOwner,
        ).toBe(true);
        let authority: InternalGetReplyOptions["operatorAuthority"];
        let directHumanRequesterProfileId: string | undefined;
        mocks.resolveReplyDirectives.mockImplementationOnce(
          ({ opts }: { opts?: InternalGetReplyOptions }) => {
            authority = opts?.operatorAuthority;
            authority?.assertCurrent();
            directHumanRequesterProfileId = resolveDirectHumanRequesterProfileId(ctx, authority);
            return { kind: "reply", reply: { text: authority?.profileId ?? "unlinked" } };
          },
        );
        await expect(getReplyFromConfig(ctx, undefined, cfg)).resolves.toEqual({
          text: profileId ?? "unlinked",
        });
        expect(authority?.scopes).toEqual(scopes);
        expect(directHumanRequesterProfileId).toBe(profileId);
        expect(authority?.requesterChannelIdentity).toEqual(
          profileId ? { channelId: "discord", accountId: "team", senderId } : undefined,
        );
        if (authority) {
          expect(() => authority!.assertCurrent()).toThrow(
            "operator execution authority is no longer active",
          );
        }
      }
    });
  });

  it.each(["agent", "sandbox", "access", "scope"] as const)(
    "rejects a linked channel request outside its %s policy before reply preparation",
    async (boundary) => {
      await withAdminIngress(async ({ cfg, context }) => {
        cfg.commands!.ownerAllowFrom = ["discord:100"];
        const role = cfg.gateway!.roles!.definitions.admin!;
        if (boundary === "agent") {
          role.agents = ["other-agent"];
        } else if (boundary === "sandbox") {
          role.sandbox = "required";
        } else if (boundary === "access") {
          role.accessPolicyPlugin = "unavailable-person-policy";
        } else {
          role.scopes = ["operator.read"];
        }
        await expect(
          context("100").then((ctx) => getReplyFromConfig(ctx, undefined, cfg)),
        ).rejects.toThrow(
          boundary === "agent"
            ? "cannot create sessions for agent"
            : boundary === "sandbox"
              ? "requires a sandboxed session"
              : boundary === "access"
                ? "Gateway access is no longer active"
                : "cannot start an agent run",
        );
        expect(mocks.initSessionState).not.toHaveBeenCalled();
        expect(mocks.resolveReplyDirectives).not.toHaveBeenCalled();
      });
    },
  );

  it("pins the issued operator source once through public reply option copies", async () => {
    const issued = createAdmittedRunOperatorAuthority({
      profileId: "guest",
      scopes: ["operator.write"],
      assertCurrent: () => {},
    });
    let reads = 0;
    const options = {
      runId: "issued-operator",
      get operatorAuthority() {
        reads += 1;
        return reads === 1 ? issued : { ...issued, scopes: ["operator.admin"] };
      },
    };
    await expect(getReplyFromConfig(buildGetReplyCtx(), options, {})).resolves.toEqual({
      text: "ok",
    });
    expect(reads).toBe(1);
    expect(mocks.resolveReplyDirectives).toHaveBeenCalledWith(
      expect.objectContaining({ opts: expect.objectContaining({ operatorAuthority: issued }) }),
    );
  });

  it("merges configOverride over fresh getRuntimeConfig()", async () => {
    vi.mocked(loadConfigMock).mockReturnValue({
      channels: {
        telegram: {
          botToken: "resolved-telegram-token",
        },
      },
      agents: {
        defaults: {
          userTimezone: "UTC",
        },
      },
    } satisfies OpenClawConfig);

    await getReplyFromConfig(buildGetReplyCtx(), undefined, {
      agents: {
        defaults: {
          userTimezone: "America/New_York",
        },
      },
    } as OpenClawConfig);

    expectResolvedTelegramTimezone(mocks.resolveReplyDirectives);
  });

  it("settles a precreated baseline claim before reply execution", async () => {
    const sessionId = "precreated-get-reply";
    const { ctx, sessionEntryHandle, sessionKey, storePath } =
      await prepareBaselineClaimSession(sessionId);
    vi.mocked(runPreparedReplyMock).mockImplementationOnce(async () => {
      expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
        sessionDiffBaseline: { version: 1, sessionId, root: "/workspace" },
      });
      return { text: "ok" };
    });

    await getReplyFromConfig(ctx, undefined, {});

    expect(mocks.captureSessionDiffBaseline).toHaveBeenCalledOnce();
    expect(sessionEntryHandle.replaceCurrent).toHaveBeenCalledWith(
      expect.objectContaining({ sessionDiffBaseline: expect.objectContaining({ sessionId }) }),
    );
  });

  it("reports reset cleanup failure without starting the reply", async () => {
    const message = "Reset did not complete. Inspect remaining tasks and retry /reset.";
    mocks.initSessionState.mockRejectedValueOnce(new SessionResetCleanupError(message));
    const runState: ReplyOperationRunState = {};
    const opts: InternalGetReplyOptions = { [REPLY_OPERATION_RUN_STATE]: runState };
    await expect(getReplyFromConfig(buildGetReplyCtx(), opts, {})).resolves.toEqual({
      text: message,
    });
    expect(runState.preRunRejection).toBe("session-directive-rejected");
    expect(runPreparedReplyMock).not.toHaveBeenCalled();
  });

  it("rethrows baseline work-start invalidation before reply execution", async () => {
    const { ctx } = await prepareBaselineClaimSession("invalidated-get-reply");
    mocks.captureSessionDiffBaseline.mockRejectedValueOnce(
      new SessionWorkStartInvalidatedError("session changed during baseline capture"),
    );

    await expect(getReplyFromConfig(ctx, undefined, {})).rejects.toBeInstanceOf(
      SessionWorkStartInvalidatedError,
    );
    expect(runPreparedReplyMock).not.toHaveBeenCalled();
  });

  it("continues the reply flow after an ordinary baseline capture failure", async () => {
    const { ctx, sessionKey, storePath } = await prepareBaselineClaimSession(
      "failed-get-reply-capture",
    );
    mocks.captureSessionDiffBaseline.mockRejectedValueOnce(new Error("git capture failed"));
    vi.mocked(runPreparedReplyMock).mockResolvedValueOnce({ text: "ok" });

    await expect(getReplyFromConfig(ctx, undefined, {})).resolves.toEqual({ text: "ok" });
    expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
      sessionDiffBaselineCapture: { status: "unavailable" },
    });
  });

  it("uses complete configOverride without reloading config", async () => {
    const { withFullRuntimeReplyConfig } = await import("./get-reply-fast-path.js");
    vi.mocked(loadConfigMock).mockImplementation(() => {
      throw new Error("getRuntimeConfig should not be called for complete runtime config");
    });

    const conflictingRuntime = createPreparedDispatchRuntime();
    await bindPreparedReplyDispatchRuntime(conflictingRuntime, getReplyFromConfig)(
      buildGetReplyCtx(),
      undefined,
      withFullRuntimeReplyConfig({
        channels: {
          telegram: {
            botToken: "resolved-telegram-token",
          },
        },
        agents: {
          defaults: {
            userTimezone: "America/New_York",
          },
        },
      } satisfies OpenClawConfig),
    );

    expect(loadConfigMock).not.toHaveBeenCalled();
    expectResolvedTelegramTimezone(mocks.resolveReplyDirectives);
    expect(mocks.resolveReplyDirectives).toHaveBeenCalledWith(
      expect.objectContaining({
        agentDir: expect.not.stringMatching(/prepared-model-owner/),
        preparedModelCatalog: undefined,
      }),
    );
  });

  it.each([false, true])(
    "uses the admitted catalog through the SDK resolver (native=%s)",
    async (native) => {
      const preparedRuntime = createPreparedDispatchRuntime();
      vi.mocked(loadConfigMock).mockImplementation(() => {
        throw new Error("getRuntimeConfig should not be called for a prepared Gateway dispatch");
      });

      await bindPreparedReplyDispatchRuntime(
        preparedRuntime,
        getReplyFromConfig,
      )(
        buildGetReplyCtx(
          native
            ? {
                Body: "/model ollama/picker-secondary -s",
                RawBody: "/model ollama/picker-secondary -s",
                CommandBody: "/model ollama/picker-secondary -s",
                CommandSource: "native",
                CommandAuthorized: true,
                CommandTargetSessionKey: "agent:main:telegram:123",
              }
            : {},
        ),
      );

      expect(loadConfigMock).not.toHaveBeenCalled();
      expectResolvedTelegramTimezone(mocks.resolveReplyDirectives);
      expect(mocks.resolveReplyDirectives).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: "main",
          agentDir: "/tmp/prepared-model-owner",
          workspaceDir: "/tmp/prepared-model-workspace",
          preparedModelCatalog: preparedRuntime.modelCatalog,
        }),
      );
    },
  );

  it("rejects a prepared dispatch runtime that crosses the admitted session agent", async () => {
    const preparedRuntime = createPreparedDispatchRuntime({
      agentId: "worker",
      config: { agents: { list: [{ id: "worker", default: true }] } },
    });

    await expect(
      bindPreparedReplyDispatchRuntime(preparedRuntime, getReplyFromConfig)(buildGetReplyCtx()),
    ).rejects.toThrow("reply model catalog owner changed from main to worker");
  });

  it("marks a frozen complete config without changing its identity or own keys", async () => {
    const { withFullRuntimeReplyConfig } = await import("./get-reply-fast-path.js");
    const cfg = Object.freeze({
      agents: { defaults: { userTimezone: "America/New_York" } },
      channels: { telegram: { botToken: "resolved-telegram-token" } },
    } satisfies OpenClawConfig);
    const ownKeys = Reflect.ownKeys(cfg);
    vi.mocked(loadConfigMock).mockImplementation(() => {
      throw new Error("getRuntimeConfig should not be called for complete runtime config");
    });

    const marked = withFullRuntimeReplyConfig(cfg);
    await getReplyFromConfig(buildGetReplyCtx(), undefined, marked);

    expect(marked).toBe(cfg);
    expect(Reflect.ownKeys(cfg)).toEqual(ownKeys);
    expect(loadConfigMock).not.toHaveBeenCalled();
    expectResolvedTelegramTimezone(mocks.resolveReplyDirectives);
  });
});
