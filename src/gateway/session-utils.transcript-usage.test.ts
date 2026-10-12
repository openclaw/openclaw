import "./session-utils-provider.test-support.js";
import path from "node:path";
import { expect, test } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";
import { buildSessionRowFixture } from "./session-list.test-support.js";
import { readRecentSessionUsageFromTranscriptAsync } from "./session-transcript-usage.js";
import { buildSessionListRowMetadataContext } from "./session-utils-projection.js";
import {
  appendTranscriptMessages,
  createModelDefaultsConfig,
  seedSessionEntries,
  withStateDirEnv,
} from "./session-utils.test-support.js";

type RowParams = Parameters<typeof buildSessionRowFixture>[0];
async function buildGatewaySessionRow(params: RowParams) {
  const transcriptUsage =
    params.entry &&
    (await readRecentSessionUsageFromTranscriptAsync(
      {
        agentId: params.agentId ?? "main",
        sessionId: params.entry.sessionId,
        sessionKey: params.key,
        storePath: params.storePath,
      },
      256 * 1024,
    ));
  return buildSessionRowFixture({
    ...params,
    transcriptUsage,
    rowContext: buildSessionListRowMetadataContext({ now: params.now ?? Date.now() }),
    lightweightListRow: true,
  });
}

test("selected global rows read transcript usage from the selected agent", async () => {
  await withStateDirEnv("session-utils-selected-global-usage-", async ({ stateDir }) => {
    const sessionId = "selected-global-usage";
    for (const [agentId, input] of [
      ["main", 10],
      ["work", 40],
    ] as const) {
      const storePath = path.join(stateDir, "agents", agentId, "sessions", "sessions.json");
      seedSessionEntries(storePath, {
        global: { sessionId, updatedAt: 1 },
      });
      appendTranscriptMessages({
        agentId,
        sessionId,
        sessionKey: "global",
        storePath,
        messages: [
          {
            role: "assistant",
            content: "done",
            usage: { input, output: 2 },
          },
        ],
      });
    }

    const row = await buildGatewaySessionRow({
      cfg: {
        agents: { entries: { main: {}, work: {} } },
      } as OpenClawConfig,
      key: "global",
      agentId: "work",
      storePath: path.join(stateDir, "agents", "work", "sessions", "sessions.json"),
      store: {},
      entry: { sessionId, updatedAt: 1 },
    });

    expect(row.totalTokens).toBe(40);
  });
});

test("SQLite unavailable context blocks old totals until a later valid snapshot", async () => {
  await withStateDirEnv("session-utils-unavailable-usage-", async ({ stateDir }) => {
    const sessionId = "unavailable-usage";
    const sessionKey = "agent:main:main";
    const storePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
    const entry: SessionEntry = {
      sessionId,
      updatedAt: 1,
      totalTokens: 1_124_767,
      totalTokensFresh: false,
    };
    seedSessionEntries(storePath, { [sessionKey]: entry });
    appendTranscriptMessages({
      sessionId,
      sessionKey,
      storePath,
      messages: [
        {
          role: "assistant",
          api: "cli",
          content: "old cumulative turn",
          usage: {
            input: 128_814,
            output: 3_000,
            cacheRead: 992_953,
            totalTokens: 1_124_767,
          },
        },
      ],
    });

    const legacyRow = await buildGatewaySessionRow({
      cfg: createModelDefaultsConfig({ primary: "anthropic/claude-opus-4-7" }),
      storePath,
      store: { [sessionKey]: entry },
      key: sessionKey,
      entry,
    });
    expect(legacyRow.totalTokens).toBeUndefined();
    expect(legacyRow.totalTokensFresh).toBe(false);

    appendTranscriptMessages({
      sessionId,
      sessionKey,
      storePath,
      messages: [
        {
          role: "assistant",
          api: "cli",
          content: "usage unavailable",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            contextUsage: { state: "unavailable" },
          },
        },
      ],
    });

    const unavailableRow = await buildGatewaySessionRow({
      cfg: createModelDefaultsConfig({ primary: "anthropic/claude-opus-4-7" }),
      storePath,
      store: { [sessionKey]: entry },
      key: sessionKey,
      entry,
    });
    expect(unavailableRow.totalTokens).toBeUndefined();
    expect(unavailableRow.totalTokensFresh).toBe(false);

    appendTranscriptMessages({
      sessionId,
      sessionKey,
      storePath,
      messages: [
        {
          role: "assistant",
          api: "cli",
          content: "valid later turn",
          usage: {
            input: 67_932,
            output: 2_000,
            cacheRead: 18_944,
            totalTokens: 88_876,
            contextUsage: {
              state: "available",
              promptTokens: 86_876,
              totalTokens: 88_876,
            },
          },
        },
      ],
    });
    const validRow = await buildGatewaySessionRow({
      cfg: createModelDefaultsConfig({ primary: "anthropic/claude-opus-4-7" }),
      storePath,
      store: { [sessionKey]: entry },
      key: sessionKey,
      entry,
    });
    expect(validRow.totalTokens).toBe(86_876);
    expect(validRow.totalTokensFresh).toBe(true);
  });
});
