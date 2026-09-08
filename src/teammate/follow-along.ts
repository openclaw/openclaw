/**
 * Native follow-along recorder: structured traces on the persistent computer,
 * compiled into skills, then offered as a weekday job bound to Bot + skill.
 */
import fs from "node:fs";
import path from "node:path";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { resolveStateDir } from "../config/paths.js";

export const FOLLOW_ALONG_SUCCESS_THRESHOLD = 2;
export const FOLLOW_ALONG_DEFAULT_WEEKDAY_EXPR = "0 8 * * 1-5";

export type FollowAlongEventKind =
  | "app"
  | "url"
  | "landmark"
  | "decision"
  | "approval"
  | "artifact"
  | "narration";

export type FollowAlongEvent = {
  ts: number;
  kind: FollowAlongEventKind;
  summary: string;
  url?: string;
  app?: string;
  artifact?: string;
};

export type FollowAlongTrace = {
  id: string;
  agentId: string;
  sessionKey: string;
  startedAt: number;
  stoppedAt?: number;
  events: FollowAlongEvent[];
};

export type CompiledFollowAlongSkill = {
  name: string;
  whenToUse: string;
  access: string;
  steps: string[];
  validation: string;
  deliverable: string;
  approvals: string;
  markdown: string;
};

export type FollowAlongSkillRecord = {
  skillName: string;
  agentId: string;
  sessionKey: string;
  successCount: number;
  lastTraceId: string;
  weekdayOffer?: {
    expr: string;
    offeredAt: number;
  };
};

function tracesDir(env?: NodeJS.ProcessEnv): string {
  return path.join(resolveStateDir(env), "follow-along");
}

function tracePath(trace: Pick<FollowAlongTrace, "agentId" | "id">, env?: NodeJS.ProcessEnv): string {
  return path.join(tracesDir(env), trace.agentId, `${trace.id}.json`);
}

function skillRecordPath(agentId: string, skillName: string, env?: NodeJS.ProcessEnv): string {
  const safe = skillName.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "skill";
  return path.join(tracesDir(env), agentId, `skill-${safe}.json`);
}

export function createFollowAlongTrace(params: {
  agentId: string;
  sessionKey: string;
  now?: number;
}): FollowAlongTrace {
  const startedAt = params.now ?? Date.now();
  return {
    id: `fa-${startedAt.toString(36)}`,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    startedAt,
    events: [],
  };
}

export function appendFollowAlongEvent(
  trace: FollowAlongTrace,
  event: Omit<FollowAlongEvent, "ts"> & { ts?: number },
): FollowAlongTrace {
  return {
    ...trace,
    events: [
      ...trace.events,
      {
        ts: event.ts ?? Date.now(),
        kind: event.kind,
        summary: event.summary,
        ...(event.url ? { url: event.url } : {}),
        ...(event.app ? { app: event.app } : {}),
        ...(event.artifact ? { artifact: event.artifact } : {}),
      },
    ],
  };
}

export function persistFollowAlongTrace(
  trace: FollowAlongTrace,
  env?: NodeJS.ProcessEnv,
): string {
  const file = tracePath(trace, env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(trace, null, 2)}\n`, "utf8");
  return file;
}

export function loadFollowAlongTrace(
  agentId: string,
  traceId: string,
  env?: NodeJS.ProcessEnv,
): FollowAlongTrace | null {
  const file = tracePath({ agentId, id: traceId }, env);
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as FollowAlongTrace;
  } catch {
    return null;
  }
}

function uniqueSummaries(trace: FollowAlongTrace, kind: FollowAlongEventKind): string[] {
  return [
    ...new Set(trace.events.filter((event) => event.kind === kind).map((event) => event.summary)),
  ];
}

export function compileFollowAlongSkill(
  trace: FollowAlongTrace,
  skillName?: string,
): CompiledFollowAlongSkill {
  const name =
    skillName?.trim() ||
    uniqueSummaries(trace, "artifact")[0] ||
    `follow-along-${trace.agentId}`;
  const urls = uniqueSummaries(trace, "url");
  const apps = uniqueSummaries(trace, "app");
  const landmarks = uniqueSummaries(trace, "landmark");
  const decisions = uniqueSummaries(trace, "decision");
  const approvals = uniqueSummaries(trace, "approval");
  const artifacts = uniqueSummaries(trace, "artifact");
  const narration = uniqueSummaries(trace, "narration");
  const steps = [
    ...narration.map((item) => `Narrated: ${item}`),
    ...apps.map((item) => `Open ${item}`),
    ...urls.map((item) => `Visit ${item}`),
    ...landmarks.map((item) => `Locate ${item}`),
    ...decisions.map((item) => `Decide: ${item}`),
  ];
  const whenToUse =
    narration[0] ||
    `Repeat the recorded computer path for ${trace.agentId} (${apps[0] ?? "the shared worker"}).`;
  const access = [apps.length ? `Apps: ${apps.join(", ")}` : "", urls.length ? `URLs: ${urls.join(", ")}` : ""]
    .filter(Boolean)
    .join("\n");
  const validation = artifacts[0]
    ? `Confirm artifact exists: ${artifacts[0]}`
    : "Confirm the recorded steps completed without a new approval deny.";
  const deliverable = artifacts[0] || "Completed run on the persistent worker computer.";
  const approvalsText =
    approvals.join("; ") || "Stop at send / pay / publish / delete / production.";
  const markdown = `---
name: ${name}
description: ${whenToUse}
---

# ${name}

## When to use
${whenToUse}

## Access
${access || "Shared teammate worker computer. No extra host exec."}

## Steps
${steps.map((step, index) => `${index + 1}. ${step}`).join("\n") || "1. Replay the recorded worker session."}

## Validation
${validation}

## Deliverable
${deliverable}

## Approvals
${approvalsText}
`;
  return {
    name,
    whenToUse,
    access: access || "Shared teammate worker computer.",
    steps,
    validation,
    deliverable,
    approvals: approvalsText,
    markdown,
  };
}

export function recordFollowAlongSkillSuccess(params: {
  agentId: string;
  sessionKey: string;
  skillName: string;
  traceId: string;
  env?: NodeJS.ProcessEnv;
  now?: number;
}): FollowAlongSkillRecord {
  const file = skillRecordPath(params.agentId, params.skillName, params.env);
  let record: FollowAlongSkillRecord = {
    skillName: params.skillName,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    successCount: 0,
    lastTraceId: params.traceId,
  };
  try {
    record = {
      ...record,
      ...(JSON.parse(fs.readFileSync(file, "utf8")) as FollowAlongSkillRecord),
    };
  } catch {
    // First successful compile for this Bot + skill.
  }
  record.successCount += 1;
  record.lastTraceId = params.traceId;
  record.sessionKey = params.sessionKey;
  if (record.successCount >= FOLLOW_ALONG_SUCCESS_THRESHOLD && !record.weekdayOffer) {
    record.weekdayOffer = {
      expr: FOLLOW_ALONG_DEFAULT_WEEKDAY_EXPR,
      offeredAt: params.now ?? Date.now(),
    };
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return record;
}

export function shouldOfferWeekdayJob(record: FollowAlongSkillRecord): boolean {
  return record.successCount >= FOLLOW_ALONG_SUCCESS_THRESHOLD && Boolean(record.weekdayOffer);
}

export function buildFollowAlongWeekdayWorkOrder(params: {
  skillName: string;
  agentId: string;
  sessionKey: string;
  expr?: string;
}): string {
  const expr = params.expr?.trim() || FOLLOW_ALONG_DEFAULT_WEEKDAY_EXPR;
  const jobName = `teammate[${params.agentId}] ${params.skillName}`;
  const message = `Run skill ${JSON.stringify(params.skillName)} on the persistent teammate computer. Do not send, pay, publish, delete, or ship to production without approval.`;
  return `Create a weekday routine with the automations tool, then confirm in one short line. action:"add", job:{name:${JSON.stringify(jobName)},agentId:${JSON.stringify(params.agentId)},schedule:{kind:"cron",expr:${JSON.stringify(expr)}},sessionTarget:"current",payload:{kind:"agentTurn",message:${JSON.stringify(message)}}}. Bind it to this Bot and skill, not an orphan cron.`;
}

export function parseFollowAlongScheduleExpr(raw: string | undefined): string {
  const text = normalizeLowercaseStringOrEmpty(raw ?? "");
  if (!text || text === "weekday" || text === "weekdays") {
    return FOLLOW_ALONG_DEFAULT_WEEKDAY_EXPR;
  }
  if (text.includes("monday") && (text.includes("9") || text.includes("09"))) {
    return "0 9 * * 1";
  }
  if (/^[\d*]/.test(text)) {
    return raw!.trim();
  }
  return FOLLOW_ALONG_DEFAULT_WEEKDAY_EXPR;
}
