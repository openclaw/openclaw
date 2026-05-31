import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { ensureProofEventsSchema, listProofEvents, recordProofEvent, summarizeProofEvents } =
  require("../../scripts/lib/proof-events.cjs") as {
    ensureProofEventsSchema: (db: DatabaseSync) => void;
    listProofEvents: (
      db: DatabaseSync,
      options?: { component?: string; limit?: number; runId?: string; ticketId?: string },
    ) => Array<{
      agent_os: unknown;
      component: string;
      event_type: string;
      payload: unknown;
      status: string;
      ticket_id: string;
    }>;
    recordProofEvent: (
      db: DatabaseSync,
      event: {
        component: string;
        eventType: string;
        payload?: unknown;
        runId?: string;
        status?: string;
        summary?: string;
        ticketId?: string;
      },
    ) => number;
    summarizeProofEvents: (
      db: DatabaseSync,
      options?: { component?: string; limit?: number; runId?: string; ticketId?: string },
    ) => {
      byComponent: Record<string, number>;
      byEventType: Record<string, number>;
      byStatus: Record<string, number>;
      events: number;
    };
  };

describe("proof events substrate", () => {
  it("records, lists, filters, and summarizes proof events", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "openclaw-proof-events-"));
    mkdirSync(dir, { recursive: true });
    const db = new DatabaseSync(path.join(dir, "proof.db"));
    try {
      ensureProofEventsSchema(db);
      const firstId = recordProofEvent(db, {
        component: "signal-hub",
        eventType: "SIGNAL_ROUTE",
        payload: { agentId: "research_agent", mode: "type-fallback" },
        runId: "run-1",
        status: "INFO",
        summary: "Signal hub selected agent",
        ticketId: "ticket-1",
      });
      const secondId = recordProofEvent(db, {
        component: "security-bouncer",
        eventType: "BOUNCE_REPAIR",
        payload: { repair: "restarted sidecar" },
        runId: "run-1",
        status: "PASS",
        ticketId: "ticket-1",
      });

      expect(firstId).toBeGreaterThan(0);
      expect(secondId).toBeGreaterThan(firstId);

      const events = listProofEvents(db, { ticketId: "ticket-1" });
      expect(events).toHaveLength(2);
      expect(events[0]?.payload).toEqual({ repair: "restarted sidecar" });
      expect(events[0]?.agent_os).toMatchObject({
        schemaVersion: "agent-os.proof-event.v1",
        status: "PASS",
      });
      expect(listProofEvents(db, { component: "signal-hub" })[0]?.event_type).toBe("SIGNAL_ROUTE");

      const summary = summarizeProofEvents(db, { ticketId: "ticket-1" });
      expect(summary).toMatchObject({
        byComponent: { "security-bouncer": 1, "signal-hub": 1 },
        byEventType: { BOUNCE_REPAIR: 1, SIGNAL_ROUTE: 1 },
        byStatus: { INFO: 1, PASS: 1 },
        events: 2,
      });
    } finally {
      db.close();
      rmSync(dir, { force: true, recursive: true });
    }
  });
});
