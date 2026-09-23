import { createHash } from "node:crypto";
import type { Worker } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { formatSqliteSessionFileMarker } from "../config/sessions/legacy-sqlite-marker.js";
import { createSessionEntryWithTranscript } from "../config/sessions/session-accessor.js";
import {
  resolveSqliteTranscriptScope,
  toDatabaseOptions,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import { appendTranscriptEventsInTransaction } from "../config/sessions/session-accessor.sqlite-transcript-store.js";
import {
  resolveOpenClawAgentSqlitePath,
  runOpenClawAgentWriteTransaction,
} from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  readSessionCostUsageRollupEntry,
  readSessionCostUsageRollupRows,
} from "./session-cost-usage-cache.test-support.js";
import { resolveUsageCostPricingFingerprint } from "./session-cost-usage-pricing-context.js";
import { prepareUsageCostWorker, runUsageCostWorker } from "./session-cost-usage-worker-runtime.js";

const observed = vi.hoisted(() => ({ limits: new Set<number | undefined>() }));
vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  return {
    ...actual,
    Worker: class extends actual.Worker {
      override postMessage(...args: Parameters<Worker["postMessage"]>): void {
        const message = args[0];
        if (isRecord(message) && isRecord(message.input) && message.input.kind === "usage-cost") {
          observed.limits.add(this.resourceLimits?.maxOldGenerationSizeMb);
        }
        super.postMessage(...args);
      }
    },
  };
});

// The ordinary regression stays small. Opt in on an isolated runner for the real 512 MiB proof.
const heapProof = process.env.OPENCLAW_USAGE_HEAP_PROOF === "1";

it("preserves full rebuild, append, branch selection and byte anchors within the usage worker heap", async () => {
  observed.limits.clear();
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const agentId = "usage-memory";
    const sessionId = "usage-memory-session";
    const scope = resolveSqliteTranscriptScope({
      agentId,
      sessionId,
      sessionKey: `agent:${agentId}:usage-memory`,
      env: state.env,
    });
    expect(
      await createSessionEntryWithTranscript(
        scope,
        () => ({ ok: true, entry: { sessionId, updatedAt: 1 } }),
        { cwd: state.workspaceDir },
      ),
    ).toMatchObject({ ok: true });
    const count = heapProof ? 640 : 8;
    const payload = "x".repeat(heapProof ? 1024 * 1024 : 4096);
    const event = (id: string, parentId: string | null, appendMode?: "side") => ({
      type: "message",
      id,
      parentId,
      ...(appendMode ? { appendMode } : {}),
      timestamp: "2026-09-23T00:00:00Z",
      message: {
        role: "assistant",
        provider: "test",
        model: "test",
        content: [
          { type: "text", text: payload },
          { type: "toolCall", id: `tool-${id}`, name: "read", arguments: {} },
        ],
        usage: { input: 7, output: 3, totalTokens: 10, cost: { total: 1 } },
      },
    });
    const append = (events: Parameters<typeof appendTranscriptEventsInTransaction>[2]) =>
      runOpenClawAgentWriteTransaction(
        (database) => appendTranscriptEventsInTransaction(database, scope, events),
        toDatabaseOptions(scope),
      );
    append(
      (function* () {
        for (let index = 0; index < count; index++) {
          yield event(`entry-${index}`, index === 0 ? null : `entry-${index - 1}`);
        }
      })(),
    );
    const databasePath = resolveOpenClawAgentSqlitePath(toDatabaseOptions(scope));
    const sessionFile = formatSqliteSessionFileMarker({
      agentId,
      sessionId,
      storePath: databasePath,
    });
    const prepared = prepareUsageCostWorker({
      agentId,
      databasePath,
      storePath: databasePath,
      sessionFiles: [sessionFile],
    });
    const pricingFingerprint = await resolveUsageCostPricingFingerprint(
      undefined,
      prepared.agentDir,
    );
    const verify = async (messages: number, lastEvent: unknown) => {
      expect(
        await runUsageCostWorker(prepared, { kind: "refresh", sessionFiles: [sessionFile] }),
      ).toMatchObject({ kind: "refresh" });
      expect(
        await runUsageCostWorker(prepared, {
          kind: "sessions",
          pricingFingerprint,
          sessions: [{ sessionId, sessionFile }],
          dayBucket: { mode: "utc-offset", utcOffsetMinutes: 0 },
        }),
      ).toMatchObject({
        kind: "sessions",
        summaries: [
          {
            totalTokens: 10 * messages,
            totalCost: messages,
            messageCounts: { assistant: messages, toolCalls: messages },
          },
        ],
        cacheStatus: { status: "fresh" },
      });
      const row = readSessionCostUsageRollupRows(agentId).find((item) => item.key === sessionFile);
      expect(row).toBeDefined();
      expect(readSessionCostUsageRollupEntry(row!, agentId)?.checkpoint).toMatchObject({
        kind: "sqlite",
        anchorHash: createHash("sha256").update(JSON.stringify(lastEvent)).digest("base64url"),
      });
    };
    await verify(count, event(`entry-${count - 1}`, `entry-${count - 2}`));
    const added = event("appended", `entry-${count - 1}`);
    append([added]);
    await verify(count + 1, added);
    const side = event("side", "appended", "side");
    append([side]);
    await verify(count + 1, side);
    const rewind = {
      type: "leaf",
      id: "rewind",
      parentId: "appended",
      targetId: "entry-0",
    };
    append([rewind]);
    await verify(1, rewind);
    const branch = event("branch", "entry-0");
    append([branch]);
    await verify(2, branch);
    expect([...observed.limits]).toEqual([512]);
  });
});
