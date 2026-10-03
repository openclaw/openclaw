import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { prepareSystemAgentRunAdmission } from "../agents/admitted-run-context.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../agents/tools/gateway-caller-context.js";
import {
  callInProcessGatewayTool,
  callInProcessGatewayToolWithCreation,
} from "../agents/tools/in-process-gateway.js";
import { createSessionsCreateTool } from "../agents/tools/sessions-create-tool.js";
import { maybeSpawnVisibleSession } from "../agents/tools/sessions-spawn-visible.js";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import {
  listSessionEntryKeysReadOnly,
  loadSessionEntry,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { prepareCronRunAdmission } from "../cron/run-admission.js";
import {
  bindGatewayContextResolver,
  withPluginRuntimeGatewayRequestScope,
} from "../plugins/runtime/gateway-request-scope.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  createCoreGatewayMethodDescriptors,
  createGatewayMethodRegistry,
} from "./methods/registry.js";
import { captureGatewayOperatorRunAuthority } from "./operator-run-authority.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import { readGatewayRequestMutationAuthority } from "./server-methods/session-mutation-guards.js";
import { sessionCreateHandlers } from "./server-methods/sessions-create.js";
import type { GatewayRequestHandlerOptions } from "./server-methods/types.js";
import type { TrustedSessionCreation } from "./session-creation-provenance.js";
import { roleClient } from "./session-sharing.test-utils.js";

const kickoff = vi.hoisted(() => ({ internal: vi.fn(), external: vi.fn() }));
vi.mock("./server-methods/chat-send-handler.js", () => ({
  handleTrustedInternalChatSend: kickoff.internal,
}));

const parentKey = "agent:main:scope-parent";
const childKey = "agent:main:dashboard:scope-child";

// These tests own spawn admission and persisted permissions, not model availability
// or inference. The router and SQLite creation owner below are never replaced.
vi.mock("../agents/subagents/spawn/subagent-spawn.runtime.js", () => ({
  prepareModelChoice: async () => ({
    kind: "resolved",
    ref: { provider: "test-provider", model: "scope-model" },
    model: { id: "scope-model", provider: "test-provider" },
  }),
}));
vi.mock("./server-methods/chat-send-external-entry.js", () => ({
  handleDirectExternalChatSend: async (options: GatewayRequestHandlerOptions) => {
    kickoff.external(options);
    options.respond(true, { status: "started", runId: "scope-child-run" });
  },
}));

async function withHostedCreation(
  run: (fixture: {
    tool: ReturnType<typeof createSessionsCreateTool>;
    toolCreate: (
      params?: Record<string, unknown>,
      toolCallId?: string,
      signal?: AbortSignal,
    ) => ReturnType<NonNullable<ReturnType<typeof createSessionsCreateTool>>["execute"]>;
    create: (
      params?: Record<string, unknown>,
      creation?: Partial<TrustedSessionCreation>,
    ) => Promise<{ key: string; sessionId: string }>;
    spawn: (
      mode: SessionEntry["permissionMode"],
      agentId?: string,
    ) => ReturnType<typeof maybeSpawnVisibleSession>;
    read: (key?: string, agentId?: string) => ReturnType<typeof loadSessionEntry>;
    keys: () => Promise<string[]>;
    seedForeign: () => Promise<void>;
    send: (key: string) => Promise<unknown>;
    chatHandler: ReturnType<typeof vi.fn>;
    handler: ReturnType<typeof vi.fn<(options: GatewayRequestHandlerOptions) => Promise<void>>>;
    beforeCreate: ReturnType<typeof vi.fn<() => Promise<void>>>;
    revoke: () => void;
    profileId: string;
  }) => Promise<void>,
  source: "operator" | "unidentified" | "scheduled" = "operator",
) {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    kickoff.internal
      .mockReset()
      .mockImplementation(async (options: GatewayRequestHandlerOptions) => {
        options.respond(true, { status: "started", runId: "scope-independent-run" });
      });
    kickoff.external.mockClear();
    const storePath = state.path("sessions.json");
    const cfg: OpenClawConfig = {
      session: { store: storePath },
      agents: {
        defaults: {
          workspace: state.workspaceDir,
          subagents: { allowAgents: ["main", "reviewer"] },
        },
        entries: { main: {}, reviewer: {} },
      },
      gateway: {
        roles: {
          default: "view",
          definitions: {
            view: {
              agents: ["main"],
              scopes: ["operator.sessions.write"],
              sessions: { others: "none" },
              sandbox: "required",
            },
          },
        },
      },
    };
    await state.writeConfig(cfg);
    setRuntimeConfigSnapshot(cfg);
    const client = roleClient("view", "native-session-scope");
    client.connect.scopes = ["operator.sessions.write"];
    const profileId = expectDefined(client.authenticatedUserProfile, "original person").profileId;
    const parentScope = { agentId: "main", sessionKey: parentKey, storePath };
    const childScope = { ...parentScope, sessionKey: childKey };
    await upsertSessionEntryCore(parentScope, {
      sessionId: "scope-parent-session",
      updatedAt: 1,
      sandbox: "required",
      permissionMode: "full",
      ...(source === "scheduled"
        ? {}
        : { createdActor: { type: "human" as const, source: "profile" as const, id: profileId } }),
    });
    expect(loadSessionEntry(parentScope)?.sessionId).toBe("scope-parent-session");
    const context = createDirectChatContext({
      getRuntimeConfig: () => cfg,
      loadGatewayModelCatalog: async () => [
        { id: "scope-model", name: "Scope model", provider: "test-provider" },
      ],
    });
    context.resolveGatewayContext = () => context;
    const sourceController = new AbortController();
    const captured =
      source === "operator"
        ? expectDefined(
            await captureGatewayOperatorRunAuthority({
              client,
              context,
              sourceAuthority: {
                signal: sourceController.signal,
                assertCurrent: () => sourceController.signal.throwIfAborted(),
              },
            }),
            "original source",
          )
        : undefined;
    const scheduled =
      source === "scheduled"
        ? prepareCronRunAdmission({
            deliveryAttemptFence: { beforeAttempt: async () => {}, assertCurrent: () => {} },
            cfg,
            runId: "scope-parent-run",
            agentId: "main",
            sessionId: "scope-parent-session",
            sessionKey: parentKey,
            jobId: "scope-test-job",
          })
        : undefined;
    const parent =
      scheduled?.preparedRunAdmission ??
      prepareSystemAgentRunAdmission(
        cfg,
        "scope-parent-run",
        "main",
        "scope-test",
        undefined,
        captured?.authority,
      );
    const admitted = await parent.admit("embedded");
    bindGatewayContextResolver(admitted, () => context);
    const caller = expectDefined(
      createAdmittedGatewayToolCallerIdentity({
        admittedRunContext: admitted,
        agentId: "main",
        sessionKey: parentKey,
        approvalSignals: [sourceController.signal],
      }),
      "hosted caller",
    );
    const beforeCreate = vi.fn(async () => {});
    const handler = vi.fn(async (options: GatewayRequestHandlerOptions) => {
      // Observe the real router admission, then call the real SQLite creation owner.
      expect(options.client?.internal?.syntheticClient).toBe(true);
      expect(options.client?.connect.scopes).not.toContain("operator.admin");
      if (source === "operator") {
        expect(options.client?.connect.scopes).toEqual(["operator.sessions.write"]);
        expect(readGatewayRequestMutationAuthority(options).sessionScope).toBe(
          "operator.sessions.write",
        );
        const original = expectDefined(captured, "original source").authority;
        expect(options.client?.internal?.operatorRunAuthority?.source).toBe(original.source);
        expect(options.client?.internal?.operatorRoleActor).toEqual({
          kind: "operator",
          profileId,
        });
      } else {
        expect(options.client?.internal?.operatorRunAuthority).toBeUndefined();
        expect(options.client?.internal?.operatorRoleActor).toEqual({ kind: "system" });
      }
      await beforeCreate();
      await expectDefined(sessionCreateHandlers["sessions.create"], "creation owner")(options);
    });
    const chatHandler = vi.fn(async (options: GatewayRequestHandlerOptions) => {
      options.sessionMutationAuthorization?.assertCurrent();
      options.respond(true, { status: "started" });
    });
    context.getGatewayMethodRegistry = () =>
      createGatewayMethodRegistry(
        createCoreGatewayMethodDescriptors({
          "sessions.create": handler,
          "chat.send": chatHandler,
        }),
      );
    const create = (
      params: Record<string, unknown> = {},
      creation: Partial<TrustedSessionCreation> = {},
    ) => {
      const invoke = () =>
        withGatewayToolCallerIdentity(caller, () =>
          callInProcessGatewayToolWithCreation<{ key: string; sessionId: string }>(
            "sessions.create",
            {
              agentId: "main",
              key: childKey,
              parentSessionKey: parentKey,
              spawnDepth: 1,
              ...params,
            },
            {
              via: "spawn",
              actor: { type: "agent", id: "main" },
              requesterSessionKey: parentKey,
              inheritedToolPolicy: { version: 1, allow: [], deny: [] },
              ...creation,
            },
          ),
        );
      if (source !== "unidentified") {
        return invoke();
      }
      // An unidentified external scope must not acquire the host's system identity.
      return withPluginRuntimeGatewayRequestScope(
        {
          context,
          client: { connect: client.connect },
          isWebchatConnect: () => false,
        },
        invoke,
      );
    };
    const tool = await withGatewayToolCallerIdentity(caller, () => createSessionsCreateTool());
    try {
      await run({
        tool,
        toolCreate: (params, toolCallId, signal) =>
          withGatewayToolCallerIdentity(caller, async () => {
            if (!tool) {
              throw new Error("Session creation unavailable");
            }
            return await tool.execute(toolCallId ?? "create-independent", params ?? {}, signal);
          }),
        create,
        spawn: (mode, agentId) =>
          withGatewayToolCallerIdentity(caller, () =>
            maybeSpawnVisibleSession({
              raw: { visible: true, model: "test-provider/scope-model" },
              task: "Inspect the isolated workspace.",
              label: "Scheduled child",
              runtime: "subagent",
              requestedAgentId: agentId,
              sandbox: "inherit",
              expectsCompletionMessage: false,
              options: {
                config: cfg,
                agentSessionKey: parentKey,
                ...(mode ? { sessionPermissionPolicy: { mode, root: state.workspaceDir } } : {}),
                countActiveRuns: () => 0,
                registerRun: vi.fn(),
              },
            }),
          ),
        read: (key = childKey, agentId = "main") =>
          loadSessionEntry({ storePath, sessionKey: key, agentId }),
        keys: () => listSessionEntryKeysReadOnly({ agentId: "main", storePath }),
        seedForeign: async () => {
          await upsertSessionEntryCore(childScope, {
            sessionId: "foreign-session",
            updatedAt: 1,
            label: "Foreign unchanged",
            createdActor: { type: "human", source: "profile", id: "other-person" },
          });
        },
        handler,
        chatHandler,
        send: (key) =>
          withGatewayToolCallerIdentity(caller, () =>
            callInProcessGatewayTool("chat.send", {
              sessionKey: key,
              message: "Follow up",
              idempotencyKey: "guest-followup",
            }),
          ),
        beforeCreate,
        revoke: () => sourceController.abort(new Error("original native source revoked")),
        profileId,
      });
    } finally {
      if (scheduled) {
        scheduled.close();
      } else {
        parent.close();
      }
      captured?.release();
    }
  });
}

describe("hosted session tool narrow scope projection", () => {
  it("creates through the real router with the original narrow operator source", async () => {
    await withHostedCreation(async (fixture) => {
      const created = await fixture.create();
      expect(created.key).toBe(childKey);
      expect(fixture.handler).toHaveBeenCalledOnce();
      expect(fixture.read()).toMatchObject({
        sessionId: created.sessionId,
        sandbox: "required",
        createdActor: { type: "human", source: "profile", id: fixture.profileId },
      });
    });
  });

  it("does not mutate a foreign target through the native creation alias", async () => {
    await withHostedCreation(async (fixture) => {
      await fixture.seedForeign();
      const before = fixture.read();
      await expect(fixture.create({ label: "Rejected" })).rejects.toThrow("own session");
      expect(fixture.handler).not.toHaveBeenCalled();
      expect(fixture.read()).toEqual(before);
    });
  });

  it("hides an existing parent from a hosted caller without external provenance", async () => {
    await withHostedCreation(async (fixture) => {
      await expect(fixture.create()).rejects.toThrow(`Session "${parentKey}" was not found.`);
      expect(fixture.handler).not.toHaveBeenCalled();
      expect(fixture.read()).toBeUndefined();
    }, "unidentified");
  });

  it.each(["operator", "scheduled"] as const)(
    "retains the original %s source after admission until the creation COMMIT",
    async (source) => {
      await withHostedCreation(async (fixture) => {
        const entered = createDeferred();
        const release = createDeferred();
        fixture.beforeCreate.mockImplementation(async () => {
          entered.resolve();
          await release.promise;
        });
        const request = fixture.create({}, { inheritedPermissionMode: "full" });
        const rejected = expect(request).rejects.toThrow(
          source === "operator"
            ? "original native source revoked"
            : "agent tool caller authority is no longer active",
        );
        try {
          await Promise.race([entered.promise, request]);
          expect(fixture.handler).toHaveBeenCalledOnce();
          fixture.revoke();
        } finally {
          release.resolve();
          await rejected;
        }
        expect(fixture.read()).toBeUndefined();
      }, source);
    },
  );
});

describe("hosted visible spawn permission inheritance", () => {
  it.each([
    { mode: undefined, agentId: "main", source: "scheduled" },
    { mode: "read-only", agentId: "main", source: "scheduled" },
    { mode: "full", agentId: "main", source: "scheduled" },
    { mode: "full", agentId: "reviewer", source: "scheduled" },
    { mode: "full", agentId: "main", source: "operator" },
  ] as const)(
    "persists effective $mode permission for $agentId from $source without granting admin scope",
    async ({ mode, agentId, source }) => {
      await withHostedCreation(async (fixture) => {
        // A turn can narrow a saved full-access session. The child's next turn
        // must retain the runtime policy, not recover the broader stored value.
        expect(fixture.read(parentKey)?.permissionMode).toBe("full");
        const result = await fixture.spawn(mode, agentId);
        expect(result).toMatchObject({
          status: "accepted",
          childSessionKey: expect.stringContaining(`agent:${agentId}:dashboard:`),
        });
        const key = result?.childSessionKey;
        if (typeof key !== "string") {
          throw new Error("visible spawn did not return its committed child");
        }
        expect(fixture.handler).toHaveBeenCalledOnce();
        const child = fixture.read(key, agentId);
        expect(child).toMatchObject({
          parentSessionKey: parentKey,
          spawnDepth: 1,
          sandbox: "required",
        });
        // No prepared policy also must not manufacture full access from storage.
        expect(child?.permissionMode).toBe(mode);
      }, source);
    },
  );

  it("keeps an explicit public full-access request admin-gated", async () => {
    await withHostedCreation(async (fixture) => {
      await expect(
        fixture.create({ permissionMode: "full" }, { inheritedPermissionMode: "full" }),
      ).rejects.toMatchObject({
        name: "GatewayClientRequestError",
        details: {
          code: "MISSING_SCOPE",
          missingScope: "operator.admin",
          requiredScopes: ["operator.admin"],
        },
      });
      expect(fixture.handler).not.toHaveBeenCalled();
      expect(fixture.read()).toBeUndefined();
    });
  });

  it("rejects inherited permission when the spawn actor is not the current requester", async () => {
    await withHostedCreation(async (fixture) => {
      await expect(
        fixture.create(
          {},
          {
            actor: { type: "agent", id: "reviewer" },
            inheritedPermissionMode: "full",
          },
        ),
      ).rejects.toThrow(/permission inheritance/i);
      expect(fixture.read()).toBeUndefined();
    }, "scheduled");
  });
});

describe("independent session creation tool", () => {
  it("creates a guest-owned idle root with destination defaults and a bounded receipt", async () => {
    await withHostedCreation(async ({ tool, toolCreate, read, profileId }) => {
      expect(tool?.name).toBe("sessions_create");
      expect(tool?.parameters).not.toHaveProperty("properties.action");
      const result = await toolCreate({ label: "Independent investigation" });
      expect(result.details).toEqual({
        sessionKey: expect.any(String),
        sessionId: expect.any(String),
        runStarted: false,
      });
      const receipt = result.details as { sessionKey: string; sessionId: string };
      expect(receipt.sessionKey).not.toBe(parentKey);
      const entry = read(receipt.sessionKey);
      expect(entry).toMatchObject({
        sessionId: receipt.sessionId,
        createdVia: "operator",
        createdActor: { type: "human", source: "profile", id: profileId },
        sandbox: "required",
      });
      expect(entry?.spawnedBy).toBeUndefined();
      expect(entry?.spawnDepth ?? 0).toBe(0);
      expect(entry?.permissionMode).not.toBe("full");
      expect(kickoff.internal).not.toHaveBeenCalled();
      expect(kickoff.external).not.toHaveBeenCalled();
    });
  });

  it("lets the guest continue their created session but not somebody else's", async () => {
    await withHostedCreation(async ({ toolCreate, send, seedForeign, chatHandler }) => {
      const result = await toolCreate();
      const receipt = result.details as { sessionKey: string };
      await expect(send(receipt.sessionKey)).resolves.toMatchObject({ status: "started" });
      expect(chatHandler).toHaveBeenCalledOnce();
      await seedForeign();
      await expect(send(childKey)).rejects.toThrow();
      expect(chatHandler).toHaveBeenCalledOnce();
    });
  });

  it("starts an agent-authored initial brief once, never a direct human command", async () => {
    await withHostedCreation(async ({ toolCreate }) => {
      const args = { message: "/reset is an example to investigate, not a command" };
      const first = await toolCreate(args);
      const retried = await toolCreate(args);
      expect(retried.details).toEqual(first.details);
      expect(first.details).toMatchObject({ runStarted: true, runId: "scope-independent-run" });
      expect(kickoff.internal).toHaveBeenCalledTimes(1);
      expect(kickoff.internal.mock.calls[0]?.[0].params).toMatchObject({
        message: args.message,
        systemInputProvenance: {
          kind: "inter_session",
          sourceSessionKey: parentKey,
          sourceTool: "sessions_create",
        },
        suppressCommandInterpretation: true,
      });
      expect(kickoff.internal.mock.calls[0]?.[0].client?.internal?.senderAttribution).toEqual({
        id: "agent:main",
      });
      expect(kickoff.external).not.toHaveBeenCalled();
      await expect(toolCreate({ message: "A different brief" })).rejects.toThrow(
        /idempotency key.*different parameters/,
      );
    });
  });

  it("keeps the created session and reports failed kickoff without claiming a run", async () => {
    await withHostedCreation(async ({ toolCreate, read }) => {
      kickoff.internal.mockImplementationOnce(async (options: GatewayRequestHandlerOptions) => {
        options.respond(false, undefined, {
          code: "UNAVAILABLE",
          message: "Test provider unavailable",
        });
      });
      const result = await toolCreate({ message: "Investigate" });
      expect(result.details).toMatchObject({
        runStarted: false,
        runError: { code: "UNAVAILABLE", message: "Test provider unavailable" },
      });
      const receipt = result.details as { sessionKey: string };
      expect(read(receipt.sessionKey)).toBeDefined();
      expect(result.details).not.toHaveProperty("runId");
    });
  });

  it.each([
    { message: "   " },
    { message: 4 },
    { key: childKey },
    { parentSessionKey: parentKey },
    { fork: true },
    { ownerId: "other" },
    { role: "admin" },
    { toolOverrides: {} },
    { permissionMode: "unrestricted" },
    { group: null },
  ])("rejects invalid or identity/lineage-bearing arguments before dispatch: %j", async (args) => {
    await withHostedCreation(async ({ toolCreate, handler }) => {
      await expect(toolCreate(args)).rejects.toThrow();
      expect(handler).not.toHaveBeenCalled();
    });
  });

  it("retains backend role-agent, permission, and workspace restrictions", async () => {
    await withHostedCreation(async ({ toolCreate, read }) => {
      await expect(toolCreate({ agentId: "reviewer" }, "forbidden-agent")).rejects.toThrow();
      await expect(toolCreate({ permissionMode: "full" }, "full-mode")).rejects.toThrow(
        /operator.admin/,
      );
      await expect(toolCreate({ cwd: "relative" }, "relative-cwd")).rejects.toThrow(/absolute/);
      await expect(toolCreate({ cwd: "/" }, "outside-workspace")).rejects.toMatchObject({
        name: "GatewayClientRequestError",
        details: {
          code: "MISSING_SCOPE",
          missingScope: "operator.admin",
          requiredScopes: ["operator.admin"],
        },
      });
      expect(read()).toBeUndefined();
    });
  });

  it.each(["unidentified", "scheduled"] as const)(
    "does not turn a %s run into an operator creation grant",
    async (source) => {
      await withHostedCreation(async ({ tool, toolCreate, handler }) => {
        expect(tool).toBeNull();
        await expect(toolCreate({ message: "Investigate" })).rejects.toThrow(/unavailable/);
        expect(handler).not.toHaveBeenCalled();
      }, source);
    },
  );

  it("fences tool cancellation before the creation commit", async () => {
    await withHostedCreation(async ({ toolCreate, beforeCreate, keys }) => {
      const before = await keys();
      const abort = new AbortController();
      beforeCreate.mockImplementationOnce(async () => {
        abort.abort(new Error("Tool canceled"));
      });
      // Saved-default admission normalizes a revoked caller into its public
      // authorization error; the creation owner must still leave no new row.
      await expect(toolCreate({}, "canceled-create", abort.signal)).rejects.toMatchObject({
        name: "GatewayClientRequestError",
        code: "FORBIDDEN",
      });
      expect(await keys()).toEqual(before);
    });
  });
});
