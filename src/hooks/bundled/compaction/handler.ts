import path from "node:path";
import type { OpenClawConfig } from "../../../config/config.js";
import type { MeridiaTraceEvent } from "../../../meridia/types.js";
import type { HookHandler } from "../../hooks.js";
import { appendJsonl, dateKeyUtc, resolveMeridiaDir, writeJson } from "../../../meridia/storage.js";
import { resolveHookConfig } from "../../config.js";

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  return value as Record<string, unknown>;
}

function nowIso(): string {
  return new Date().toISOString();
}

const compaction: HookHandler = async (event) => {
  if (event.type !== "agent") {
    return;
  }
  if (event.action !== "precompact" && event.action !== "compaction:end") {
    return;
  }

  const context = asObject(event.context) ?? {};
  const cfg = (context.cfg as OpenClawConfig | undefined) ?? undefined;
  const hookCfg = resolveHookConfig(cfg, "compaction");
  if (hookCfg?.enabled !== true) {
    return;
  }

  const sessionId = typeof context.sessionId === "string" ? context.sessionId : undefined;
  const sessionKey = typeof context.sessionKey === "string" ? context.sessionKey : event.sessionKey;
  const runId = typeof context.runId === "string" ? context.runId : undefined;

  const meridiaDir = resolveMeridiaDir(cfg, "compaction");
  const dateKey = dateKeyUtc(event.timestamp);
  const ts = nowIso();
  const tracePath = path.join(meridiaDir, "trace", `${dateKey}.jsonl`);

  if (event.action === "precompact") {
    const snapshotDir = path.join(meridiaDir, "snapshots", dateKey);
    const snapshotPath = path.join(
      snapshotDir,
      `${ts.replaceAll(":", "-")}-${sessionId ?? "unknown"}.json`,
    );
    const snapshot = {
      ts,
      sessionId,
      sessionKey,
      runId,
      assistantTextCount: context.assistantTextCount,
      assistantTextsTail: context.assistantTextsTail,
      toolMetaCount: context.toolMetaCount,
      toolMetasTail: context.toolMetasTail,
      lastToolError: context.lastToolError,
    };
    await writeJson(snapshotPath, snapshot);

    const traceEvent: MeridiaTraceEvent = {
      type: "precompact",
      ts,
      sessionId,
      sessionKey,
      runId,
      assistantTextCount:
        typeof context.assistantTextCount === "number" ? context.assistantTextCount : undefined,
      toolMetaCount: typeof context.toolMetaCount === "number" ? context.toolMetaCount : undefined,
      note: snapshotPath,
    };
    await appendJsonl(tracePath, traceEvent);
    return;
  }

  const traceEvent: MeridiaTraceEvent = {
    type: "compaction_end",
    ts,
    sessionId,
    sessionKey,
    runId,
    willRetry: Boolean(context.willRetry),
  };
  await appendJsonl(tracePath, traceEvent);
};

export default compaction;
