import { randomUUID } from "node:crypto";
import type { NodeEvent, NodeEventContext } from "./server-node-events-types.js";
import { normalizeChannelId } from "../channels/plugins/index.js";
import { agentCommand } from "../commands/agent.js";
import { loadConfig } from "../config/config.js";
import { updateSessionStore } from "../config/sessions.js";
import { requestHeartbeatNow } from "../infra/heartbeat-wake.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import { normalizeMainKey } from "../routing/session-key.js";
import { defaultRuntime } from "../runtime.js";
import {
  loadSessionEntry,
  pruneLegacyStoreKeys,
  resolveGatewaySessionStoreTarget,
} from "./session-utils.js";
import { formatForLog } from "./ws-log.js";

const EXEC_OUTPUT_MAX_LEN = 200;

export const handleNodeEvent = async (ctx: NodeEventContext, nodeId: string, evt: NodeEvent) => {
  switch (evt.event) {
    case "voice.transcript": {
      if (!evt.payloadJSON) {
        return;
      }
      let payload: unknown;
      try {
        payload = JSON.parse(evt.payloadJSON) as unknown;
      } catch {
        return;
      }
      const obj =
        typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : {};
      const text = typeof obj.text === "string" ? obj.text.trim() : "";
      if (!text) {
        return;
      }
      if (text.length > 20_000) {
        return;
      }
      const sessionKeyRaw = typeof obj.sessionKey === "string" ? obj.sessionKey.trim() : "";
      const cfg = loadConfig();
      const rawMainKey = normalizeMainKey(cfg.session?.mainKey);
      const sessionKey = sessionKeyRaw.length > 0 ? sessionKeyRaw : rawMainKey;

      // Deduplicate: if no eventId, use sessionKey+text as dedupe key.
      // If eventId is present, use it as the key (unique per distinct event).
      const eventId =
        typeof obj.eventId === "string" && obj.eventId.trim() ? obj.eventId.trim() : null;
      const dedupeKey = eventId ?? `${sessionKey}|${text}`;
      if (ctx.dedupe.has(dedupeKey)) {
        return;
      }
      ctx.dedupe.set(dedupeKey, { ts: Date.now(), ok: true });

      const { storePath, entry, canonicalKey } = loadSessionEntry(sessionKey);
      const now = Date.now();
      const sessionId = entry?.sessionId ?? randomUUID();
      if (storePath) {
        updateSessionStore(storePath, (store) => {
          const target = resolveGatewaySessionStoreTarget({ cfg, key: sessionKey, store });
          pruneLegacyStoreKeys({
            store,
            canonicalKey: target.canonicalKey,
            candidates: target.storeKeys,
          });
          store[canonicalKey] = {
            sessionId,
            updatedAt: now,
            thinkingLevel: entry?.thinkingLevel,
            verboseLevel: entry?.verboseLevel,
            reasoningLevel: entry?.reasoningLevel,
            systemSent: entry?.systemSent,
            sendPolicy: entry?.sendPolicy,
            lastChannel: entry?.lastChannel,
            lastTo: entry?.lastTo,
          };
        }).catch((err: unknown) => {
          ctx.logGateway.warn(`voice session-store update failed: ${formatForLog(err)}`);
        });
      }

      // Ensure chat UI clients refresh when this run completes (even though it wasn't started via chat.send).
      // This maps agent bus events (keyed by sessionId) to chat events (keyed by clientRunId).
      ctx.addChatRun(sessionId, {
        sessionKey: canonicalKey,
        clientRunId: `voice-${randomUUID()}`,
      });

      void agentCommand(
        {
          message: text,
          sessionId,
          sessionKey: canonicalKey,
          thinking: "low",
          deliver: false,
          messageChannel: "node",
          inputProvenance: {
            kind: "external_user",
            sourceChannel: "voice",
            sourceTool: "gateway.voice.transcript",
          },
        },
        defaultRuntime,
        ctx.deps,
      ).catch((err) => {
        ctx.logGateway.warn(`agent failed node=${nodeId}: ${formatForLog(err)}`);
      });
      return;
    }
    case "agent.request": {
      if (!evt.payloadJSON) {
        return;
      }
      type AgentDeepLink = {
        message?: string;
        sessionKey?: string | null;
        thinking?: string | null;
        deliver?: boolean;
        to?: string | null;
        channel?: string | null;
        timeoutSeconds?: number | null;
        key?: string | null;
      };
      let link: AgentDeepLink | null = null;
      try {
        link = JSON.parse(evt.payloadJSON) as AgentDeepLink;
      } catch {
        return;
      }
      const message = (link?.message ?? "").trim();
      if (!message) {
        return;
      }
      if (message.length > 20_000) {
        return;
      }

      const sessionKeyRaw = (link?.sessionKey ?? "").trim();
      const sessionKey = sessionKeyRaw.length > 0 ? sessionKeyRaw : `node-${nodeId}`;
      const cfg = loadConfig();
      const { storePath, entry, canonicalKey } = loadSessionEntry(sessionKey);
      const now = Date.now();
      const sessionId = entry?.sessionId ?? randomUUID();

      // Resolve delivery: prefer explicit channel from event, fall back to session route.
      const channelRaw = typeof link?.channel === "string" ? link.channel.trim() : "";
      const explicitChannel = normalizeChannelId(channelRaw) ?? undefined;
      const explicitTo =
        typeof link?.to === "string" && link.to.trim() ? link.to.trim() : undefined;
      const wantsDeliver = Boolean(link?.deliver);

      let channel: string | undefined;
      let to: string | undefined;
      let deliver: boolean;

      if (wantsDeliver) {
        if (explicitChannel) {
          channel = explicitChannel;
          to = explicitTo;
          deliver = true;
        } else {
          // Try to reuse the current session's delivery route.
          const sessionChannel = entry?.lastChannel;
          const sessionTo = entry?.lastTo;
          if (sessionChannel) {
            channel = sessionChannel;
            to = sessionTo ?? undefined;
            deliver = true;
          } else {
            channel = undefined;
            to = undefined;
            deliver = false;
            ctx.logGateway.warn(
              `agent delivery disabled node=${nodeId}: no delivery route for session ${canonicalKey}`,
            );
          }
        }
      } else {
        channel = explicitChannel;
        to = explicitTo;
        deliver = false;
      }

      if (storePath) {
        await updateSessionStore(storePath, (store) => {
          const target = resolveGatewaySessionStoreTarget({ cfg, key: sessionKey, store });
          pruneLegacyStoreKeys({
            store,
            canonicalKey: target.canonicalKey,
            candidates: target.storeKeys,
          });
          store[canonicalKey] = {
            sessionId,
            updatedAt: now,
            thinkingLevel: entry?.thinkingLevel,
            verboseLevel: entry?.verboseLevel,
            reasoningLevel: entry?.reasoningLevel,
            systemSent: entry?.systemSent,
            sendPolicy: entry?.sendPolicy,
            lastChannel: entry?.lastChannel,
            lastTo: entry?.lastTo,
          };
        });
      }

      void agentCommand(
        {
          message,
          sessionId,
          sessionKey: canonicalKey,
          thinking: link?.thinking ?? undefined,
          deliver,
          to,
          channel,
          timeout:
            typeof link?.timeoutSeconds === "number" ? link.timeoutSeconds.toString() : undefined,
          messageChannel: "node",
        },
        defaultRuntime,
        ctx.deps,
      ).catch((err) => {
        ctx.logGateway.warn(`agent failed node=${nodeId}: ${formatForLog(err)}`);
      });
      return;
    }
    case "chat.subscribe": {
      if (!evt.payloadJSON) {
        return;
      }
      let payload: unknown;
      try {
        payload = JSON.parse(evt.payloadJSON) as unknown;
      } catch {
        return;
      }
      const obj =
        typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : {};
      const sessionKey = typeof obj.sessionKey === "string" ? obj.sessionKey.trim() : "";
      if (!sessionKey) {
        return;
      }
      ctx.nodeSubscribe(nodeId, sessionKey);
      return;
    }
    case "chat.unsubscribe": {
      if (!evt.payloadJSON) {
        return;
      }
      let payload: unknown;
      try {
        payload = JSON.parse(evt.payloadJSON) as unknown;
      } catch {
        return;
      }
      const obj =
        typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : {};
      const sessionKey = typeof obj.sessionKey === "string" ? obj.sessionKey.trim() : "";
      if (!sessionKey) {
        return;
      }
      ctx.nodeUnsubscribe(nodeId, sessionKey);
      return;
    }
    case "exec.started":
    case "exec.finished":
    case "exec.denied": {
      if (!evt.payloadJSON) {
        return;
      }
      let payload: unknown;
      try {
        payload = JSON.parse(evt.payloadJSON) as unknown;
      } catch {
        return;
      }
      const obj =
        typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : {};
      const sessionKey =
        typeof obj.sessionKey === "string" ? obj.sessionKey.trim() : `node-${nodeId}`;
      if (!sessionKey) {
        return;
      }
      const runId = typeof obj.runId === "string" ? obj.runId.trim() : "";
      const command = typeof obj.command === "string" ? obj.command.trim() : "";
      const exitCode =
        typeof obj.exitCode === "number" && Number.isFinite(obj.exitCode)
          ? obj.exitCode
          : undefined;
      const timedOut = obj.timedOut === true;
      const output = typeof obj.output === "string" ? obj.output.trim() : "";
      const reason = typeof obj.reason === "string" ? obj.reason.trim() : "";

      let text = "";
      if (evt.event === "exec.started") {
        text = `Exec started (node=${nodeId}${runId ? ` id=${runId}` : ""})`;
        if (command) {
          text += `: ${command}`;
        }
      } else if (evt.event === "exec.finished") {
        // Suppress noisy success events with no output (exit code 0, empty output).
        if (exitCode === 0 && !timedOut && !output) {
          return;
        }
        const exitLabel = timedOut ? "timeout" : `code ${exitCode ?? "?"}`;
        text = `Exec finished (node=${nodeId}${runId ? ` id=${runId}` : ""}, ${exitLabel})`;
        if (output) {
          // Truncate long output to avoid overwhelming system event log.
          const truncated =
            output.length > EXEC_OUTPUT_MAX_LEN
              ? `${output.slice(0, EXEC_OUTPUT_MAX_LEN)}…`
              : output;
          text += `\n${truncated}`;
        }
      } else {
        text = `Exec denied (node=${nodeId}${runId ? ` id=${runId}` : ""}${reason ? `, ${reason}` : ""})`;
        if (command) {
          text += `: ${command}`;
        }
      }

      enqueueSystemEvent(text, { sessionKey, contextKey: runId ? `exec:${runId}` : "exec" });
      requestHeartbeatNow({ reason: "exec-event" });
      return;
    }
    default:
      return;
  }
};
