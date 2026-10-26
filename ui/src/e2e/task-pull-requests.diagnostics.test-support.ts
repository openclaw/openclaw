import { channel } from "node:diagnostics_channel";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { Page } from "playwright";
import {
  recordControlUiE2eFailureFacts,
  type ControlUiE2eFailureFact,
} from "../test-helpers/control-ui-e2e-diagnostics.ts";

// The scenario owns full PR snapshots. This recorder adds only bounded, content-free ordering.
export function recordTaskPrDiagnostics(sessionKeys: string[]) {
  const limit = 128;
  const events: Record<string, ControlUiE2eFailureFact>[] = [];
  let dropped = 0;
  const record = (facts: Record<string, ControlUiE2eFailureFact>) => {
    events.push({ at: Date.now(), ...facts });
    if (events.length > limit) {
      events.shift();
      dropped++;
    }
  };
  const keys = (value: unknown) =>
    Array.isArray(value)
      ? value.map((key) => sessionKeys.indexOf(String(key))).filter((index) => index >= 0)
      : [];
  const recordGateway = (message: unknown) => {
    if (
      !isRecord(message) ||
      (typeof message.method === "string" &&
        !message.method.startsWith("controlUi.sessionPullRequests.")) ||
      (typeof message.sessionKey === "string" && !sessionKeys.includes(message.sessionKey))
    ) {
      return;
    }
    const facts: Record<string, ControlUiE2eFailureFact> = { source: "gateway" };
    for (const key of [
      "phase",
      "method",
      "operation",
      "outcome",
      "durationMs",
      "elapsedMs",
      "receiptsOnly",
      "count",
      "current",
    ]) {
      const value = message[key];
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        facts[key] = value;
      }
    }
    if (typeof message.sessionKey === "string") {
      facts.session = sessionKeys.indexOf(message.sessionKey);
    }
    record(facts);
  };
  const channels = [
    "openclaw.gateway.session-pr",
    "openclaw.gateway.rpc",
    "openclaw.git.operation",
  ].map(channel);
  channels.forEach((source) => source.subscribe(recordGateway));
  return {
    beginStage() {
      events.length = dropped = 0;
    },
    stop: () => channels.forEach((source) => source.unsubscribe(recordGateway)),
    socket() {
      const pending = new Map<string, number>();
      let sequence = 0;
      return {
        sent(frame: unknown) {
          if (
            !isRecord(frame) ||
            frame.method !== "controlUi.sessionPullRequests.subscribe" ||
            typeof frame.id !== "string"
          ) {
            return;
          }
          if (pending.size >= limit) {
            pending.delete(pending.keys().next().value!);
          }
          pending.set(frame.id, ++sequence);
          const params = isRecord(frame.params) ? frame.params : {};
          record({
            source: "sent",
            request: sequence,
            foreground: keys(params.sessionKeys),
            passive: keys(params.passiveSessionKeys),
          });
        },
        received(frame: unknown) {
          if (!isRecord(frame)) {
            return;
          }
          const request = typeof frame.id === "string" ? pending.get(frame.id) : undefined;
          if (frame.type === "res" && request !== undefined) {
            pending.delete(String(frame.id));
            record({ source: "received", request, ok: frame.ok === true });
          }
          if (
            frame.event === "controlUi.sessionPullRequests.changed" &&
            isRecord(frame.payload) &&
            isRecord(frame.payload.sessions)
          ) {
            record({ source: "publication", sessions: keys(Object.keys(frame.payload.sessions)) });
          }
        },
        close: () => pending.clear(),
      };
    },
    capture(page: Page, stage: string) {
      recordControlUiE2eFailureFacts(page, {
        taskPrTrace: { stage, limit, dropped, events: [...events] },
      });
    },
  };
}
