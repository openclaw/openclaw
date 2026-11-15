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
import { setUserProfileRole } from "../../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
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

const session = (sessionId: string) => ({
  agentId: "main",
  sessionKey: `agent:main:dashboard:${sessionId}`,
  sessionId,
});
const first = session("buffered"),
  second = session("pending");
const bufferedText = "SYNTHETIC_BUFFERED_TRANSCRIPT_TEXT";
type ListOptions = NonNullable<Parameters<typeof createSessionsListTool>[0]>;
type GatewayRequest = Parameters<AgentToolGatewayRequestCaller>[0];
type TitleRead = typeof titleReader.readSessionTitleFieldsFromTranscriptAsync;
const enrichment = (enabled = true) => ({
  includeDerivedTitles: enabled,
  includeLastMessage: enabled,
});
function list(config: OpenClawConfig, args = {}, options: ListOptions = {}, signal?: AbortSignal) {
  return createSessionsListTool({ config, ...options }).execute("inventory", args, signal);
}
function append(
  scope: Parameters<typeof appendTranscriptMessageSync>[0],
  content: string,
  role = "assistant",
) {
  expect(appendTranscriptMessageSync(scope, { message: { role, content } }).ok).toBe(true);
}
function seed(
  scope: Parameters<typeof replaceSessionEntrySync>[0],
  id: string,
  sessionId: string,
  updatedAt: number,
) {
  replaceSessionEntrySync(scope, {
    sessionId,
    updatedAt,
    visibility: "shared",
    createdActor: { type: "human", source: "profile", id },
  });
}
function interceptTitles(
  afterRead: (
    scope: Parameters<TitleRead>[0],
    fields: Awaited<ReturnType<TitleRead>>,
  ) => void | Promise<void>,
) {
  const read = titleReader.readSessionTitleFieldsFromTranscriptAsync;
  vi.spyOn(titleReader, "readSessionTitleFieldsFromTranscriptAsync").mockImplementation(
    async (...args) => {
      const fields = await read(...args);
      await afterRead(args[0], fields);
      return fields;
    },
  );
}
function interceptGateway(
  afterRead: (request: GatewayRequest, response: unknown) => Promise<void>,
  gateway: AgentToolGatewayRequestCaller = callAgentToolGatewayRequest,
): AgentToolGatewayRequestCaller {
  return async <T>(request: GatewayRequest): Promise<T> => {
    const response = await gateway<T>(request);
    await afterRead(request, response);
    return response;
  };
}
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
      agents: { entries: { main: {} } },
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
      seed(scope, index ? viewer.id : owner.id, scope.sessionId, 2 - index);
      append(scope, "Shared question " + index, "user");
      append(scope, index ? "Still-visible reply" : bufferedText);
    }
    const client = identifiedClient(viewer.id);
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
  async (enrich) => {
    await withInventory(async ({ cfg, asReader }) => {
      const privateText = "SYNTHETIC_DRAFT_PREVIEW_AFTER_PAGINATION";
      let pages = 0;
      const callGateway: AgentToolGatewayRequestCaller = async <T>(
        request: GatewayRequest,
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
        append(first, privateText);
        // SAFETY: this terminal empty page implements the requested Gateway list payload.
        return { sessions: [], hasMore: false, nextOffset: null } as T;
      };
      const result = await asReader(() => list(cfg, enrichment(enrich), { callGateway }));
      expect(pages).toBe(2);
      expect(JSON.stringify(result)).not.toContain(privateText);
      expect(result.details).toMatchObject({ count: 0, sessions: [] });
    });
  },
);

test.each([
  ["revoked", "agent tool caller authority is no longer active"],
  ["aborted", "Inventory read cancelled"],
  ["replaced", "Gateway instance unavailable for sessions.list"],
] as const)("does not disclose title reads after the caller is %s", async (change, error) => {
  await withInventory(async ({ cfg, context, asReader }) => {
    const controller = new AbortController();
    let current = true;
    let currentGateway: typeof context | undefined = context;
    interceptTitles(() => {
      if (change === "revoked") {
        current = false;
      } else if (change === "aborted") {
        controller.abort(new Error("Inventory read cancelled"));
      } else {
        currentGateway = undefined;
      }
    });
    const caller = {
      agentId: "main",
      sessionKey: "agent:main:requester",
      operationalRunInstance: { instanceId: "inventory-instance", runId: "inventory-run" },
      receiptAuthority: () => current,
    };
    const invoke = () => list(cfg, { includeLastMessage: true }, {}, controller.signal);
    const pending = asReader(() =>
      withPluginRuntimeGatewayContextResolver(
        () => currentGateway,
        () => withGatewayToolCallerIdentity(caller, invoke),
      ),
    );
    await expect(pending).rejects.toThrow(error);
  });
});

test.each([
  { stage: "titles", change: "draft", policy: "named role" },
  { stage: "chat.history", change: "draft", policy: "named role" },
  { stage: "chat.history", change: "draft", policy: "shared profile" },
  { stage: "chat.history", change: "role", policy: "named role" },
  { stage: "chat.history", change: "lifecycle", policy: "named role" },
  { stage: "chat.history", change: "metadata", policy: "named role" },
  { stage: "chat.history", change: "lifecycle", policy: "embedded" },
] as const)(
  "rechecks $policy enrichment after a $change change during $stage",
  async ({ stage, change, policy }) => {
    await withInventory(async ({ cfg, viewerId, context, asReader, setConfig }) => {
      const embedded = policy === "embedded";
      const unbind = embedded
        ? bindEmbeddedSessionRowProjection(
            Promise.resolve(expectDefined(getSessionRowProjection(context), "embedded projection")),
          )
        : undefined;
      const gateway = embedded ? createEmbeddedCallGateway() : callAgentToolGatewayRequest;
      try {
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
          interceptTitles(async (scope, fields) => {
            if (scope.sessionKey === first.sessionKey) {
              expect(fields.lastMessagePreview).toBe(bufferedText);
            }
            await afterRead(scope.sessionKey);
          });
        }
        const callGateway = interceptGateway(async (request, response) => {
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
        }, gateway);
        const args = {
          ...enrichment(!embedded),
          ...(stage === "chat.history" ? { messageLimit: 1 } : {}),
        };
        const options = {
          callGateway,
          supportsActiveOnly: !embedded,
          requireSessionReadOwner: embedded,
        };
        const invoke = () => list(cfg, args, options);
        const pending = embedded ? invoke() : asReader(invoke);
        if (change === "role") {
          await expect(pending).rejects.toThrow(
            "Your operator role changed; reconnect before continuing.",
          );
          expect(changed).toBe(true);
        }
        const result =
          change === "role"
            ? await asReader(() => list(cfg, { ...enrichment(), messageLimit: 1 }))
            : await pending;
        expect(changed).toBe(true);
        const metadata = change === "metadata";
        const survivingRow = {
          key: second.sessionKey,
          ...(!embedded && !metadata
            ? {
                derivedTitle: "Shared question 1",
                lastMessagePreview: "Still-visible reply",
              }
            : {}),
        };
        expect(result.details).toMatchObject({
          count: metadata ? 2 : 1,
          sessions: metadata ? [{ key: first.sessionKey }, survivingRow] : [survivingRow],
        });
        expect(JSON.stringify(result).includes(bufferedText)).toBe(metadata);
        expect(JSON.stringify(result)).toContain("Still-visible reply");
      } finally {
        unbind?.();
      }
    });
  },
);

test("rejects lost in-process read custody while preserving external RPC results", async () => {
  await withInventory(async ({ cfg, asReader }) => {
    const cloned: AgentToolGatewayRequestCaller = async <T>(request: GatewayRequest) =>
      structuredClone(await callAgentToolGatewayRequest<T>(request));
    await expect(
      asReader(() => list(cfg, { messageLimit: 1 }, { callGateway: cloned })),
    ).rejects.toThrow("Session enrichment requires its Gateway or embedded read owner");

    const external: AgentToolGatewayRequestCaller = async <T>(request: GatewayRequest) =>
      asReader(() => cloned<T>(request));
    const result = await list(cfg, { messageLimit: 1 }, { callGateway: external });
    expect(result.details).toMatchObject({ count: 2 });
    expect(JSON.stringify(result)).toContain(bufferedText);
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
      seed({ agentId: "main", sessionKey: "global", storePath }, ownerId, sessionId, updatedAt);
      registerOpenClawAgentDatabase({ agentId: "main", path: storePath });
    }
    append(original, bufferedText);
    const originalConfig: OpenClawConfig = { ...cfg, session: { scope: "global", store: oldPath } };
    setConfig(originalConfig);
    let changed = false;
    const callGateway = interceptGateway(async (request, response) => {
      if (request.method === "chat.history") {
        expect(JSON.stringify(response)).toContain(bufferedText);
        await patchSessionEntryCore(original, () => ({ visibility: "draft" }));
        setConfig({ ...originalConfig, session: { scope: "global", store: newPath } });
        const projection = expectDefined(getSessionRowProjection(context), "physical stores");
        const currentRef = { agentId: "main", key: "global" };
        const oldRef = { ...currentRef, storePath: oldPath };
        await withReadySessionRows(
          projection,
          () => [currentRef, oldRef],
          (read) => {
            expect(read.describe(currentRef)?.entry).toMatchObject({ sessionId: "new-global" });
            expect(read.describe(oldRef)?.entry).toMatchObject({ visibility: "draft" });
          },
        );
        changed = true;
      }
    });
    const result = await asReader(() =>
      list(originalConfig, { limit: 1, messageLimit: 1 }, { callGateway }),
    );
    expect(changed).toBe(true);
    expect(result.details).toMatchObject({ count: 0, sessions: [] });
    expect(JSON.stringify(result)).not.toContain(bufferedText);
  });
});
