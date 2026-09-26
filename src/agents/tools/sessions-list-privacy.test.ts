import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import {
  appendTranscriptMessageSync,
  patchSessionEntryCore,
  replaceSessionEntrySync,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { coreGatewayHandlers } from "../../gateway/server-methods/core-handlers.js";
import { prepareGatewayRequestHandler } from "../../gateway/server-methods/lazy-core-handlers.js";
import {
  disposeSessionReadContexts,
  identifiedClient,
  initializeSessionReadContext,
  requestContext,
} from "../../gateway/server-methods/sessions-read-cache.test-support.js";
import { withOperatorToolGatewayAuthority } from "../../gateway/server-plugin-in-process-dispatch.js";
import { withReadySessionRows } from "../../gateway/session-row-prepared-read.js";
import { getSessionRowProjection } from "../../gateway/session-row-projection-access.js";
import * as titleReader from "../../gateway/session-transcript-title-reader.js";
import {
  withPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayContextResolver,
} from "../../plugins/runtime/gateway-request-scope.js";
import { registerOpenClawAgentDatabase } from "../../state/openclaw-agent-db-registry.js";
import { ensureProfileForEmail, setUserProfileRole } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  bindEmbeddedSessionRowProjection,
  createEmbeddedCallGateway,
} from "./embedded-gateway-stub.js";
import { withGatewayToolCallerIdentity } from "./gateway-caller-context.js";
import {
  callAgentToolGatewayRequest,
  type AgentToolGatewayRequestCaller,
} from "./in-process-gateway.js";
import { createSessionsListTool } from "./sessions-list-tool.js";

const first = {
  agentId: "main",
  sessionKey: "agent:main:dashboard:buffered",
  sessionId: "buffered",
};
const second = {
  agentId: "main",
  sessionKey: "agent:main:dashboard:pending",
  sessionId: "pending",
};
const bufferedText = "SYNTHETIC_BUFFERED_TRANSCRIPT_TEXT";
beforeAll(async () => {
  // Source transformation belongs to fixture setup, outside the privacy probe's RPC deadline.
  await prepareGatewayRequestHandler(
    expectDefined(coreGatewayHandlers["chat.history"], "registered chat.history handler"),
  );
});
afterEach(() => vi.restoreAllMocks());

async function withInventory(
  run: (fixture: {
    cfg: OpenClawConfig;
    viewerId: string;
    ownerId: string;
    context: ReturnType<typeof requestContext>;
    asReader: <T>(operation: () => Promise<T>) => Promise<T>;
    setConfig: (config: OpenClawConfig) => void;
    statePath: (name: string) => string;
  }) => Promise<void>,
) {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const owner = ensureProfileForEmail("inventory-owner@example.test");
    const viewer = ensureProfileForEmail("inventory-reader@example.test");
    let cfg: OpenClawConfig = {
      agents: { entries: { main: { default: true } } },
      gateway: {
        roles: {
          default: "reader",
          definitions: {
            reader: { agents: ["main"], sessions: { others: "view" }, scopes: ["operator.read"] },
            self: { agents: ["main"], sessions: { others: "none" }, scopes: ["operator.read"] },
          },
        },
      },
    };
    setRuntimeConfigSnapshot(cfg);
    for (const [index, scope] of [first, second].entries()) {
      replaceSessionEntrySync(scope, {
        sessionId: scope.sessionId,
        updatedAt: 2 - index,
        visibility: "shared",
        createdActor: { type: "human", source: "profile", id: index ? viewer.id : owner.id },
      });
      for (const message of [
        { role: "user", content: "Shared question " + index },
        { role: "assistant", content: index ? "Still-visible reply" : bufferedText },
      ]) {
        expect(appendTranscriptMessageSync(scope, { message }).ok).toBe(true);
      }
    }
    const client = identifiedClient(viewer.id);
    client.connect.scopes = ["operator.read"];
    const context = requestContext(cfg);
    context.getRuntimeConfig = () => cfg;
    context.trackExecution = async (operation) => await operation();
    await initializeSessionReadContext(context);
    const asReader = <T>(operation: () => Promise<T>) =>
      withPluginRuntimeGatewayRequestScope({ context, isWebchatConnect: () => false }, () =>
        withOperatorToolGatewayAuthority(
          {
            authenticatedUserProfile: expectDefined(client.authenticatedUserProfile, "reader"),
            scopes: ["operator.read"],
          },
          operation,
        ),
      );
    try {
      await run({
        cfg,
        viewerId: viewer.id,
        ownerId: owner.id,
        context,
        asReader,
        setConfig: (next) => {
          cfg = next;
          setRuntimeConfigSnapshot(cfg);
        },
        statePath: (name) => state.statePath(name),
      });
    } finally {
      await disposeSessionReadContexts();
    }
  });
}

test.each([false, true])(
  "omits a row made draft during pagination (enrichment: %s)",
  async (enrichment) => {
    await withInventory(async ({ cfg, asReader }) => {
      const privateText = "SYNTHETIC_DRAFT_PREVIEW_AFTER_PAGINATION";
      let pages = 0;
      const callGateway: AgentToolGatewayRequestCaller = async <T>(
        request: Parameters<AgentToolGatewayRequestCaller>[0],
      ): Promise<T> => {
        if (request.method !== "sessions.list") {
          return callAgentToolGatewayRequest<T>(request);
        }
        if (pages++ === 0) {
          if (!isRecord(request.params)) {
            throw new Error("Inventory requests require object parameters");
          }
          const page = await callAgentToolGatewayRequest<{ sessions: unknown[] }>({
            ...request,
            params: { ...request.params, limit: 1 },
          });
          expect(page.sessions).toMatchObject([{ key: first.sessionKey }]);
          // SAFETY: only pagination is synthetic; rows retain the actual registered response.
          return { ...page, hasMore: true, nextOffset: 1 } as T;
        }
        await patchSessionEntryCore(first, () => ({ visibility: "draft" }));
        expect(
          appendTranscriptMessageSync(first, {
            message: { role: "assistant", content: privateText },
          }).ok,
        ).toBe(true);
        // SAFETY: this terminal empty page implements the requested Gateway list payload.
        return { sessions: [], hasMore: false, nextOffset: null } as T;
      };
      const result = await asReader(() =>
        createSessionsListTool({ config: cfg, callGateway }).execute("late-inventory", {
          includeDerivedTitles: enrichment,
          includeLastMessage: enrichment,
        }),
      );
      expect(pages).toBe(2);
      expect(JSON.stringify(result)).not.toContain(privateText);
      expect(result.details).toMatchObject({ count: 0, sessions: [] });
    });
  },
);

test.each(["revoked", "aborted", "replaced"] as const)(
  "does not disclose title reads after the caller is %s",
  async (change) => {
    await withInventory(async ({ cfg, context, asReader }) => {
      const controller = new AbortController();
      let current = true;
      let currentGateway: typeof context | undefined = context;
      const read = titleReader.readSessionTitleFieldsFromTranscriptAsync;
      vi.spyOn(titleReader, "readSessionTitleFieldsFromTranscriptAsync").mockImplementation(
        async (...args) => {
          const fields = await read(...args);
          if (change === "revoked") {
            current = false;
          } else if (change === "aborted") {
            controller.abort(new Error("Inventory read cancelled"));
          } else {
            currentGateway = undefined;
          }
          return fields;
        },
      );
      await expect(
        asReader(() =>
          withPluginRuntimeGatewayContextResolver(
            () => currentGateway,
            () =>
              withGatewayToolCallerIdentity(
                {
                  agentId: "main",
                  sessionKey: "agent:main:requester",
                  operationalRunInstance: {
                    instanceId: "inventory-instance",
                    runId: "inventory-run",
                  },
                  receiptAuthority: () => current,
                },
                () =>
                  createSessionsListTool({ config: cfg }).execute(
                    "retired-reader",
                    { includeLastMessage: true },
                    controller.signal,
                  ),
              ),
          ),
        ),
      ).rejects.toThrow(
        change === "revoked"
          ? "agent tool caller authority is no longer active"
          : change === "aborted"
            ? "Inventory read cancelled"
            : "Gateway instance unavailable for sessions.list",
      );
    });
  },
);

test.each([
  { stage: "titles", change: "draft", policy: "named role" },
  { stage: "chat.history", change: "draft", policy: "named role" },
  { stage: "chat.history", change: "draft", policy: "shared profile" },
  { stage: "chat.history", change: "role", policy: "named role" },
  { stage: "chat.history", change: "lifecycle", policy: "named role" },
  { stage: "chat.history", change: "metadata", policy: "named role" },
] as const)(
  "rechecks $policy enrichment after a $change change during $stage",
  async ({ stage, change, policy }) => {
    await withInventory(async ({ cfg, viewerId, asReader, setConfig }) => {
      if (policy === "shared profile") {
        setConfig({ ...cfg, gateway: {} });
      }
      const firstRead = createDeferred();
      let changed = false;
      const afterRead = async (key: unknown) => {
        if (key === first.sessionKey) {
          firstRead.resolve();
        } else if (key === second.sessionKey) {
          await firstRead.promise;
          if (change === "role") {
            expect(setUserProfileRole(viewerId, "self").role).toBe("self");
          } else {
            await patchSessionEntryCore(first, () =>
              change === "draft"
                ? { visibility: "draft" }
                : change === "lifecycle"
                  ? { lifecycleRevision: "replacement-lifecycle" }
                  : { label: "Renamed shared session" },
            );
          }
          changed = true;
        }
      };
      if (stage === "titles") {
        const read = titleReader.readSessionTitleFieldsFromTranscriptAsync;
        vi.spyOn(titleReader, "readSessionTitleFieldsFromTranscriptAsync").mockImplementation(
          async (...args) => {
            const fields = await read(...args);
            const scope = args[0];
            if (scope.sessionKey === first.sessionKey) {
              expect(fields.lastMessagePreview).toBe(bufferedText);
            }
            await afterRead(scope.sessionKey);
            return fields;
          },
        );
      }
      const callGateway: AgentToolGatewayRequestCaller = async <T>(
        request: Parameters<AgentToolGatewayRequestCaller>[0],
      ): Promise<T> => {
        const response = await callAgentToolGatewayRequest<T>(request);
        if (stage === "chat.history" && request.method === stage) {
          const params = request.params;
          if (!isRecord(params)) {
            throw new Error("Inventory requests require object parameters");
          }
          if (change === "role" && params.sessionKey === first.sessionKey) {
            expect(JSON.stringify(response)).toContain(bufferedText);
          }
          await afterRead(params.sessionKey);
        }
        return response;
      };
      const pending = asReader(() =>
        createSessionsListTool({ config: cfg, callGateway }).execute("buffered-inventory", {
          includeDerivedTitles: true,
          includeLastMessage: true,
          ...(stage === "chat.history" ? { messageLimit: 1 } : {}),
        }),
      );
      if (change === "role") {
        await expect(pending).rejects.toThrow(
          "Your operator role changed; reconnect before continuing.",
        );
        expect(changed).toBe(true);
      }
      const result =
        change === "role"
          ? await asReader(() =>
              createSessionsListTool({ config: cfg }).execute("fresh-inventory", {
                includeDerivedTitles: true,
                includeLastMessage: true,
                messageLimit: 1,
              }),
            )
          : await pending;
      expect(changed).toBe(true);
      expect(result.details).toMatchObject({
        count: change === "metadata" ? 2 : 1,
        sessions:
          change === "metadata"
            ? [{ key: first.sessionKey }, { key: second.sessionKey }]
            : [
                {
                  key: second.sessionKey,
                  derivedTitle: "Shared question 1",
                  lastMessagePreview: "Still-visible reply",
                },
              ],
      });
      if (change === "metadata") {
        expect(JSON.stringify(result)).toContain(bufferedText);
      } else {
        expect(JSON.stringify(result)).not.toContain(bufferedText);
      }
      expect(JSON.stringify(result)).toContain("Still-visible reply");
    });
  },
);

test("rejects lost in-process read custody while preserving external RPC results", async () => {
  await withInventory(async ({ cfg, asReader }) => {
    const cloned: AgentToolGatewayRequestCaller = async <T>(
      request: Parameters<AgentToolGatewayRequestCaller>[0],
    ) => structuredClone(await callAgentToolGatewayRequest<T>(request));
    await expect(
      asReader(() =>
        createSessionsListTool({ config: cfg, callGateway: cloned }).execute("lost-custody", {
          messageLimit: 1,
        }),
      ),
    ).rejects.toThrow("Session enrichment requires its Gateway or embedded read owner");

    const external: AgentToolGatewayRequestCaller = async <T>(
      request: Parameters<AgentToolGatewayRequestCaller>[0],
    ) => asReader(() => cloned<T>(request));
    const result = await createSessionsListTool({ config: cfg, callGateway: external }).execute(
      "external-inventory",
      { messageLimit: 1 },
    );
    expect(result.details).toMatchObject({ count: 2 });
    expect(JSON.stringify(result)).toContain(bufferedText);
  });
});

test("retains the embedded projection owner through history enrichment", async () => {
  await withInventory(async ({ cfg, context }) => {
    const projection = expectDefined(getSessionRowProjection(context), "embedded projection");
    const unbind = bindEmbeddedSessionRowProjection(Promise.resolve(projection));
    const embedded = createEmbeddedCallGateway();
    const firstRead = createDeferred();
    const callGateway: AgentToolGatewayRequestCaller = async <T>(
      request: Parameters<AgentToolGatewayRequestCaller>[0],
    ) => {
      const result = await embedded<T>(request);
      if (request.method === "chat.history" && isRecord(request.params)) {
        if (request.params.sessionKey === first.sessionKey) {
          firstRead.resolve();
        } else if (request.params.sessionKey === second.sessionKey) {
          await firstRead.promise;
          await patchSessionEntryCore(first, () => ({ lifecycleRevision: "replacement" }));
        }
      }
      return result;
    };
    try {
      const result = await createSessionsListTool({
        config: cfg,
        callGateway,
        supportsActiveOnly: false,
        requireSessionReadOwner: true,
      }).execute("embedded-inventory", { messageLimit: 1 });
      expect(result.details).toMatchObject({ count: 1, sessions: [{ key: second.sessionKey }] });
      expect(JSON.stringify(result)).not.toContain(bufferedText);
    } finally {
      unbind();
    }
  });
});

test("does not authorize a buffered global transcript with another physical store's row", async () => {
  await withInventory(async ({ cfg, ownerId, context, asReader, setConfig, statePath }) => {
    const oldPath = statePath("old-global.sqlite");
    const newPath = statePath("new-global.sqlite");
    const original = {
      agentId: "main",
      sessionKey: "global",
      sessionId: "old-global",
      storePath: oldPath,
    };
    for (const [storePath, sessionId, updatedAt] of [
      [oldPath, "old-global", 200],
      [newPath, "new-global", 100],
    ] as const) {
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: "global", storePath },
        {
          sessionId,
          updatedAt,
          visibility: "shared",
          createdActor: { type: "human", source: "profile", id: ownerId },
        },
      );
      registerOpenClawAgentDatabase({ agentId: "main", path: storePath });
    }
    expect(
      appendTranscriptMessageSync(original, {
        message: { role: "assistant", content: bufferedText },
      }).ok,
    ).toBe(true);
    const originalConfig: OpenClawConfig = { ...cfg, session: { scope: "global", store: oldPath } };
    setConfig(originalConfig);
    let changed = false;
    const callGateway: AgentToolGatewayRequestCaller = async <T>(
      request: Parameters<AgentToolGatewayRequestCaller>[0],
    ): Promise<T> => {
      const response = await callAgentToolGatewayRequest<T>(request);
      if (request.method === "chat.history") {
        expect(JSON.stringify(response)).toContain(bufferedText);
        await patchSessionEntryCore(original, () => ({ visibility: "draft" }));
        setConfig({ ...originalConfig, session: { scope: "global", store: newPath } });
        const projection = expectDefined(getSessionRowProjection(context), "physical stores");
        await withReadySessionRows(
          projection,
          () => [
            { agentId: "main", key: "global" },
            { agentId: "main", key: "global", storePath: oldPath },
          ],
          (read) => {
            expect(read.describe({ agentId: "main", key: "global" })?.entry.sessionId).toBe(
              "new-global",
            );
            expect(
              read.describe({ agentId: "main", key: "global", storePath: oldPath })?.entry
                .visibility,
            ).toBe("draft");
          },
        );
        changed = true;
      }
      return response;
    };
    const result = await asReader(() =>
      createSessionsListTool({ config: originalConfig, callGateway }).execute(
        "physical-inventory",
        {
          limit: 1,
          messageLimit: 1,
        },
      ),
    );
    expect(changed).toBe(true);
    expect(result.details).toMatchObject({ count: 0, sessions: [] });
    expect(JSON.stringify(result)).not.toContain(bufferedText);
  });
});
