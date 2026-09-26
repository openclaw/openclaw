import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../test/helpers/sqlite-statement-execution-counter.js";
import {
  replaceSessionEntry,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { clearNodeSqliteKyselyCacheForDatabase } from "../infra/kysely-sync.js";
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
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  normalizeSessionDeliveryState,
  type DeliveryContext,
} from "../utils/delivery-context.shared.js";
import { resolveCronDeliveryPreview, resolveCronDeliveryPreviews } from "./delivery-preview.js";
import { makeCronJob } from "./delivery.test-helpers.js";
import { resolveDeliveryTarget } from "./isolated-agent/delivery-target.js";
import type { CronDelivery, CronJob } from "./types.js";

afterEach(() => resetPluginRuntimeStateForTest());

async function withCurrentOrigin(
  options: {
    surface?: string;
    channelCount?: number;
    delivery?: CronDelivery;
    source?: DeliveryContext;
  },
  check: (fixture: { cfg: OpenClawConfig; job: CronJob }) => Promise<void>,
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
      {
        sessionId: "source-session",
        updatedAt: 1,
        delivery: normalizeSessionDeliveryState({
          context:
            options.source ?? (options.surface === "webchat" ? { channel: "webchat" } : undefined),
        }),
      },
    );
    const job = makeCronJob({
      agentId: "main",
      sessionTarget: "current",
      sessionKey,
      delivery: options.delivery ?? { mode: "announce" },
    });
    await check({ cfg, job });
  });
}

describe("current cron delivery origin", () => {
  it.each(["single", "batch"] as const)(
    "resolves %s previews without routing history beside healthy jobs",
    async (mode) => {
      await withCurrentOrigin(
        { source: { channel: "telegram", to: "recipient" } },
        async ({ job }) => {
          const cfg: OpenClawConfig = {
            agents: { entries: { main: {}, missing: {} } },
          };
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
          ).resolves.toMatchObject({
            ok: true,
            channel: "telegram",
            to: "explicit-recipient",
          });

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
            healthy: {
              label: "announce -> telegram:recipient",
              detail: `resolved from last, session ${job.sessionKey}`,
            },
            "missing-current": {
              label: "announce -> current session",
              detail: "commits to this conversation (no external channel route)",
            },
            "missing-last": {
              label: "announce -> last",
              detail: "last -> no route, will fail-closed: Delivering to telegram requires target",
            },
            "missing-explicit": {
              label: "announce -> telegram:explicit-recipient",
              detail: "explicit",
            },
          });
          expect(fs.existsSync(databasePath)).toBe(false);
        },
      );
    },
  );

  it("records a lost metadata table beside two healthy delivery previews", async () => {
    await withCurrentOrigin(
      { source: { channel: "telegram", to: "recipient" } },
      async ({ job }) => {
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
        clearNodeSqliteKyselyCacheForDatabase(db);
        const prepare = db.prepare.bind(db);
        const prepareSpy = vi.spyOn(db, "prepare").mockImplementation((sql) => {
          if (sql.includes('from "session_key_contract"')) {
            prepareSpy.mockRestore();
            db.exec("DROP TABLE session_key_contract");
          }
          return prepare(sql);
        });
        try {
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
            "healthy-current": {
              label: "announce -> telegram:recipient",
              detail: `resolved from last, session ${job.sessionKey}`,
            },
            interrupted: {
              label: "announce -> last",
              detail: expect.stringMatching(/^delivery preview unavailable: .*table-missing/u),
            },
            "healthy-explicit": {
              label: "announce -> telegram:other-recipient",
              detail: "explicit",
            },
          });
        } finally {
          prepareSpy.mockRestore();
        }
      },
    );
  });

  it("uses a recovered source route when the configured primary store is absent", async () => {
    await withCurrentOrigin(
      { source: { channel: "telegram", to: "recipient", accountId: "work", threadId: "topic" } },
      async ({ cfg, job }) => {
        const primaryPath = path.join(path.dirname(cfg.session!.store!), "absent-primary.sqlite");
        cfg.session = { store: primaryPath };
        expect(fs.existsSync(primaryPath)).toBe(false);

        await expect(
          resolveDeliveryTarget(cfg, "main", {
            channel: "last",
            sessionKey: job.sessionKey,
            sessionTarget: job.sessionTarget,
          }),
        ).resolves.toMatchObject({
          ok: true,
          channel: "telegram",
          to: "recipient",
          accountId: "work",
          threadId: "topic",
          mode: "implicit",
        });
        const expected = {
          label: "announce -> telegram:recipient",
          detail: `resolved from last, session ${job.sessionKey}`,
        };
        expect(await resolveCronDeliveryPreview({ cfg, job })).toEqual(expected);
        expect(await resolveCronDeliveryPreviews({ cfg, jobs: [job] })).toEqual({
          [job.id]: expected,
        });
        expect(fs.existsSync(primaryPath)).toBe(false);
      },
    );
  });

  it("shares alias reads across a preview batch and refreshes routes on the next request", async () => {
    await withCurrentOrigin({ channelCount: 1 }, async ({ cfg, job }) => {
      const storePath = cfg.session!.store!;
      for (let index = 0; index < 64; index++) {
        replaceSessionEntrySync(
          { agentId: "main", storePath, sessionKey: `agent:main:dashboard:other-${index}` },
          { sessionId: `other-${index}`, updatedAt: 1 },
        );
      }
      const database = getOpenClawAgentDatabaseIfOpen({ agentId: "main" })!;
      const reads = trackSqliteStatementExecutions(database.db, ["sessions"], (sql) =>
        sql.includes('from "session_nodes"') ? "sessions" : null,
      );
      const jobs = Array.from({ length: 53 }, (_, index) => ({ ...job, id: `preview-${index}` }));
      const agentsRoot = path.dirname(path.dirname(path.dirname(storePath)));
      // Observe the real filesystem call; the discovery owner and its results stay intact.
      const rosterReads = vi.spyOn(fs, "readdirSync");
      try {
        const previews = await resolveCronDeliveryPreviews({ cfg, jobs });
        expect(Object.keys(previews)).toEqual(jobs.map((entry) => entry.id));
        expect(
          Object.values(previews).every(
            (preview) => preview.label === "announce -> current session",
          ),
        ).toBe(true);
        // One store-sized read scope, independent of the number of repeated jobs.
        expect(reads.rowCounts.sessions).toBeLessThanOrEqual(4 * 65);
        expect(
          rosterReads.mock.calls.filter(([directory]) => directory === agentsRoot),
        ).toHaveLength(1);
      } finally {
        reads.restore();
        rosterReads.mockRestore();
      }
      await replaceSessionEntry(
        { agentId: "main", storePath, sessionKey: job.sessionKey! },
        {
          sessionId: "source-session",
          updatedAt: 1,
          delivery: normalizeSessionDeliveryState({
            context: { channel: "telegram", to: "recipient" },
          }),
        },
      );
      const refreshedRosterReads = vi.spyOn(fs, "readdirSync");
      try {
        const refreshed = await resolveCronDeliveryPreviews({ cfg, jobs });
        expect(
          Object.values(refreshed).every(
            (preview) => preview.label === "announce -> telegram:recipient",
          ),
        ).toBe(true);
        expect(
          refreshedRosterReads.mock.calls.filter(([directory]) => directory === agentsRoot),
        ).toHaveLength(1);
      } finally {
        refreshedRosterReads.mockRestore();
      }
    });
  });

  it.each(
    ["dashboard", "webchat"].flatMap((surface) =>
      [0, 1, 2].map((channelCount) => ({ surface, channelCount })),
    ),
  )(
    "keeps a $surface completion in its conversation with $channelCount unrelated channels",
    async (options) => {
      await withCurrentOrigin(options, async ({ cfg, job }) => {
        expect(await resolveCronDeliveryPreview({ cfg, job })).toEqual({
          label: "announce -> current session",
          detail: "commits to this conversation (no external channel route)",
        });
      });
    },
  );

  it.each(
    [{ channel: "telegram" }, { to: "recipient" }, { accountId: "work" }, { threadId: 0 }].flatMap(
      (coordinates) =>
        ("channel" in coordinates ? [1] : [0, 1, 2]).map((channelCount) => ({
          coordinates,
          channelCount,
        })),
    ),
  )(
    "retains explicit delivery coordinates $coordinates with $channelCount channels",
    async ({ coordinates, channelCount }) => {
      await withCurrentOrigin(
        { channelCount, delivery: { mode: "announce", ...coordinates } },
        async ({ cfg, job }) => {
          const resolved = await resolveDeliveryTarget(cfg, "main", {
            ...job.delivery,
            sessionKey: job.sessionKey,
            sessionTarget: job.sessionTarget,
          });
          expect(resolved.channel).toBe(channelCount === 1 ? "telegram" : undefined);
          expect(resolved.ok).toBe(channelCount === 1 && "to" in coordinates);
          if (channelCount !== 1) {
            const preview = await resolveCronDeliveryPreview({ cfg, job });
            expect(preview.label).toBe(
              "to" in coordinates ? "announce -> last:recipient" : "announce -> last",
            );
            expect(preview.detail).toContain("will fail-closed");
          }
        },
      );
    },
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
      expect(
        await resolveDeliveryTarget(cfg, "main", {
          ...delivery,
          sessionKey: job.sessionKey,
          sessionTarget: job.sessionTarget,
        }),
      ).toMatchObject({
        ok: true,
        channel: "telegram",
        to: "recipient",
        accountId: "work",
        threadId: "topic",
      });
    });
  });

  it("retains failure for an unavailable external source route", async () => {
    await withCurrentOrigin(
      { source: { channel: "unavailable-plugin", to: "recipient" } },
      async ({ cfg, job }) => {
        const resolved = await resolveDeliveryTarget(cfg, "main", {
          ...job.delivery,
          sessionKey: job.sessionKey,
          sessionTarget: job.sessionTarget,
        });
        expect(resolved).toMatchObject({ ok: false, channel: "unavailable-plugin" });
        expect((await resolveCronDeliveryPreview({ cfg, job })).detail).toContain(
          "will fail-closed",
        );
      },
    );
  });

  it.each([0, 1])(
    "keeps command announcements on their channel path with %i channels",
    async (channelCount) => {
      await withCurrentOrigin({ channelCount }, async ({ cfg, job }) => {
        job.payload = { kind: "command", argv: ["echo", "report"] };
        const preview = await resolveCronDeliveryPreview({ cfg, job });
        expect(preview.label).toBe("announce -> last");
        expect(preview.detail).toContain("will fail-closed");
      });
    },
  );
});
