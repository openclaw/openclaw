import { existsSync } from "node:fs";
import { expect, it } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { writeSessionEntry } from "../../config/sessions/session-accessor.sqlite-entry-store.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { readSessionUpdatedAtAsync } from "../../plugin-sdk/session-store-runtime.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createChannelInboundEnvelopeBuilderAsync } from "./envelope.js";

it("prepares fresh envelope timestamps without caller-thread SQL or creating missing stores", async () => {
  await withOpenClawTestState({ label: "channel-envelope-worker" }, async (state) => {
    const sessionKey = "agent:main:envelope-timestamp";
    const storePath = state.statePath("timestamp", "openclaw-agent.sqlite");
    const scope = { storePath, sessionKey, agentId: "main", env: state.env };
    const missingSql = observeHostDataSql();
    try {
      expect(await readSessionUpdatedAtAsync(scope)).toBeUndefined();
      expect(missingSql.queries).toEqual([]);
      expect(existsSync(storePath)).toBe(false);
    } finally {
      missingSql.restore();
    }

    const database = openOpenClawAgentDatabase({
      agentId: "main",
      path: storePath,
      env: state.env,
    });
    writeSessionEntry(database, sessionKey, { sessionId: "timestamp-session", updatedAt: 60_000 });
    const cfg: OpenClawConfig = {
      agents: { defaults: { userTimezone: "UTC" } },
      session: { store: storePath },
    };
    const input = { channel: "Telegram", from: "Alice", body: "hello", timestamp: 180_000 };
    const sql = observeHostDataSql();
    let buildEnvelope: Awaited<ReturnType<typeof createChannelInboundEnvelopeBuilderAsync>>;
    try {
      expect(await readSessionUpdatedAtAsync(scope)).toBe(60_000);
      buildEnvelope = await createChannelInboundEnvelopeBuilderAsync({
        cfg,
        route: { agentId: "main", sessionKey },
      });
      expect(buildEnvelope(input)).toBe("[Telegram Alice +2m Thu 1970-01-01T00:03:00Z] hello");
      expect(buildEnvelope({ ...input, previousTimestamp: null })).toBe(
        "[Telegram Alice Thu 1970-01-01T00:03:00Z] hello",
      );
      expect(sql.queries).toEqual([]);
    } finally {
      sql.restore();
    }

    // The canonical host connection commits independently of the worker's retained reader.
    writeSessionEntry(database, sessionKey, { sessionId: "timestamp-session", updatedAt: 120_000 });
    const refreshedSql = observeHostDataSql();
    try {
      expect(await readSessionUpdatedAtAsync(scope)).toBe(120_000);
      const nextEnvelope = await createChannelInboundEnvelopeBuilderAsync({
        cfg,
        route: { agentId: "main", sessionKey },
      });
      expect(nextEnvelope(input)).toBe("[Telegram Alice +1m Thu 1970-01-01T00:03:00Z] hello");
      expect(buildEnvelope(input)).toBe("[Telegram Alice +2m Thu 1970-01-01T00:03:00Z] hello");
      expect(refreshedSql.queries).toEqual([]);
    } finally {
      refreshedSql.restore();
    }
  });
});
