import { channel } from "node:diagnostics_channel";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { Page } from "playwright";
import {
  recordControlUiE2eFailureFacts,
  type ControlUiE2eFailureFact,
} from "../test-helpers/control-ui-e2e-diagnostics.ts";

const limit = 128;
const subscribeMethod = "controlUi.sessionPullRequests.subscribe";
type Fact = string | number | boolean | null;

/** Only the descendant-PR scenario installs this bounded, content-free flight recorder. */
export function recordTaskPrDiagnostics(sessionKeys: string[], numbers: number[], branch: string) {
  const gateway: Record<string, Fact>[] = [];
  const frames: Record<string, ControlUiE2eFailureFact>[] = [];
  const dropped = { gateway: 0, frames: 0 };
  const retain = <T>(ring: T[], item: T, kind: keyof typeof dropped) => {
    ring.push(item);
    if (ring.length > limit) {
      ring.shift();
      dropped[kind]++;
    }
  };
  const recordFrame = (facts: Record<string, ControlUiE2eFailureFact>) =>
    retain(frames, { at: Date.now(), ...facts }, "frames");
  const recordGateway = (message: unknown) => {
    if (!isRecord(message)) {
      return;
    }
    if (
      typeof message.method === "string" &&
      !message.method.startsWith("controlUi.sessionPullRequests.")
    ) {
      return;
    }
    if (typeof message.sessionKey === "string" && !sessionKeys.includes(message.sessionKey)) {
      return;
    }
    const facts: Record<string, Fact> = { at: Date.now() };
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
    retain(gateway, facts, "gateway");
  };
  const channels = [
    "openclaw.gateway.session-pr",
    "openclaw.gateway.rpc",
    "openclaw.git.operation",
  ].map(channel);
  channels.forEach((source) => source.subscribe(recordGateway));

  const summarize = (value: unknown) => {
    if (!isRecord(value)) {
      return null;
    }
    return {
      status:
        ["ready", "unavailable", "rate-limited"].find((status) => status === value.status) ?? null,
      branchRead: value.branchRead === false ? false : null,
      branchMatches: isRecord(value.branch) && value.branch.branch === branch,
      pullRequestCount: Array.isArray(value.pullRequests) ? value.pullRequests.length : null,
      taskPullRequestCount:
        typeof value.taskPullRequestCount === "number" ? value.taskPullRequestCount : null,
      descendants: Array.isArray(value.taskPullRequests)
        ? value.taskPullRequests.slice(0, 4).map((item: unknown) => {
            if (!isRecord(item)) {
              return null;
            }
            return {
              session: sessionKeys.indexOf(String(item.sourceSessionKey)),
              number: numbers.find((number) => number === item.number) ?? null,
              hydrated: isRecord(item.pullRequest),
            };
          })
        : [],
    };
  };

  return {
    beginStage() {
      gateway.length = frames.length = 0;
      dropped.gateway = dropped.frames = 0;
    },
    stop: () => channels.forEach((source) => source.unsubscribe(recordGateway)),
    socket() {
      const pending = new Map<string, number>();
      let requestSequence = 0;
      return {
        sent(frame: unknown) {
          if (
            !isRecord(frame) ||
            frame.method !== subscribeMethod ||
            typeof frame.id !== "string"
          ) {
            return;
          }
          if (pending.size >= limit) {
            pending.delete(pending.keys().next().value!);
          }
          pending.set(frame.id, ++requestSequence);
          const params = isRecord(frame.params) ? frame.params : {};
          const keys = (value: unknown) =>
            Array.isArray(value)
              ? value.map((key) => sessionKeys.indexOf(String(key))).filter((index) => index >= 0)
              : [];
          recordFrame({
            direction: "sent",
            request: requestSequence,
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
            recordFrame({ direction: "received", request, ok: frame.ok === true });
          }
          if (
            frame.event !== "controlUi.sessionPullRequests.changed" ||
            !isRecord(frame.payload) ||
            !isRecord(frame.payload.sessions)
          ) {
            return;
          }
          const sessions = frame.payload.sessions;
          recordFrame({
            direction: "received",
            event: frame.event,
            sessions: sessionKeys.map((key) => summarize(sessions[key])),
          });
        },
        close: () => pending.clear(),
      };
    },
    capture(page: Page, stage: string) {
      // The caller owns UI, hydration, and Git-operation snapshots; retain only the timeline here.
      recordControlUiE2eFailureFacts(page, {
        taskPrTrace: {
          stage,
          capturedAt: Date.now(),
          limit,
          dropped: { ...dropped },
          gateway: [...gateway],
          frames: [...frames],
        },
      });
    },
  };
}
