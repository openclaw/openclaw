import { channel } from "node:diagnostics_channel";
import { withTimeout } from "@openclaw/fs-safe/advanced";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { Page } from "playwright";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
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
          retain(
            frames,
            {
              at: Date.now(),
              direction: "sent",
              request: requestSequence,
              foreground: keys(params.sessionKeys),
              passive: keys(params.passiveSessionKeys),
            },
            "frames",
          );
        },
        received(frame: unknown) {
          if (!isRecord(frame)) {
            return;
          }
          const request = typeof frame.id === "string" ? pending.get(frame.id) : undefined;
          if (frame.type === "res" && request !== undefined) {
            pending.delete(String(frame.id));
            retain(
              frames,
              { at: Date.now(), direction: "received", request, ok: frame.ok === true },
              "frames",
            );
          }
          if (
            frame.event !== "controlUi.sessionPullRequests.changed" ||
            !isRecord(frame.payload) ||
            !isRecord(frame.payload.sessions)
          ) {
            return;
          }
          const sessions = frame.payload.sessions;
          retain(
            frames,
            {
              at: Date.now(),
              direction: "received",
              event: frame.event,
              sessions: sessionKeys.map((key) => summarize(sessions[key])),
            },
            "frames",
          );
        },
        close: () => pending.clear(),
      };
    },
    async capture(page: Page, stage: string) {
      // Freeze the transport evidence before a late reply or diagnostic read can alter it.
      const details: Record<string, ControlUiE2eFailureFact> = {
        stage,
        capturedAt: Date.now(),
        limit,
        dropped: { ...dropped },
        gateway: [...gateway],
        frames: [...frames],
      };
      details.ui = await withTimeout(
        evaluateControlUiContext(
          page,
          (context, { sessionKeys: keys, numbers: expectedNumbers }) => {
            const card = document.querySelector(".session-progress-hovercard");
            return {
              at: Date.now(),
              gatewayPhase: context.gateway.snapshot.phase,
              rosterLoading: context.sessions.state.loading,
              rosterRevision: context.sessions.canonicalListRevision,
              sessions: keys.map((key, index) => {
                const row = context.sessions.state.result?.sessions.find(
                  (candidate) => candidate.key === key,
                );
                const summary = context.sessions.pullRequestSummary(key);
                const element = document.querySelector(
                  '.sidebar-recent-session[data-session-key="' + key + '"]',
                );
                return {
                  session: index,
                  rosterPresent: Boolean(row),
                  pullRequestNumbers:
                    summary?.numbers.filter((number) => expectedNumbers.includes(number)) ?? [],
                  projectedRowPresent: Boolean(element),
                  projectedBadgeCount:
                    element?.querySelectorAll(".session-row-badge--pull-request").length ?? 0,
                };
              }),
              cardPresent: Boolean(card),
              cardVisible: card?.checkVisibility({ visibilityProperty: true }) ?? false,
              projectedDescendants: expectedNumbers.map((number) => ({
                number,
                linkCount: card?.querySelectorAll('a[href$="/pull/' + number + '"]').length ?? 0,
              })),
              projectedCreateParentPrCount:
                card?.querySelectorAll('a[href*="/pull/new/"]').length ?? 0,
            };
          },
          { sessionKeys, numbers },
        ),
        1_000,
      ).catch(() => ({ readFailed: true }));
      recordControlUiE2eFailureFacts(page, { taskPrTrace: details });
    },
  };
}
