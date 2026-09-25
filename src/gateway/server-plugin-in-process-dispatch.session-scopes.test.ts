import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { prepareSystemAgentRunAdmission } from "../agents/admitted-run-context.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../agents/tools/gateway-caller-context.js";
import { callInProcessGatewayToolWithCreation } from "../agents/tools/in-process-gateway.js";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import { loadSessionEntry, upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  bindGatewayContextResolver,
  withPluginRuntimeGatewayRequestScope,
} from "../plugins/runtime/gateway-request-scope.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createGatewayMethodRegistry } from "./methods/registry.js";
import { captureGatewayOperatorRunAuthority } from "./operator-run-authority.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import { readGatewayRequestMutationAuthority } from "./server-methods/session-mutation-guards.js";
import { sessionCreateHandlers } from "./server-methods/sessions-create.js";
import type { GatewayRequestHandlerOptions } from "./server-methods/types.js";
import { roleClient } from "./session-sharing.test-utils.js";

const parentKey = "agent:main:scope-parent";
const childKey = "agent:main:dashboard:scope-child";

async function withHostedCreation(
  run: (fixture: {
    create: (params?: Record<string, unknown>) => Promise<{ key: string; sessionId: string }>;
    read: () => ReturnType<typeof loadSessionEntry>;
    seedForeign: () => Promise<void>;
    handler: ReturnType<typeof vi.fn<(options: GatewayRequestHandlerOptions) => Promise<void>>>;
    beforeCreate: ReturnType<typeof vi.fn<() => Promise<void>>>;
    revoke: () => void;
    profileId: string;
  }) => Promise<void>,
  identified = true,
) {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const storePath = state.path("sessions.json");
    const cfg: OpenClawConfig = {
      session: { store: storePath },
      agents: { defaults: { workspace: state.workspaceDir }, entries: { main: {} } },
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
      createdActor: { type: "human", source: "profile", id: profileId },
    });
    expect(loadSessionEntry(parentScope)?.sessionId).toBe("scope-parent-session");
    const context = createDirectChatContext({ getRuntimeConfig: () => cfg });
    context.resolveGatewayContext = () => context;
    const sourceController = new AbortController();
    const captured = identified
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
    const parent = prepareSystemAgentRunAdmission(
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
      }),
      "hosted caller",
    );
    const beforeCreate = vi.fn(async () => {});
    const handler = vi.fn(async (options: GatewayRequestHandlerOptions) => {
      // Observe the real router admission, then call the real SQLite creation owner.
      expect(options.client?.internal?.syntheticClient).toBe(true);
      expect(options.client?.connect.scopes).toEqual(["operator.sessions.write"]);
      expect(readGatewayRequestMutationAuthority(options).sessionScope).toBe(
        "operator.sessions.write",
      );
      const original = expectDefined(captured, "original source").authority;
      expect(options.client?.internal?.operatorRunAuthority?.source).toBe(original.source);
      expect(options.client?.internal?.operatorRoleActor).toEqual({ kind: "operator", profileId });
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
    const create = (params: Record<string, unknown> = {}) => {
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
            },
          ),
        );
      if (identified) {
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
        read: () => loadSessionEntry(childScope),
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
      parent.close();
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
    }, false);
  });

  it("retains the original source after admission until the creation COMMIT", async () => {
    await withHostedCreation(async (fixture) => {
      const entered = createDeferred();
      const release = createDeferred();
      fixture.beforeCreate.mockImplementation(async () => {
        entered.resolve();
        await release.promise;
      });
      const request = fixture.create();
      const rejected = expect(request).rejects.toThrow(
        "operator execution authority is no longer active",
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
    });
  });
});
