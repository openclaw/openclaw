import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { trackSqliteStatementExecutions } from "../../test/helpers/sqlite-statement-execution-counter.js";
import {
  replaceSessionEntry,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { getOpenClawAgentDatabaseIfOpen } from "../state/openclaw-agent-db.js";
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
      } finally {
        reads.restore();
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
      const refreshed = await resolveCronDeliveryPreviews({ cfg, jobs });
      expect(
        Object.values(refreshed).every(
          (preview) => preview.label === "announce -> telegram:recipient",
        ),
      ).toBe(true);
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
