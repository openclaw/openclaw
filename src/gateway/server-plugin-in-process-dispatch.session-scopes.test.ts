import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { prepareSystemAgentRunAdmission } from "../agents/admitted-run-context.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../agents/tools/gateway-caller-context.js";
import { callInProcessGatewayToolWithCreation } from "../agents/tools/in-process-gateway.js";
import { maybeSpawnVisibleSession } from "../agents/tools/sessions-spawn-visible.js";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import { loadSessionEntry, upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { prepareCronPromptRunAdmission } from "../cron/isolated-agent/run-admission.js";
import {
  bindGatewayContextResolver,
  withPluginRuntimeGatewayRequestScope,
} from "../plugins/runtime/gateway-request-scope.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createGatewayMethodRegistry } from "./methods/registry.js";
import { captureGatewayOperatorRunAuthority } from "./operator-run-authority.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import type { TrustedSessionCreation } from "./server-methods/session-creation-provenance.js";
import { readGatewayRequestMutationAuthority } from "./server-methods/session-mutation-guards.js";
import { sessionCreateHandlers } from "./server-methods/sessions-create.js";
import type { GatewayRequestHandlerOptions } from "./server-methods/types.js";
import { roleClient } from "./session-sharing.test-utils.js";

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
    options.respond(true, { status: "started", runId: "scope-child-run" });
  },
}));

async function withHostedCreation(
  run: (fixture: {
    create: (
      params?: Record<string, unknown>,
      creation?: Partial<TrustedSessionCreation>,
    ) => Promise<{ key: string; sessionId: string }>;
    spawn: (
      mode: SessionEntry["permissionMode"],
      agentId?: string,
    ) => ReturnType<typeof maybeSpawnVisibleSession>;
    read: (key?: string, agentId?: string) => ReturnType<typeof loadSessionEntry>;
    seedForeign: () => Promise<void>;
    handler: ReturnType<typeof vi.fn<(options: GatewayRequestHandlerOptions) => Promise<void>>>;
    beforeCreate: ReturnType<typeof vi.fn<() => Promise<void>>>;
    revoke: () => void;
    profileId: string;
  }) => Promise<void>,
  source: "operator" | "unidentified" | "scheduled" = "operator",
) {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
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
              agents: "*",
              scopes: ["operator.sessions.write"],
              sessions: { others: "view" },
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
        ? prepareCronPromptRunAdmission({
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
    context.getGatewayMethodRegistry = () =>
      createGatewayMethodRegistry([
        {
          name: "sessions.create",
          scope: "dynamic",
          owner: { kind: "core", area: "sessions" },
          handler,
        },
      ]);
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
    try {
      await run({
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
        seedForeign: async () => {
          await upsertSessionEntryCore(childScope, {
            sessionId: "foreign-session",
            updatedAt: 1,
            label: "Foreign unchanged",
            createdActor: { type: "human", source: "profile", id: "other-person" },
          });
        },
        handler,
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
            ? "operator execution authority is no longer active"
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
    { mode: "guarded", agentId: "main", source: "scheduled" },
    { mode: "workspace", agentId: "main", source: "scheduled" },
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
