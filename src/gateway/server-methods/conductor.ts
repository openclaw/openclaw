/**
 * Gateway RPC handlers for the Aether Conductor.
 *
 * Provides methods for external access authorization via the gateway protocol:
 *   - conductor.request    — Submit an external access request
 *   - conductor.resolve    — Resolve (approve/deny) a pending request
 *   - conductor.status     — Get conductor session state
 *   - conductor.history    — Get authorization history
 */

import crypto from "node:crypto";
import type { GatewayRequestHandlers } from "./types.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";

type ConductorRequestParams = {
  kind?: string;
  summary?: string;
  url?: string;
  service?: string;
  dataNeeded?: string;
  sessionKey?: string;
  timeoutMs?: number;
};

type ConductorResolveParams = {
  id: string;
  decision: "approve" | "deny" | "approve-with-instructions";
  instructions?: string;
};

type ConductorPendingEntry = {
  id: string;
  kind: string;
  summary: string;
  url?: string;
  createdAtMs: number;
  expiresAtMs: number;
  resolve: (decision: string, instructions?: string) => void;
};

type ConductorHistoryEntry = {
  id: string;
  kind: string;
  summary: string;
  decision: string;
  resolvedBy?: string;
  completedAtMs: number;
};

// Shared state for the gateway handlers (lives in gateway process)
const conductorPending = new Map<string, ConductorPendingEntry>();
const conductorHistory: ConductorHistoryEntry[] = [];

export const conductorHandlers: GatewayRequestHandlers = {
  "conductor.request": async ({ params, respond, context }) => {
    const p = params as ConductorRequestParams;
    if (!p.summary && !p.url) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "summary or url required"),
      );
      return;
    }

    const id = crypto.randomUUID();
    const timeoutMs = typeof p.timeoutMs === "number" ? p.timeoutMs : 120_000;
    const createdAtMs = Date.now();
    const expiresAtMs = createdAtMs + timeoutMs;

    let resolveDecision: (value: { decision: string; instructions?: string }) => void;
    const decisionPromise = new Promise<{ decision: string; instructions?: string }>(
      (resolve) => {
        resolveDecision = resolve;
      },
    );

    const entry: ConductorPendingEntry = {
      id,
      kind: p.kind ?? "unknown",
      summary: p.summary ?? `Access ${p.url}`,
      url: p.url,
      createdAtMs,
      expiresAtMs,
      resolve: (decision: string, instructions?: string) => {
        resolveDecision!({ decision, instructions });
      },
    };

    conductorPending.set(id, entry);

    // Broadcast to connected clients (apps, web UI, etc.)
    context.broadcast(
      "conductor.requested",
      {
        id,
        kind: entry.kind,
        summary: entry.summary,
        url: p.url,
        service: p.service,
        dataNeeded: p.dataNeeded,
        createdAtMs,
        expiresAtMs,
      },
      { dropIfSlow: true },
    );

    // Wait for decision with timeout
    const timer = setTimeout(() => {
      if (conductorPending.has(id)) {
        conductorPending.delete(id);
        resolveDecision!({ decision: "deny" });
      }
    }, timeoutMs);

    const result = await decisionPromise;
    clearTimeout(timer);
    conductorPending.delete(id);

    conductorHistory.push({
      id,
      kind: entry.kind,
      summary: entry.summary,
      decision: result.decision,
      completedAtMs: Date.now(),
    });

    respond(
      true,
      {
        id,
        decision: result.decision,
        instructions: result.instructions,
        createdAtMs,
        expiresAtMs,
      },
      undefined,
    );
  },

  "conductor.resolve": async ({ params, respond, client, context }) => {
    const p = params as ConductorResolveParams;
    if (!p.id || !p.decision) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "id and decision required"),
      );
      return;
    }

    if (
      p.decision !== "approve" &&
      p.decision !== "deny" &&
      p.decision !== "approve-with-instructions"
    ) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid decision"),
      );
      return;
    }

    const entry = conductorPending.get(p.id);
    if (!entry) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "unknown request id"),
      );
      return;
    }

    const resolvedBy = client?.connect?.client?.displayName ?? client?.connect?.client?.id;
    entry.resolve(p.decision, p.instructions);

    context.broadcast(
      "conductor.resolved",
      {
        id: p.id,
        decision: p.decision,
        instructions: p.instructions,
        resolvedBy,
        ts: Date.now(),
      },
      { dropIfSlow: true },
    );

    respond(true, { ok: true }, undefined);
  },

  "conductor.status": async ({ respond }) => {
    const pendingList = Array.from(conductorPending.values()).map((entry) => ({
      id: entry.id,
      kind: entry.kind,
      summary: entry.summary,
      url: entry.url,
      createdAtMs: entry.createdAtMs,
      expiresAtMs: entry.expiresAtMs,
    }));

    respond(
      true,
      {
        pending: pendingList,
        pendingCount: pendingList.length,
        historyCount: conductorHistory.length,
      },
      undefined,
    );
  },

  "conductor.history": async ({ params, respond }) => {
    const p = params as { limit?: number } | undefined;
    const limit = typeof p?.limit === "number" ? p.limit : 50;
    const recent = conductorHistory.slice(-limit);

    respond(true, { entries: recent, total: conductorHistory.length }, undefined);
  },
};
