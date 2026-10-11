import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { resolveDefaultSessionStorePath } from "../config/sessions/paths.js";
import { saveCronJobsStore } from "../cron/store.js";
import {
  drainSystemEvents,
  enqueueSystemEvent,
  peekSystemEventEntries,
  peekSystemEvents,
  prepareAutomationSystemEvents,
} from "../infra/system-events.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  installGatewayTestHooks,
  testState,
  withGatewayServer,
  writeSessionStore,
} from "./test-helpers.js";

const immediate = vi.hoisted(() => vi.fn());
// mock-isolation: Deferred admission and target capture stay real; no model turn is expected.
vi.mock("../auto-reply/reply/session-event-handoff.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../auto-reply/reply/session-event-handoff.js")>()),
  enqueueSessionEventForHost: immediate,
}));

installGatewayTestHooks({ scope: "suite" });
await import("./server.js");

afterEach(() => {
  drainSystemEvents("agent:main:main");
  drainSystemEvents("agent:hooks:main");
  vi.clearAllMocks();
});

describe("scheduled hook notice admission", () => {
  test("reserves direct and mapped notices for their selected Automation and refuses a missing receiver", async () => {
    const stateDir = process.env.OPENCLAW_STATE_DIR;
    if (!stateDir) {
      throw new Error("OPENCLAW_STATE_DIR is required");
    }
    testState.agentsConfig = {
      ownership: "explicit",
      entries: { main: {}, hooks: {}, unscheduled: {} },
    };
    testState.agentConfig = { ...testState.agentConfig, systemAgent: { agentId: "main" } };
    testState.hooksConfig = {
      enabled: true,
      token: "hook-secret",
      allowedAgentIds: ["main", "hooks", "unscheduled"],
      mappings: [
        {
          match: { path: "scheduled-notice" },
          action: "wake",
          agentId: "hooks",
          textTemplate: "Mapped {{payload.subject}}",
          wakeMode: "next-heartbeat",
        },
      ],
    };
    const storePath = path.join(stateDir, "cron", "hook-receivers.json");
    const now = Date.now();
    const nextRunAtMs = now + 86_400_000;
    await saveCronJobsStore(storePath, {
      version: 1,
      jobs: ["main", "hooks"].map((agentId) => ({
        id: `hook-receiver-${agentId}`,
        agentId,
        name: `Scheduled ${agentId} notices`,
        enabled: true,
        createdAtMs: now,
        updatedAtMs: now,
        schedule: { kind: "at", at: new Date(nextRunAtMs).toISOString() },
        sessionTarget: "main",
        wakeMode: "now",
        payload: { kind: "agentTurn", message: "Review pending notices." },
        delivery: { mode: "none" },
        state: { nextRunAtMs },
      })),
    });
    testState.cronStorePath = storePath;
    testState.cronEnabled = true;
    await withEnvAsync({ OPENCLAW_SKIP_CRON: "0" }, () =>
      withGatewayServer(async ({ port }) => {
        const post = async (route: string, payload: Record<string, unknown>) => {
          const response = await fetch(`http://127.0.0.1:${port}/hooks/${route}`, {
            method: "POST",
            headers: {
              Authorization: "Bearer hook-secret",
              "Content-Type": "application/json",
            },
            body: JSON.stringify(payload),
          });
          return { status: response.status, body: await response.json() };
        };
        for (const { agentId, route, payload, text } of [
          {
            agentId: "main",
            route: "wake",
            payload: { agentId: "main", text: "Direct notice", mode: "next-heartbeat" },
            text: "Direct notice",
          },
          {
            agentId: "hooks",
            route: "scheduled-notice",
            payload: { subject: "notice" },
            text: "Mapped notice",
          },
        ]) {
          const sessionKey = `agent:${agentId}:main`;
          await writeSessionStore({
            storePath: resolveDefaultSessionStorePath(agentId),
            entries: { [sessionKey]: { sessionId: `scheduled-hook-${agentId}` } },
          });
          // An ordinary notice with equal text has independent custody.
          enqueueSystemEvent(text, { sessionKey });
          expect(await post(route, payload)).toEqual({
            status: 200,
            body: { ok: true, mode: "next-heartbeat", eventOutcome: "queued" },
          });
          expect(await post(route, payload)).toEqual({
            status: 200,
            body: { ok: true, mode: "next-heartbeat", eventOutcome: "coalesced" },
          });
          expect(peekSystemEventEntries(sessionKey).map((event) => event.text)).toEqual([
            text,
            text,
          ]);
          const unrelated = await prepareAutomationSystemEvents(
            sessionKey,
            "other-automation",
            nextRunAtMs,
          );
          try {
            expect(unrelated.events).toEqual([]);
          } finally {
            unrelated.release();
          }
          const early = await prepareAutomationSystemEvents(
            sessionKey,
            `hook-receiver-${agentId}`,
            nextRunAtMs - 1,
          );
          try {
            expect(early.events).toEqual([]);
          } finally {
            early.release();
          }
          const selected = await prepareAutomationSystemEvents(
            sessionKey,
            `hook-receiver-${agentId}`,
            nextRunAtMs,
          );
          try {
            expect(selected.events.map((event) => event.text)).toEqual([text]);
            selected.start();
          } finally {
            selected.release();
          }
          expect(peekSystemEvents(sessionKey)).toEqual([text]);
        }
        const unavailable = await post("wake", {
          text: "No receiver",
          mode: "next-heartbeat",
          agentId: "unscheduled",
        });
        expect(unavailable).toMatchObject({
          status: 503,
          body: {
            ok: false,
            error: expect.stringContaining("No enabled ordinary scheduled session job"),
          },
        });
        expect(peekSystemEvents("agent:unscheduled:main")).toEqual([]);
        expect(immediate).not.toHaveBeenCalled();
      }),
    );
  });
});
