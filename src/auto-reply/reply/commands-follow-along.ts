/**
 * /follow-along on the persistent computer: record, compile a skill, offer a weekday job.
 */
import { AUTOMATIONS_TOOL_NAME } from "../../agents/tools/automations-tool-name.js";
import { applyCommandTextToParams } from "./command-context-rewrite.js";
import { commandReply, defineAuthorizedTextCommand, matchCommandPrefix } from "./command-gates.js";
import type { CommandHandler } from "./commands-types.js";
import {
  appendFollowAlongEvent,
  buildFollowAlongWeekdayWorkOrder,
  compileFollowAlongSkill,
  createFollowAlongTrace,
  FOLLOW_ALONG_SUCCESS_THRESHOLD,
  parseFollowAlongScheduleExpr,
  persistFollowAlongTrace,
  recordFollowAlongSkillSuccess,
  shouldOfferWeekdayJob,
  type FollowAlongTrace,
} from "../../teammate/follow-along.js";

const FOLLOW_ALONG_PREFIX = "/follow-along";

const activeTraces = new Map<string, FollowAlongTrace>();

function traceKey(agentId: string, sessionKey: string): string {
  return `${agentId}:${sessionKey}`;
}

function parseFollowAlong(body: string): { action: string; rest: string } | null {
  const matched = matchCommandPrefix(body, FOLLOW_ALONG_PREFIX);
  if (matched === null) {
    return null;
  }
  const trimmed = matched.trim();
  if (!trimmed) {
    return { action: "status", rest: "" };
  }
  const space = trimmed.search(/\s/);
  const action = (space === -1 ? trimmed : trimmed.slice(0, space)).toLowerCase();
  const rest = space === -1 ? "" : trimmed.slice(space).trim();
  return { action, rest };
}

export const handleFollowAlongCommand: CommandHandler = defineAuthorizedTextCommand(
  { label: FOLLOW_ALONG_PREFIX, match: parseFollowAlong },
  (params, parsed) => {
    const agentId = params.agentId || "main";
    const sessionKey = params.sessionKey || "main";
    const key = traceKey(agentId, sessionKey);

    if (parsed.action === "start") {
      const trace = createFollowAlongTrace({ agentId, sessionKey });
      persistFollowAlongTrace(trace);
      activeTraces.set(key, trace);
      return commandReply(
        `Follow-along recording started on the persistent computer (${trace.id}). Drive the UI or narrate with /follow-along note … then /follow-along stop.`,
      );
    }

    if (parsed.action === "note" || parsed.action === "url" || parsed.action === "app") {
      const current = activeTraces.get(key);
      if (!current) {
        return commandReply("No active follow-along. Start with /follow-along start.");
      }
      const kind =
        parsed.action === "url" ? "url" : parsed.action === "app" ? "app" : "narration";
      const next = appendFollowAlongEvent(current, {
        kind,
        summary: parsed.rest || parsed.action,
        ...(kind === "url" ? { url: parsed.rest } : {}),
        ...(kind === "app" ? { app: parsed.rest } : {}),
      });
      persistFollowAlongTrace(next);
      activeTraces.set(key, next);
      return commandReply(`Recorded ${kind}.`);
    }

    if (parsed.action === "stop") {
      const current = activeTraces.get(key);
      if (!current) {
        return commandReply("No active follow-along.");
      }
      persistFollowAlongTrace({ ...current, stoppedAt: Date.now() });
      const compiled = compileFollowAlongSkill({ ...current, stoppedAt: Date.now() }, parsed.rest);
      const record = recordFollowAlongSkillSuccess({
        agentId,
        sessionKey,
        skillName: compiled.name,
        traceId: current.id,
      });
      activeTraces.delete(key);
      const offer = shouldOfferWeekdayJob(record)
        ? `\nThis skill succeeded ${record.successCount} times. Offer: run it weekdays at 08:00 with /follow-along schedule (bound to Bot ${agentId} + skill, not an orphan cron).`
        : `\nSuccessful runs: ${record.successCount}/${FOLLOW_ALONG_SUCCESS_THRESHOLD} before a weekday job is offered.`;
      return commandReply(
        `Follow-along compiled to skill ${compiled.name}.${offer}\n\n${compiled.markdown}`,
      );
    }

    if (parsed.action === "schedule") {
      const skillName = parsed.rest && !parsed.rest.toLowerCase().includes("weekday")
        ? parsed.rest
        : "follow-along";
      const expr = parseFollowAlongScheduleExpr(parsed.rest);
      applyCommandTextToParams(
        params,
        buildFollowAlongWeekdayWorkOrder({
          skillName,
          agentId,
          sessionKey,
          expr,
        }),
      );
      return {
        shouldContinue: true,
        reply: {
          text: `Scheduling ${skillName} on this Bot (${agentId}) with ${AUTOMATIONS_TOOL_NAME}, inheriting this conversation for the approval trail.`,
        },
      };
    }

    return commandReply(
      "Usage: /follow-along start | note <text> | stop [skill-name] | schedule [weekday 08:00]",
    );
  },
);
