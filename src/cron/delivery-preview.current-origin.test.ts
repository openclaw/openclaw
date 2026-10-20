import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../test/helpers/sqlite-statement-execution-counter.js";
import {
  deleteSessionEntryLifecycle,
  replaceSessionEntry,
  replaceSessionEntrySync,
  resetSessionEntryLifecycle,
} from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import {
  getOpenClawAgentDatabaseIfOpen,
  resolveOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.js";
import {
  createChannelTestPluginBase,
  createDirectOutboundTestAdapter,
  createTestRegistry,
} from "../test-utils/channel-plugins.js";
import { requireNativeSqliteDatabase } from "../test-utils/native-sqlite.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  normalizeSessionDeliveryState,
  type DeliveryContext,
} from "../utils/delivery-context.shared.js";
import { resolveCronDeliveryPreview, resolveCronDeliveryPreviews } from "./delivery-preview.js";
import { makeCronJob } from "./delivery.test-helpers.js";
import { resolveDeliveryTarget } from "./isolated-agent/delivery-target.js";
import type { CronDelivery, CronJob, CronStoredJob } from "./types.js";

afterEach(() => resetPluginRuntimeStateForTest());

const sourceRoute = { channel: "telegram", to: "recipient" };
function sessionEntry(
  context: DeliveryContext | undefined,
  sessionId = "source-session",
  updatedAt = 1,
) {
  return { sessionId, updatedAt, delivery: normalizeSessionDeliveryState({ context }) };
}

function blockedPreview(detail = "will be blocked", destination = "last") {
  return { label: `announce -> ${destination}`, detail: expect.stringContaining(detail) };
}

function externalPreview(to: string) {
  return {
    label: `announce -> telegram:${to}`,
    detail: "commits to the destination conversation; sends one external notification",
  };
}

function conversationPreview(destination = "current session") {
  return {
    label: `announce -> ${destination}`,
    detail: "commits to this conversation (no external channel route)",
  };
}

function target(cfg: OpenClawConfig, job: CronStoredJob, delivery = job.delivery) {
  return resolveDeliveryTarget(cfg, "main", {
    ...delivery,
    sessionKey: job.sessionKey,
    sessionTarget: job.sessionTarget,
    sourceConversation: job.sourceConversation,
  });
}

async function withCurrentOrigin(
  options: {
    surface?: string;
    channelCount?: number;
    delivery?: CronDelivery;
    source?: DeliveryContext;
    sessionTarget?: "current" | "isolated";
  },
  check: (fixture: {
    cfg: OpenClawConfig;
    job: CronStoredJob;
    preview: () => ReturnType<typeof resolveCronDeliveryPreview>;
  }) => Promise<void>,
) {
  await withOpenClawTestState({ layout: "home" }, async (state) => {
    setActivePluginRegistry(
      createTestRegistry(
        ["telegram", "discord"].slice(0, options.channelCount ?? 1).map((id) => ({
          pluginId: id,
          plugin: {
            ...createChannelTestPluginBase({ id }),
            outbound: createDirectOutboundTestAdapter({ channel: id }),
          },
          source: "test",
        })),
      ),
    );
    const sessionKey = `agent:main:${options.surface ?? "dashboard"}:current-origin`;
    const storePath = path.join(state.sessionsDir(), "sessions.json");
    const cfg: OpenClawConfig = {
      agents: { entries: { main: { workspace: state.workspaceDir } } },
      session: { store: storePath },
    };
    // Keep fixture maintenance outside the preview read counter.
    replaceSessionEntrySync(
      { agentId: "main", sessionKey, storePath },
      sessionEntry(
        options.source ?? (options.surface === "webchat" ? { channel: "webchat" } : undefined),
      ),
    );
    const job: CronStoredJob = makeCronJob({
      agentId: "main",
      sessionTarget: options.sessionTarget ?? "current",
      sessionKey,
      delivery: options.delivery ?? { mode: "announce" },
    });
    if (options.sessionTarget === "isolated") {
      job.sourceConversation = { sessionKey, sessionId: "source-session" };
    }
    await check({ cfg, job, preview: () => resolveCronDeliveryPreview({ cfg, job }) });
  });
}

it.each(["single", "batch"] as const)(
  "resolves %s previews without routing history beside healthy jobs",
  (mode) =>
    withCurrentOrigin({ source: sourceRoute }, async ({ job }) => {
      const cfg: OpenClawConfig = { agents: { entries: { main: {}, missing: {} } } };
      const databasePath = resolveOpenClawAgentSqlitePath({ agentId: "missing" });
      expect(fs.existsSync(databasePath)).toBe(false);
      const missing = makeCronJob({
        id: "missing-current",
        agentId: "missing",
        sessionTarget: "current",
        sessionKey: "agent:missing:dashboard:current-origin",
        delivery: { mode: "announce" },
      });
      const explicit = {
        ...missing,
        id: "missing-explicit",
        delivery: { mode: "announce", channel: "telegram", to: "explicit-recipient" },
      } satisfies CronJob;
      const jobs = [
        { ...job, id: "healthy" },
        missing,
        { ...missing, id: "missing-last", sessionTarget: "isolated" as const },
        explicit,
      ];
      await expect(
        resolveDeliveryTarget(cfg, "missing", {
          ...explicit.delivery,
          sessionKey: explicit.sessionKey,
          sessionTarget: explicit.sessionTarget,
        }),
      ).resolves.toMatchObject({ ok: true, channel: "telegram", to: "explicit-recipient" });

      const previews =
        mode === "batch"
          ? await resolveCronDeliveryPreviews({ cfg, jobs })
          : Object.fromEntries(
              await Promise.all(
                jobs.map(async (entry) => [
                  entry.id,
                  await resolveCronDeliveryPreview({ cfg, job: entry }),
                ]),
              ),
            );
      expect(previews).toEqual({
        healthy: externalPreview("recipient"),
        "missing-current": conversationPreview(),
        "missing-last": blockedPreview(
          "last -> no route, will be blocked: Delivering to telegram requires target",
        ),
        "missing-explicit": externalPreview("explicit-recipient"),
      });
      expect(fs.existsSync(databasePath)).toBe(false);
    }),
);

it("records a lost metadata table beside two healthy delivery previews", () =>
  withCurrentOrigin({ source: sourceRoute }, async ({ job }) => {
    const cfg: OpenClawConfig = { agents: { entries: { main: {}, interrupted: {} } } };
    const interrupted = makeCronJob({
      id: "interrupted",
      agentId: "interrupted",
      sessionTarget: "current",
      sessionKey: "agent:interrupted:dashboard:current-origin",
      delivery: { mode: "announce" },
    });
    replaceSessionEntrySync(
      { agentId: "interrupted", sessionKey: interrupted.sessionKey! },
      { sessionId: "interrupted-source", updatedAt: 1 },
    );
    const { db } = getOpenClawAgentDatabaseIfOpen({ agentId: "interrupted" })!;
    db.exec("DROP TABLE session_nodes");
    const previews = await resolveCronDeliveryPreviews({
      cfg,
      jobs: [
        { ...job, id: "healthy-current" },
        interrupted,
        {
          ...job,
          id: "healthy-explicit",
          delivery: { mode: "announce", channel: "telegram", to: "other-recipient" },
        },
      ],
    });
    expect(previews).toEqual({
      "healthy-current": externalPreview("recipient"),
      interrupted: {
        label: "announce -> last",
        detail: expect.stringMatching(/^delivery preview unavailable: .*table-missing/u),
      },
      "healthy-explicit": externalPreview("other-recipient"),
    });
  }));

it("uses a recovered source route when the configured primary store is absent", () =>
  withCurrentOrigin(
    { source: { ...sourceRoute, accountId: "work", threadId: "topic" } },
    async ({ cfg, job, preview }) => {
      const primaryPath = path.join(path.dirname(cfg.session!.store!), "absent-primary.sqlite");
      cfg.session = { store: primaryPath };
      expect(fs.existsSync(primaryPath)).toBe(false);

      await expect(target(cfg, job, { mode: "announce", channel: "last" })).resolves.toMatchObject({
        ok: true,
        channel: "telegram",
        to: "recipient",
        accountId: "work",
        threadId: "topic",
        mode: "implicit",
      });
      const expected = externalPreview("recipient");
      expect(await preview()).toEqual(expected);
      expect(await resolveCronDeliveryPreviews({ cfg, jobs: [job] })).toEqual({
        [job.id]: expected,
      });
      expect(fs.existsSync(primaryPath)).toBe(false);
    },
  ));

it("shares alias reads across a preview batch and refreshes routes on the next request", () =>
  withCurrentOrigin({ channelCount: 1 }, async ({ cfg, job }) => {
    const storePath = cfg.session!.store!;
    for (let index = 0; index < 64; index++) {
      replaceSessionEntrySync(
        { agentId: "main", storePath, sessionKey: `agent:main:dashboard:other-${index}` },
        { sessionId: `other-${index}`, updatedAt: 1 },
      );
    }
    const database = getOpenClawAgentDatabaseIfOpen({ agentId: "main" })!;
    const reads = trackSqliteStatementExecutions(
      requireNativeSqliteDatabase(database.db),
      ["sessions"],
      (sql) => (sql.includes('from "session_nodes"') ? "sessions" : null),
    );
    const jobs = Array.from({ length: 53 }, (_, index) => ({ ...job, id: `preview-${index}` }));
    const agentsRoot = path.dirname(path.dirname(path.dirname(storePath)));
    const checkBatch = async (label: string) => {
      const rosterReads = vi.spyOn(fs, "readdirSync");
      try {
        const previews = await resolveCronDeliveryPreviews({ cfg, jobs });
        expect(Object.keys(previews)).toEqual(jobs.map((entry) => entry.id));
        expect(Object.values(previews).map((entry) => entry.label)).toEqual(jobs.map(() => label));
        expect(
          rosterReads.mock.calls.filter(([directory]) => directory === agentsRoot),
        ).toHaveLength(1);
      } finally {
        rosterReads.mockRestore();
      }
    };
    try {
      await checkBatch("announce -> current session");
      // One store-sized read scope, independent of the number of repeated jobs.
      expect(reads.rowCounts.sessions).toBeLessThanOrEqual(4 * 65);
    } finally {
      reads.restore();
    }
    await replaceSessionEntry(
      { agentId: "main", storePath, sessionKey: job.sessionKey! },
      sessionEntry(sourceRoute),
    );
    await checkBatch("announce -> telegram:recipient");
  }));

it.each([
  { surface: "dashboard", channelCount: 2, sessionTarget: "current" as const },
  { surface: "webchat", channelCount: 1, sessionTarget: "current" as const },
  { surface: "dashboard", channelCount: 2, sessionTarget: "isolated" as const },
  { surface: "webchat", channelCount: 1, sessionTarget: "isolated" as const },
])(
  "keeps a $sessionTarget $surface completion in its conversation with $channelCount unrelated channels",
  (options) =>
    withCurrentOrigin(options, async ({ preview }) => {
      expect(await preview()).toEqual(
        conversationPreview(
          options.sessionTarget === "current" ? "current session" : "creating conversation",
        ),
      );
    }),
);

it.each([
  { coordinates: { channel: "telegram" }, channelCount: 1 },
  { coordinates: { to: "recipient" }, channelCount: 1 },
  { coordinates: { to: "recipient" }, channelCount: 0 },
  { coordinates: { accountId: "work" }, channelCount: 0 },
  { coordinates: { threadId: 0 }, channelCount: 2 },
])(
  "retains explicit delivery coordinates $coordinates with $channelCount channels",
  ({ coordinates, channelCount }) =>
    withCurrentOrigin(
      { channelCount, delivery: { mode: "announce", ...coordinates } },
      async ({ cfg, job, preview }) => {
        const resolved = await target(cfg, job);
        expect(resolved).toMatchObject({
          channel: channelCount === 1 ? "telegram" : undefined,
          ok: channelCount === 1 && "to" in coordinates,
        });
        if (channelCount !== 1) {
          expect(await preview()).toMatchObject(
            blockedPreview("will be blocked", "to" in coordinates ? "last:recipient" : "last"),
          );
        }
      },
    ),
);

it("preserves the explicit recipient, account, and thread", async () => {
  const delivery = {
    mode: "announce",
    channel: "telegram",
    to: "recipient",
    accountId: "work",
    threadId: "topic",
  } as const;
  await withCurrentOrigin({ delivery }, async ({ cfg, job }) => {
    expect(await target(cfg, job, delivery)).toMatchObject({
      ok: true,
      channel: "telegram",
      to: "recipient",
      accountId: "work",
      threadId: "topic",
    });
  });
});

it.each(["current", "isolated"] as const)(
  "retains an unavailable external source route for %s",
  (sessionTarget) =>
    withCurrentOrigin(
      { sessionTarget, source: { channel: "unavailable-plugin", to: "recipient" } },
      async ({ cfg, job, preview }) => {
        const resolved = await target(cfg, job);
        expect(resolved).toMatchObject({ ok: false, channel: "unavailable-plugin" });
        expect((await preview()).detail).toContain("will be blocked");
      },
    ),
);

it("uses the creating conversation route without a public session key", () =>
  withCurrentOrigin(
    { sessionTarget: "isolated", source: sourceRoute },
    async ({ job, preview }) => {
      job.sessionKey = undefined;
      expect(await preview()).toEqual(externalPreview("recipient"));
    },
  ));

it("does not rebind implicit delivery when the public session key changes", () =>
  withCurrentOrigin({ sessionTarget: "isolated" }, async ({ cfg, job, preview }) => {
    const otherSessionKey = "agent:main:dashboard:other-conversation";
    await replaceSessionEntry(
      { agentId: "main", sessionKey: otherSessionKey, storePath: cfg.session!.store! },
      sessionEntry({ channel: "telegram", to: "other-recipient" }, "other-session", 2),
    );
    job.sessionKey = otherSessionKey;
    expect(await preview()).toEqual(conversationPreview("creating conversation"));
    job.delivery = { mode: "announce", channel: "telegram", to: "other-recipient" };
    expect(await preview()).toEqual(externalPreview("other-recipient"));
  }));

it.each(["replacement-session", "source-session"])(
  "rejects a replacement conversation's external route with sessionId=%s",
  (sessionId) =>
    withCurrentOrigin({ sessionTarget: "isolated" }, async ({ cfg, job, preview }) => {
      const sessionKey = job.sessionKey!;
      await resetSessionEntryLifecycle({
        agentId: "main",
        storePath: cfg.session!.store!,
        target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
        buildNextEntry: () => ({
          ...sessionEntry({ channel: "telegram", to: "replacement-recipient" }, sessionId, 2),
          lifecycleRevision: "replacement-generation",
        }),
      });
      expect(await preview()).toMatchObject(blockedPreview("original session generation"));
    }),
);

it("never redirects a deleted creating conversation to the shared main route", () =>
  withCurrentOrigin({ sessionTarget: "isolated" }, async ({ cfg, job }) => {
    const sessionKey = job.sessionKey!;
    const storePath = cfg.session!.store!;
    await replaceSessionEntry(
      { agentId: "main", sessionKey: "agent:main:main", storePath },
      sessionEntry({ channel: "telegram", to: "other-recipient" }, "other-conversation", 2),
    );
    await deleteSessionEntryLifecycle({
      agentId: "main",
      storePath,
      archiveTranscript: false,
      target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
    });
    const { ok, channel } = await target(cfg, job);
    expect({ ok, channel }).toEqual({ ok: false, channel: undefined });
  }));

it.each([0, 1])(
  "keeps command announcements on their channel path with %i channels",
  (channelCount) =>
    withCurrentOrigin({ channelCount }, async ({ job, preview }) => {
      job.payload = { kind: "command", argv: ["echo", "report"] };
      expect(await preview()).toMatchObject(blockedPreview());
    }),
);
