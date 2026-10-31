import { describe, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/io.js";
import {
  deleteSessionEntryLifecycle,
  resetSessionEntryLifecycle,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ProgressCardStore } from "../../session-cards/progress-card-store.types.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { withRestoredMocks } from "../../test-utils/vitest-spies.js";
import { progressCardStore } from "../progress-card-store.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { handleGatewayRequest } from "../server-methods.js";
import { createPlacementTestHold } from "../server-worker-placement-hold.test-support.js";
import { resolveSessionSharingTargetAsync } from "../session-sharing.js";
import { roleClient, rolePolicyConfig } from "../session-sharing.test-utils.js";
import { createLazyCoreHandlers } from "./lazy-core-handlers.js";
import { progressCardHandlers } from "./progress-card.js";
import type { GatewayRequestContext, RespondFn } from "./types.js";

type Target = { sessionKey: string; agentId: string };
const withState = (run: () => Promise<void>) =>
  withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, run);

function config(overrides: Partial<OpenClawConfig> = {}) {
  const cfg: OpenClawConfig = {
    ...rolePolicyConfig(),
    agents: { ownership: "explicit", entries: { main: {}, work: {} } },
    ...overrides,
  };
  setRuntimeConfigSnapshot(cfg, cfg);
  return cfg;
}

function cardContext(cfg: OpenClawConfig) {
  const broadcast = vi.fn();
  const context = {
    getRuntimeConfig: () => cfg,
    broadcast,
    logGateway: { warn: vi.fn() },
    resolveGatewayContext: (): GatewayRequestContext => context,
  } as unknown as GatewayRequestContext;
  return { context, broadcast };
}

function entry(client: ReturnType<typeof roleClient>, sessionId = "admitted-generation") {
  const id = client.authenticatedUserProfile!.profileId;
  return {
    sessionId,
    updatedAt: 1,
    visibility: "draft" as const,
    createdActor: { type: "human" as const, source: "profile" as const, id },
  };
}

const putCard = (target: Target, markdown: string) =>
  progressCardStore.put(target.sessionKey, { markdown }, target.agentId);
const getCard = (target: Target) => progressCardStore.get(target.sessionKey, target.agentId);
const cardParams = (method: string, target: Target, markdown: string, idempotencyKey: string) => ({
  ...target,
  ...(method === "progressCard.put" ? { markdown } : {}),
  ...(method === "progressCard.refresh" ? { idempotencyKey } : {}),
});
const changedAuthority = () =>
  expect.objectContaining({
    code: "INVALID_REQUEST",
    details: expect.objectContaining({ code: "SESSION_MUTATION_AUTHORIZATION_CHANGED" }),
  });

function requester(
  client: Parameters<typeof handleGatewayRequest>[0]["client"],
  context: GatewayRequestContext,
) {
  return (
    method: string,
    params: Record<string, unknown>,
    extraHandlers = progressCardHandlers,
  ) => {
    const respond = vi.fn<RespondFn>();
    const pending = handleGatewayRequest({
      client,
      context,
      respond,
      extraHandlers,
      req: { type: "req", id: "card-request", method, params },
      isWebchatConnect: () => false,
    });
    return { respond, pending };
  };
}

function pausedHandlers(method: string) {
  const gate = createPlacementTestHold();
  return {
    ...gate,
    handlers: createLazyCoreHandlers({
      methods: [method],
      loadHandlers: async () => {
        await gate.wait();
        return progressCardHandlers;
      },
    }),
  };
}

function pausedStore(beforeCommit = false, pauseWrites = false) {
  const gate = createPlacementTestHold();
  const read = progressCardStore.get.bind(progressCardStore);
  const write = progressCardStore.put.bind(progressCardStore);
  const store: ProgressCardStore = {
    async get(...args) {
      const card = await read(...args);
      await gate.wait();
      return card;
    },
    async put(...args) {
      if (pauseWrites && beforeCommit) {
        await gate.wait();
      }
      const result = await write(...args);
      if (pauseWrites && !beforeCommit) {
        await gate.wait();
      }
      return result;
    },
  };
  return { ...gate, store };
}

function withPausedStore(store: ProgressCardStore, run: () => Promise<void>) {
  return withRestoredMocks(
    [
      vi.spyOn(progressCardStore, "get").mockImplementation(store.get.bind(store)),
      vi.spyOn(progressCardStore, "put").mockImplementation(store.put.bind(store)),
    ],
    run,
  );
}

const awaitEntered = (entered: Promise<void>, pending: Promise<void>) =>
  Promise.race([
    entered,
    pending.then(() => {
      throw new Error("request completed before the delayed operation");
    }),
  ]);

describe("progress card request authorization", () => {
  it.each(["operator.sessions.read", "operator.sessions.write", "operator.read"])(
    "reads visible cards without participation under %s and hides private cards",
    (scope) =>
      withState(async () => {
        const cfg = rolePolicyConfig();
        setRuntimeConfigSnapshot(cfg, cfg);
        const client = roleClient("view", "card-viewer");
        client.connect.scopes = [scope];
        const owner = roleClient("view", "other-card-owner");
        const context = createDirectChatContext({ getRuntimeConfig: () => cfg });
        const request = requester(client, context);
        for (const [name, visibility, own, incognito, visible] of [
          ["foreign-shared", "shared", false, false, true],
          ["own-draft", "draft", true, false, true],
          ["foreign-draft", "draft", false, false, false],
          ["hidden-card", "shared", false, true, false],
        ] as const) {
          const sessionKey = `agent:main:${name}`;
          await upsertSessionEntryCore(
            { agentId: "main", sessionKey },
            {
              ...entry(own ? client : owner, name),
              visibility,
              ...(incognito ? { incognito } : {}),
            },
          );
          await putCard({ sessionKey, agentId: "main" }, name);
          using get = vi.spyOn(progressCardStore, "get");
          const { respond, pending } = request("progressCard.get", { sessionKey });
          await pending;
          expect(respond.mock.calls).toEqual([
            visible
              ? [true, { card: expect.objectContaining({ markdown: name }) }, undefined]
              : [
                  false,
                  undefined,
                  expect.objectContaining({
                    code: "INVALID_REQUEST",
                    message: expect.stringContaining("was not found"),
                  }),
                ],
          ]);
          expect(get).toHaveBeenCalledTimes(visible ? 1 : 0);
        }
      }),
  );

  it.each(["visibility", "source"] as const)(
    "does not publish a shared card after its %s changes during storage",
    (change) =>
      withState(async () => {
        const cfg = rolePolicyConfig();
        setRuntimeConfigSnapshot(cfg, cfg);
        const client = roleClient("view", "delayed-card-viewer");
        client.connect.scopes = ["operator.sessions.read"];
        const owner = roleClient("view", "delayed-card-owner");
        const target = { sessionKey: "agent:main:visible-card", agentId: "main" };
        await upsertSessionEntryCore(target, {
          ...entry(owner, "visible-generation"),
          visibility: "shared",
        });
        await putCard(target, "shared card");
        const { entered, release, store } = pausedStore();
        await withPausedStore(store, async () => {
          const context = createDirectChatContext({ getRuntimeConfig: () => cfg });
          const { respond, pending } = requester(client, context)("progressCard.get", target);
          const settled = Promise.allSettled([pending]);
          try {
            await awaitEntered(entered.promise, pending);
            expect(respond).not.toHaveBeenCalled();
            if (change === "visibility") {
              await upsertSessionEntryCore(target, { visibility: "draft" });
            } else {
              client.invalidated = true;
            }
            release.resolve();
            const [result] = await settled;
            if (change === "source") {
              expect(result).toEqual({
                status: "rejected",
                reason: new Error("Gateway requester authority changed"),
              });
              expect(respond).not.toHaveBeenCalled();
            } else {
              expect(result).toEqual({ status: "fulfilled", value: undefined });
              expect(respond).toHaveBeenCalledExactlyOnceWith(
                false,
                undefined,
                expect.objectContaining({ code: "INVALID_REQUEST" }),
              );
            }
          } finally {
            release.resolve();
            await settled;
          }
        });
      }),
  );

  it.each([
    { method: "progressCard.get", beforeCommit: false },
    { method: "progressCard.refresh", beforeCommit: false },
    { method: "progressCard.put", beforeCommit: true },
    { method: "progressCard.put", beforeCommit: false },
  ] as const)(
    "revalidates $method after delayed storage (beforeCommit=$beforeCommit)",
    ({ method, beforeCommit }) =>
      withState(async () => {
        const cfg = config();
        const target = { sessionKey: "global", agentId: "work" };
        const client = { ...roleClient("view", "card-owner"), connId: "card-owner" };
        const admitted = entry(client);
        await upsertSessionEntryCore(target, admitted);
        await putCard(target, "original card");
        const { entered, release, store } = pausedStore(beforeCommit, true);
        await withPausedStore(store, async () => {
          const { context, broadcast } = cardContext(cfg);
          const { respond, pending } = requester(client, context)(
            method,
            cardParams(method, target, "committed card", "delayed-refresh"),
          );
          try {
            await awaitEntered(entered.promise, pending);
            expect(respond).not.toHaveBeenCalled();
            expect(broadcast).not.toHaveBeenCalled();
            await upsertSessionEntryCore(target, {
              ...admitted,
              sessionId: "successor-generation",
              updatedAt: 2,
            });
          } finally {
            release.resolve();
            await pending;
          }
          expect(respond).toHaveBeenCalledExactlyOnceWith(false, undefined, changedAuthority());
          expect(broadcast).not.toHaveBeenCalled();
          expect(await getCard(target)).toMatchObject({
            markdown:
              method === "progressCard.put" && !beforeCommit ? "committed card" : "original card",
            revision: method === "progressCard.put" && !beforeCommit ? 2 : 1,
          });
        });
      }),
  );

  it("rejects a prepared card read before touching its replacement owner's storage", () =>
    withState(async () => {
      const cfg = config({ session: { scope: "per-sender" } });
      const target = { sessionKey: "global", agentId: "work" };
      const client = { ...roleClient("view", "admitted-owner"), connId: "admitted-owner" };
      const successor = roleClient("view", "successor-owner");
      await upsertSessionEntryCore(target, entry(client));
      await putCard(target, "original card");
      const { context, broadcast } = cardContext(cfg);
      const { entered, release, handlers } = pausedHandlers("progressCard.get");
      const { respond, pending } = requester(client, context)("progressCard.get", target, handlers);
      try {
        await awaitEntered(entered.promise, pending);
        expect(respond).not.toHaveBeenCalled();
        const resolved = await resolveSessionSharingTargetAsync({ cfg, ...target });
        if (!resolved) {
          throw new Error("expected the admitted persisted session");
        }
        await deleteSessionEntryLifecycle({
          agentId: resolved.agentId,
          archiveTranscript: false,
          expectedSessionId: "admitted-generation",
          storePath: resolved.storePath,
          target: { canonicalKey: resolved.canonicalKey, storeKeys: resolved.storeKeys },
        });
        await upsertSessionEntryCore(target, {
          ...entry(successor, "successor-generation"),
          updatedAt: 2,
        });
        await putCard(target, "successor card");
        const before = await getCard(target);
        {
          using get = vi.spyOn(progressCardStore, "get");
          release.resolve();
          await pending;
          expect(get).not.toHaveBeenCalled();
        }
        expect(respond.mock.calls).toEqual([[false, undefined, changedAuthority()]]);
        expect(await getCard(target)).toEqual(before);
        expect(broadcast).not.toHaveBeenCalled();
      } finally {
        release.resolve();
        await pending;
      }
    }));
});

it.each(
  [false, true].flatMap((admin) =>
    (["progressCard.put", "progressCard.refresh"] as const).map((method) => ({ admin, method })),
  ),
)("rejects pre-reset $method after a same-id reset (admin=$admin)", ({ admin, method }) =>
  withState(async () => {
    const cfg = config();
    const target = { sessionKey: "global", agentId: "work" };
    const client = { ...roleClient("view", "reset-card-owner"), connId: "reset-card-owner" };
    if (admin) {
      cfg.gateway!.roles!.definitions.view!.scopes.push("operator.admin");
      client.connect.scopes = ["operator.admin"];
    }
    await upsertSessionEntryCore(target, {
      ...entry(client, "same-card-session"),
      lifecycleRevision: "before",
    });
    await putCard(target, "previous card");
    const { context, broadcast } = cardContext(cfg);
    const { entered, release, handlers } = pausedHandlers(method);
    const { respond, pending } = requester(client, context)(
      method,
      cardParams(method, target, "stale write", "stale-refresh"),
      handlers,
    );
    try {
      await awaitEntered(entered.promise, pending);
      const resolved = (await resolveSessionSharingTargetAsync({ cfg, ...target }))!;
      await resetSessionEntryLifecycle({
        agentId: resolved.agentId,
        storePath: resolved.storePath,
        target: { canonicalKey: resolved.canonicalKey, storeKeys: resolved.storeKeys },
        resetBoundary: { context: "clear", reason: "reset", cwd: "/workspace" },
        buildNextEntry: ({ currentEntry }) => ({
          ...currentEntry!,
          lifecycleRevision: "after",
          updatedAt: 2,
        }),
      });
      await putCard(target, "fresh card");
      using get = vi.spyOn(progressCardStore, "get");
      using put = vi.spyOn(progressCardStore, "put");
      release.resolve();
      await pending;
      expect(get).not.toHaveBeenCalled();
      expect(put).not.toHaveBeenCalled();
      expect(respond).toHaveBeenCalledWith(false, undefined, changedAuthority());
      expect((await getCard(target))?.markdown).toBe("fresh card");
      expect(broadcast).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await pending;
    }
  }),
);
