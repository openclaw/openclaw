import { setImmediate as nextTurn } from "node:timers/promises";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { PairedDevice } from "../infra/device-pairing.types.js";
import type {
  BoundWebPushSubscription,
  prepareWebPushNotificationSender,
} from "../infra/push-web.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createGatewayConnectionState } from "./server-connection-state.js";
import { createSessionRowProjection } from "./session-row-projection.js";

type PreparedSender = Awaited<ReturnType<typeof prepareWebPushNotificationSender>>;
const mocks = vi.hoisted(() => ({
  prepareSender: vi.fn<() => Promise<PreparedSender>>(),
  send: vi.fn<PreparedSender>(),
  finished: vi.fn<() => void>(),
}));

const subscription: BoundWebPushSubscription = {
  subscriptionId: "preview-browser",
  endpoint: "https://push.example.test/preview-browser",
  keys: { p256dh: "synthetic-key", auth: "synthetic-auth" },
  createdAtMs: 1,
  updatedAtMs: 1,
  deviceId: "preview-browser",
  userProfileId: null,
  devicePreferences: {
    enabled: true,
    label: "",
    detailLevel: "detailed",
    answerPreviewConsentVersion: 1,
    categories: { agentFinished: true },
  },
};

vi.mock("../infra/push-web.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/push-web.js")>()),
  hasBoundWebPushSubscriptions: async () => true,
  prepareWebPushNotificationSender: () => mocks.prepareSender(),
  withBoundWebPushSubscriptions: async <T>(
    _stateDir: string | undefined,
    prepare: (
      subscriptions: BoundWebPushSubscription[],
      assertCurrent: () => void,
    ) => Promise<{ start: () => T } | undefined>,
  ) => {
    try {
      return (await prepare([subscription], () => {}))?.start();
    } finally {
      mocks.finished();
    }
  },
}));
vi.mock("../infra/device-pairing-worker.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/device-pairing-worker.js")>()),
  withCurrentDevicePairingSnapshot: async <T>(
    _stateDir: string | undefined,
    prepare: (paired: PairedDevice[]) => { start: () => T } | undefined,
  ) =>
    prepare([
      {
        deviceId: "preview-browser",
        publicKey: "synthetic-key",
        role: "operator",
        roles: ["operator"],
        approvedScopes: ["operator.read"],
        tokens: {
          operator: {
            token: "synthetic-token",
            role: "operator",
            scopes: ["operator.read"],
            createdAtMs: 1,
          },
        },
        createdAtMs: 1,
        approvedAtMs: 1,
      },
    ])?.start(),
}));

afterEach(() => vi.restoreAllMocks());

it.each(["unchanged", "label", "reset", "generation", "missing projection"] as const)(
  "keeps delayed answer content on its original session after %s",
  async (change) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      vi.clearAllMocks();
      const cfg = { agents: { entries: { main: {} } } };
      await state.writeConfig(cfg);
      setRuntimeConfigSnapshot(cfg);
      const scope = { agentId: "main", sessionKey: "agent:main:answer-preview" };
      const entry: SessionEntry = {
        sessionId: "original-session",
        lifecycleRevision: "original-generation",
        updatedAt: 1,
      };
      const write = (delta: Partial<SessionEntry> = {}) =>
        upsertSessionEntryCore(scope, { ...entry, ...delta });
      await write();
      const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
      const connection = createGatewayConnectionState({
        cfg,
        scheduler: createTestGatewayScheduler(),
        bootId: "answer-preview-test",
      });
      const detach =
        change === "missing projection"
          ? () => {}
          : connection.attachSessionRowProjection(projection);
      const preparing = createDeferred();
      const sender = createDeferred<PreparedSender>();
      const finished = createDeferred();
      mocks.prepareSender.mockImplementation(() => {
        preparing.resolve();
        return sender.promise;
      });
      mocks.send.mockResolvedValue([]);
      mocks.finished.mockImplementation(() => finished.resolve());
      try {
        // Commit a real worker receipt into the live projection before publication.
        await write({ updatedAt: 2 });
        expect(
          projection.capture({ agentId: scope.agentId, key: scope.sessionKey })?.publishedSource,
          "committed session source before final broadcast",
        ).toBeDefined();
        const payload = {
          state: "final",
          runId: "original-run",
          ...scope,
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Original answer" }],
            openclawDisplayContent: [],
          },
        };
        const sql = observeHostDataSql();
        try {
          connection.broadcast("chat", payload, {
            agentId: scope.agentId,
            sessionKeys: [scope.sessionKey],
            answerPreviewText: "Original answer",
          });
          expect(sql.queries).toEqual([]);
        } finally {
          sql.restore();
        }
        await preparing.promise;
        if (change === "label") {
          await write({ label: "Renamed session", updatedAt: 3 });
        } else if (change === "reset") {
          await write({
            sessionId: "successor-session",
            lifecycleRevision: "successor-generation",
          });
        } else if (change === "generation") {
          await write({ lifecycleRevision: "successor-generation" });
        }
        sender.resolve(mocks.send);
        await finished.promise;
        await nextTurn();
        expect(mocks.send).toHaveBeenCalledOnce();
        const sent = expectDefined(mocks.send.mock.calls[0], "preview delivery")[0].payload;
        if (change === "unchanged" || change === "label") {
          expect(sent).toMatchObject({
            body: "Original answer",
            preview: { kind: "answer", runId: "original-run", sessionKey: scope.sessionKey },
          });
        } else {
          expect(sent).not.toHaveProperty("preview");
          expect(sent.body).not.toContain("Original answer");
        }
      } finally {
        sender.resolve(mocks.send);
        detach();
        projection.dispose();
        await connection.mentionInbox.dispose();
      }
    });
  },
);
