import "../test-utils/prepare-compiled-subprocesses.js";
import { afterEach, expect, it, vi } from "vitest";
import {
  isSessionEntryDataSql,
  observeHostDataSql,
} from "../../test/helpers/sqlite-statement-execution-counter.js";
import { patchSessionEntryCore } from "../config/sessions/session-accessor.js";
import {
  withIncognitoSessionActor,
  withIncognitoSessionBinding,
} from "../config/sessions/session-incognito-binding.js";
import { captureDeliveryQueueStateContext } from "../infra/delivery-queue-state-context.js";
import { hasRestartSentinel, writeRestartSentinel } from "../infra/restart-sentinel.js";
import { drainPendingSessionDelivery } from "../infra/session-delivery-queue-recovery.js";
import {
  loadPendingSessionDeliveries,
  enqueueSessionDelivery,
} from "../infra/session-delivery-queue-storage.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { openIncognitoTestActor } from "../state/openclaw-agent-execution-incognito.test-support.js";
import { captureOpenClawAgentDatabaseExecution } from "../state/openclaw-agent-execution.js";
import { createOutboundTestPlugin, createTestRegistry } from "../test-utils/channel-plugins.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { resolveGatewayConfigRestartWriteResult } from "./server-methods/config-write-flow.js";
import * as lifecycle from "./server-recovery-runtime-context.js";
import {
  deliverQueuedSessionDelivery,
  scheduleRestartSentinelWake,
  settleQueuedSessionDelivery,
} from "./server-restart-sentinel.js";

const sessionKey = "agent:main:dashboard:incognito-ended";

function observeHostSessionSql(env: NodeJS.ProcessEnv) {
  const agentPath = resolveOpenClawAgentSqlitePath({ agentId: "main", env });
  const sourceQueries: string[] = [];
  const observed = observeHostDataSql((sql, database) => {
    if (database?.location() === agentPath) {
      sourceQueries.push(sql);
    }
  });
  return {
    restore: observed.restore,
    assertNoSessionSql() {
      expect(sourceQueries).toEqual([]);
      expect(observed.queries.filter(isSessionEntryDataSql)).toEqual([]);
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  resetPluginRuntimeStateForTest();
});

it.each([false, true])(
  "settles a private restart origin without resuming it (explicit notice=%s)",
  async (explicit) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const cfg = { commands: { ownerAllowFrom: ["matrix:@owner:example.org"] } };
      await state.writeConfig(cfg);
      const send = vi.fn(async () => ({ channel: "matrix", messageId: "notice" }));
      setActivePluginRegistry(
        createTestRegistry([
          {
            pluginId: "matrix",
            source: "test",
            plugin: createOutboundTestPlugin({
              id: "matrix",
              outbound: { deliveryMode: "direct", sendText: send },
            }),
          },
        ]),
      );
      const dispatch = vi.spyOn(lifecycle, "dispatchGatewayLifecycleMethod");
      const context = captureDeliveryQueueStateContext();
      const env = context.workerContext.environment;
      const scheduler = createTestGatewayScheduler();
      await writeRestartSentinel(
        {
          kind: "config-patch",
          status: "ok",
          ts: 1,
          sessionKey,
          message: "Configuration updated",
          continuation: { kind: "agentTurn", message: "Resume private work" },
          ...(explicit ? { deliveryContext: { channel: "matrix", to: "@owner:example.org" } } : {}),
        },
        env,
      );
      const sql = observeHostSessionSql(context.workerContext.environment);
      try {
        await withIncognitoSessionBinding(
          { kind: "absent", agentId: "main", env, authority: { assertCurrent() {} } },
          () =>
            scheduleRestartSentinelWake({
              scheduler,
              signal: new AbortController().signal,
              deps: {},
              context,
            }),
        );
        expect(await hasRestartSentinel(env)).toBe(false);
        expect(await loadPendingSessionDeliveries(context.workerContext)).toEqual([]);
        expect(captureOpenClawAgentDatabaseExecution.listIncognito(env)).toEqual([]);
        expect(dispatch).not.toHaveBeenCalled();
        expect(send).toHaveBeenCalledTimes(explicit ? 1 : 0);
        sql.assertNoSessionSql();
      } finally {
        sql.restore();
        await scheduler.stop();
      }
    });
  },
);

it("settles an already queued private continuation without session discovery or actor creation", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const context = captureDeliveryQueueStateContext();
    const env = context.workerContext.environment;
    const id = await enqueueSessionDelivery(
      { kind: "agentTurn", sessionKey, message: "private work", messageId: "private-continuation" },
      context.workerContext,
    );
    const dispatch = vi.spyOn(lifecycle, "dispatchGatewayLifecycleMethod");
    await withIncognitoSessionBinding(
      { kind: "absent", agentId: "main", env, authority: { assertCurrent() {} } },
      () =>
        drainPendingSessionDelivery({
          id,
          queueContext: context.workerContext,
          logLabel: "private continuation",
          log: { info() {}, warn() {}, error() {} },
          deliver: (entry) =>
            deliverQueuedSessionDelivery({ deps: {}, entry, queueContext: context.workerContext }),
          onSettled: settleQueuedSessionDelivery,
        }),
    );
    expect(await loadPendingSessionDeliveries(context.workerContext)).toEqual([]);
    expect(captureOpenClawAgentDatabaseExecution.listIncognito(env)).toEqual([]);
    expect(dispatch).not.toHaveBeenCalled();
  });
});

it.each([false, true])(
  "keeps bound media delivery on the live actor (replaced=%s)",
  async (replaced) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      await state.writeConfig({ agents: { ownership: "explicit", entries: { main: {} } } });
      const context = captureDeliveryQueueStateContext();
      const actor = await openIncognitoTestActor(context.workerContext.environment, {
        assertCurrent() {},
      });
      const entry = { sessionId: "media-requester", lifecycleRevision: "original", updatedAt: 1 };
      await actor.sessions.create({ assertCurrent() {} }, { sessionKey, entry });
      const id = await withIncognitoSessionActor(actor, () =>
        enqueueSessionDelivery(
          {
            kind: "agentTurn",
            sessionKey,
            message: "Generated media is ready",
            messageId: "live-private-media",
            requesterBinding: {
              agentId: "main",
              sessionKey,
              storePath: state.statePath("agents", "main", "sessions", "sessions.json"),
              sessionId: entry.sessionId,
              lifecycleRevision: entry.lifecycleRevision,
            },
            inputProvenance: { kind: "inter_session", sourceTool: "image_generate" },
            sourceReplyDeliveryMode: "automatic",
            route: { channel: "matrix", to: "@owner:example.org", chatType: "direct" },
          },
          context.workerContext,
        ),
      );
      let sent = false;
      const dispatch = vi
        .spyOn(lifecycle, "dispatchGatewayLifecycleMethod")
        .mockImplementation(async (_method, _params, options) => {
          if (replaced) {
            await withIncognitoSessionActor(actor, () =>
              patchSessionEntryCore({ sessionKey, storePath: actor.path }, () => ({
                lifecycleRevision: "successor",
              })),
            );
          }
          options?.assertAdmissionCurrent?.();
          sent = true;
          return {
            status: "ok",
            result: { payloads: [{ text: "ready" }], deliveryStatus: { status: "sent" } },
          };
        });
      const sql = observeHostSessionSql(context.workerContext.environment);
      try {
        await withIncognitoSessionActor(actor, () =>
          drainPendingSessionDelivery({
            id,
            queueContext: context.workerContext,
            logLabel: "live private continuation",
            log: { info() {}, warn() {}, error() {} },
            deliver: (queued) =>
              deliverQueuedSessionDelivery({
                deps: {},
                entry: queued,
                queueContext: context.workerContext,
              }),
          }),
        );
        expect(dispatch).toHaveBeenCalledOnce();
        expect(dispatch.mock.calls[0]?.[1]).toMatchObject({
          sessionKey,
          expectedExistingSessionId: entry.sessionId,
          expectedExistingSessionLifecycleRevision: entry.lifecycleRevision,
        });
        expect(sent).toBe(!replaced);
        expect(await loadPendingSessionDeliveries(context.workerContext)).toHaveLength(
          replaced ? 1 : 0,
        );
        if (replaced) {
          await withIncognitoSessionActor(actor, () =>
            drainPendingSessionDelivery({
              id,
              queueContext: context.workerContext,
              bypassBackoff: true,
              logLabel: "replaced private continuation",
              log: { info() {}, warn() {}, error() {} },
              deliver: (queued) =>
                deliverQueuedSessionDelivery({
                  deps: {},
                  entry: queued,
                  queueContext: context.workerContext,
                }),
            }),
          );
          expect(await loadPendingSessionDeliveries(context.workerContext)).toEqual([]);
          expect(dispatch).toHaveBeenCalledOnce();
        }
        expect(actor.sessions.readSharing(sessionKey)?.entry?.lifecycleRevision).toBe(
          replaced ? "successor" : entry.lifecycleRevision,
        );
        sql.assertNoSessionSql();
      } finally {
        sql.restore();
        await actor.close();
      }
    });
  },
);

it.each([false, true])(
  "does not promote an actor's saved route into an explicit config notice (explicit=%s)",
  async (explicit) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const context = captureDeliveryQueueStateContext();
      const actor = await openIncognitoTestActor(context.workerContext.environment, {
        assertCurrent() {},
      });
      await actor.sessions.create(
        { assertCurrent() {} },
        {
          sessionKey,
          entry: {
            sessionId: "config-requester",
            updatedAt: 1,
            delivery: {
              kind: "external",
              route: { channel: "matrix", accountId: "default" },
              context: { channel: "matrix", to: "@saved:example.org", threadId: "saved-thread" },
              origin: {},
            },
          },
        },
      );
      try {
        const result = await withIncognitoSessionActor(actor, () =>
          resolveGatewayConfigRestartWriteResult({
            requestParams: {
              sessionKey,
              ...(explicit
                ? {
                    deliveryContext: {
                      channel: "matrix",
                      to: "@explicit:example.org",
                      threadId: "explicit-thread",
                    },
                  }
                : {}),
            },
            kind: "config-patch",
            mode: "config.patch",
            configPath: state.configPath,
            changedPaths: [],
            previousConfig: {},
            nextConfig: {},
            actor: {
              actor: "test",
              deviceId: "test-device",
              clientIp: "127.0.0.1",
              connId: "test-connection",
            },
          }),
        );
        expect(result.restart).toBeUndefined();
        expect(result.sentinelPersisted).toBe(true);
        expect(result.payload.deliveryContext).toEqual(
          explicit
            ? { channel: "matrix", to: "@explicit:example.org", accountId: undefined }
            : undefined,
        );
        expect(result.payload.threadId).toBe(explicit ? "explicit-thread" : undefined);
      } finally {
        await actor.close();
      }
    });
  },
);
