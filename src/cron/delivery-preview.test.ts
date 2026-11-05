import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../test/helpers/sqlite-statement-execution-counter.js";
import {
  replaceSessionEntry,
  replaceSessionEntrySync,
  resetSessionEntryLifecycle,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { memorySessionActorOwners } from "../config/sessions/session-actor-memory-owner.js";
import * as sessionGenerations from "../config/sessions/session-delivery-generation.js";
import * as sessionReads from "../config/sessions/session-entry-read-runtime.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { recordAgentDatabaseAdmissions } from "../state/agent-database-admission.js";
import {
  getOpenClawAgentDatabaseIfOpen,
  resolveOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
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
import type { CronDelivery, CronDeliveryPreview, CronJob, CronStoredJob } from "./types.js";

afterEach(() => resetPluginRuntimeStateForTest());

const sourceRoute = { channel: "telegram", to: "recipient" };
function currentJob(id: string, agentId = id) {
  return makeCronJob({
    id,
    agentId,
    sessionTarget: "current",
    sessionKey: `agent:${agentId}:dashboard:current-origin`,
    delivery: { mode: "announce" },
  });
}
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

async function withCurrentOrigin(
  options: {
    surface?: string;
    channelCount?: number;
    delivery?: CronDelivery;
    source?: DeliveryContext;
    sessionTarget?: "current" | "isolated";
    payload?: CronStoredJob["payload"];
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
      ...(options.payload ? { payload: options.payload } : {}),
    });
    if (options.sessionTarget === "isolated") {
      job.sourceConversation = { sessionKey, sessionId: "source-session" };
    }
    await check({ cfg, job, preview: () => resolveCronDeliveryPreview({ cfg, job }) });
  });
}

it("prefers the persistent target over the creator's route", () =>
  withCurrentOrigin({ source: sourceRoute }, async ({ cfg, job, preview }) => {
    const sessionKey = "agent:main:telegram:direct:persistent-recipient";
    await replaceSessionEntry(
      { agentId: "main", sessionKey, storePath: cfg.session!.store! },
      sessionEntry({ ...sourceRoute, to: "persistent-recipient" }, "persistent-session"),
    );
    job.sessionTarget = `session:${sessionKey}`;
    expect(await preview()).toEqual(externalPreview("persistent-recipient"));
  }));

it("lists a refused agent's repair reason beside a healthy preview", () =>
  withCurrentOrigin({ source: sourceRoute }, async ({ cfg, job }) => {
    const refusal = {
      agentId: "cleaner",
      paths: ["/synthetic/cleaner/openclaw-agent.sqlite"],
      embeddedOwnerId: "main",
      code: "agent-database-ownership-mismatch" as const,
      reason: "Refused agent cleaner: its database belongs to main.",
      repairHint: "Inspect the divergent copy and restart after repair.",
    };
    recordAgentDatabaseAdmissions([refusal]);
    try {
      expect(
        await resolveCronDeliveryPreviews({ cfg, jobs: [job, currentJob("cleaner")] }),
      ).toEqual({
        [job.id]: externalPreview("recipient"),
        cleaner: {
          label: "agent cleaner unavailable",
          detail: `${refusal.reason}\n${refusal.repairHint}`,
        },
      });
    } finally {
      recordAgentDatabaseAdmissions([]);
    }
  }));

it.each([
  [{ mode: "none" }, 1, "not requested", "not requested"],
  [
    { mode: "none", channel: "telegram", to: "recipient", accountId: "ops", threadId: 42 },
    1,
    "none -> telegram:recipient",
    "explicit",
  ],
  [
    { mode: "none", threadId: 0 },
    0,
    "none -> last",
    expect.stringContaining("message tool target unresolved:"),
  ],
] as const)("previews message-tool delivery %j", (delivery, channelCount, label, detail) =>
  withCurrentOrigin({ delivery, channelCount }, async ({ cfg, preview }) => {
    expect(await preview()).toEqual({ label, detail });
    if ("accountId" in delivery) {
      expect(await resolveDeliveryTarget(cfg, "main", delivery)).toMatchObject({
        ok: true,
        channel: "telegram",
        to: "recipient",
        accountId: "ops",
        threadId: 42,
      });
    }
  }),
);

it("resolves previews without routing history beside healthy jobs", () =>
  withCurrentOrigin({ source: sourceRoute }, async ({ job }) => {
    const cfg: OpenClawConfig = { agents: { entries: { main: {}, missing: {} } } };
    const databasePath = resolveOpenClawAgentSqlitePath({ agentId: "missing" });
    expect(fs.existsSync(databasePath)).toBe(false);
    const missing = currentJob("missing-current", "missing");
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
    const previews = await resolveCronDeliveryPreviews({ cfg, jobs });
    expect(previews).toEqual({
      healthy: externalPreview("recipient"),
      "missing-current": conversationPreview(),
      "missing-last": blockedPreview(
        "last -> no route, will be blocked: Delivering to telegram requires target",
      ),
      "missing-explicit": externalPreview("explicit-recipient"),
    });
    expect(fs.existsSync(databasePath)).toBe(false);
  }));

it("records a lost metadata table beside two healthy delivery previews", () =>
  withCurrentOrigin({ source: sourceRoute }, async ({ job }) => {
    const cfg: OpenClawConfig = { agents: { entries: { main: {}, interrupted: {} } } };
    const interrupted = currentJob("interrupted");
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

const unavailableRoute = { channel: "unavailable-plugin", to: "recipient" };
const commandPayload: CronStoredJob["payload"] = { kind: "command", argv: ["echo", "report"] };
it.each<[Parameters<typeof withCurrentOrigin>[0], CronDeliveryPreview]>([
  [{ surface: "dashboard", channelCount: 2, sessionTarget: "current" }, conversationPreview()],
  [{ surface: "webchat", sessionTarget: "current" }, conversationPreview()],
  [
    { surface: "dashboard", channelCount: 2, sessionTarget: "isolated" },
    conversationPreview("creating conversation"),
  ],
  [{ surface: "webchat", sessionTarget: "isolated" }, conversationPreview("creating conversation")],
  [
    { channelCount: 0, delivery: { mode: "announce", to: "recipient" } },
    blockedPreview("will be blocked", "last:recipient"),
  ],
  [{ channelCount: 0, delivery: { mode: "announce", accountId: "work" } }, blockedPreview()],
  [{ channelCount: 2, delivery: { mode: "announce", threadId: 0 } }, blockedPreview()],
  [{ sessionTarget: "current", source: unavailableRoute }, blockedPreview()],
  [{ sessionTarget: "isolated", source: unavailableRoute }, blockedPreview()],
  [{ channelCount: 0, payload: commandPayload }, blockedPreview()],
  [{ channelCount: 1, payload: commandPayload }, blockedPreview()],
])("previews conversation delivery %j", (options, expected) =>
  withCurrentOrigin(options, async ({ preview }) => {
    expect(await preview()).toEqual(expected);
  }),
);

it("uses the creating conversation route without a public session key", () =>
  withCurrentOrigin(
    { sessionTarget: "isolated", source: sourceRoute },
    async ({ job, preview }) => {
      job.sessionKey = undefined;
      expect(await preview()).toEqual(externalPreview("recipient"));
    },
  ));

it("batches creating-conversation reads while preserving each generation and refreshing next list", () =>
  withCurrentOrigin({ sessionTarget: "isolated" }, async ({ cfg, job }) => {
    const jobs = Array.from({ length: 12 }, (_, index) => {
      const sessionKey = `agent:main:dashboard:source-${index}`;
      const sessionId = `source-${index}`;
      replaceSessionEntrySync(
        { agentId: "main", sessionKey, storePath: cfg.session!.store! },
        sessionEntry(undefined, sessionId),
      );
      return { ...job, id: sessionId, sessionKey, sourceConversation: { sessionKey, sessionId } };
    });
    const reads = vi.spyOn(sessionReads, "withSessionEntriesFromStoresInWorker");
    try {
      expect(await resolveCronDeliveryPreviews({ cfg, jobs })).toEqual(
        Object.fromEntries(
          jobs.map((entry) => [entry.id, conversationPreview("creating conversation")]),
        ),
      );
      expect(
        reads.mock.calls.filter(([inputs]) =>
          inputs.some((input) => input.projection === "sharing"),
        ),
      ).toHaveLength(1);
      jobs[0]!.sourceConversation.sessionId = "superseded-session";
      const next = await resolveCronDeliveryPreviews({ cfg, jobs });
      expect(next[jobs[0]!.id]).toMatchObject(blockedPreview("original session generation"));
      expect(next[jobs[1]!.id]).toEqual(conversationPreview("creating conversation"));
    } finally {
      reads.mockRestore();
    }
  }));

it.each(["file", "memory"] as const)(
  "releases each %s source generation once per preview",
  (storage) =>
    withOpenClawTestState({ layout: "home" }, async (state) => {
      const memory = storage === "memory";
      const storePath = memory
        ? resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main" })
        : path.join(state.sessionsDir(), "sessions.json");
      const sessionKey = `agent:main:dashboard:${memory ? "incognito-" : ""}preview-release`;
      const sessionId = "preview-release";
      await upsertSessionEntryCore(
        { agentId: "main", storePath, sessionKey },
        { sessionId, updatedAt: 1, ...(memory ? { incognito: true } : {}) },
      );
      const cfg: OpenClawConfig = {
        agents: { entries: { main: {} } },
        session: { store: storePath },
      };
      const jobs = ["first", "second"].map((id) =>
        Object.assign(
          makeCronJob({
            id,
            agentId: "main",
            sessionTarget: "isolated",
            delivery: { mode: "announce" },
          }),
          { sourceConversation: { sessionKey, sessionId } },
        ),
      );
      const releases: Array<() => void> = [];
      const prepare = sessionGenerations.prepareSessionGenerationFactsBatch;
      vi.spyOn(sessionGenerations, "prepareSessionGenerationFactsBatch").mockImplementation(
        async (inputs) => {
          const generations = await prepare(inputs);
          for (const generation of generations) {
            if (generation.ok) {
              releases.push(vi.spyOn(generation.value, "release"));
            }
          }
          return generations;
        },
      );
      try {
        expect(await resolveCronDeliveryPreviews({ cfg, jobs })).toEqual({
          first: conversationPreview("creating conversation"),
          second: conversationPreview("creating conversation"),
        });
        expect(releases).toHaveLength(jobs.length);
        for (const release of releases) {
          expect(release).toHaveBeenCalledTimes(1);
        }
      } finally {
        vi.restoreAllMocks();
        if (memory) {
          memorySessionActorOwners.closeDatabase({ agentId: "main", path: storePath });
        }
      }
    }),
);

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
