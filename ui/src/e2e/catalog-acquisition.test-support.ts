import { createHash } from "node:crypto";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import type { Page } from "playwright";

type Trigger =
  | "startup"
  | "prefetch"
  | "picker-open"
  | "publication"
  | "publication-catch-up"
  | "refresh"
  | "retry"
  | "reconnect";
type Method = "models.list" | "models.authStatus";
type Caller = "browser" | "readback";

/** Observed wire/publication order, not a claim of causality across the Gateway process. */
export function createCatalogAcquisitionDiagnostics() {
  const started = Date.now();
  const events: unknown[] = [];
  const acquisitions: unknown[] = [];
  const pending = new Map<string, object>();
  let trigger: Trigger = "startup";
  let generation = 0;
  let fingerprint: string | undefined;
  let requestOrdinal = 0;
  let connections = 0;
  let droppedEvents = 0;
  let droppedAcquisitions = 0;
  let droppedRequests = 0;
  const stamp = () => ({ elapsedMs: Date.now() - started, trigger, generation });
  const record = (event: object) => {
    if (events.length === 64) {
      events.shift();
      droppedEvents += 1;
    }
    events.push({ ...stamp(), ...event });
  };
  const catalog = (value: unknown) => {
    const result = asNullableRecord(value);
    if (!Array.isArray(result?.models)) {
      return;
    }
    // The wire has no runtime-owner generation ID. Label distinct observed
    // catalog receipts locally; never print model/account data or raw payloads.
    const next = createHash("sha256")
      .update(JSON.stringify([result.models, result.pendingProviders, result.refreshFailed]))
      .digest("hex")
      .slice(0, 12);
    if (next !== fingerprint) {
      fingerprint = next;
      generation += 1;
    }
    record({
      kind: "catalog-receipt",
      fingerprint,
      models: result.models.length,
      pendingProviders: Array.isArray(result.pendingProviders) ? result.pendingProviders.length : 0,
      ollamaPending:
        Array.isArray(result.pendingProviders) && result.pendingProviders.includes("ollama"),
      refreshFailed: result.refreshFailed === true,
    });
  };
  const diagnostics = {
    trigger(next: Trigger) {
      trigger = next;
      record({ kind: "trigger" });
    },
    connected() {
      connections += 1;
      record({ kind: "connection", connection: connections });
      return connections;
    },
    request(id: string, caller: Caller, method: Method, refresh: boolean) {
      const request = {
        ...stamp(),
        kind: "request",
        request: ++requestOrdinal,
        caller: `${caller}.${method}`,
        refresh,
      };
      if (pending.size === 16) {
        pending.delete(pending.keys().next().value!);
        droppedRequests += 1;
      }
      pending.set(id, request);
      record(request);
    },
    reply(id: string, ok: boolean, payload?: unknown) {
      const request = pending.get(id);
      if (!request) {
        return;
      }
      pending.delete(id);
      record({ kind: "reply", request, ok });
      catalog(payload);
    },
    publication(event: string, payload: unknown) {
      if (
        event !== "models.snapshot" &&
        event !== "chat.metadata.changed" &&
        event !== "config.changed"
      ) {
        return;
      }
      record({ kind: "publication", event });
      if (event === "models.snapshot") {
        catalog(asNullableRecord(payload)?.catalog);
      }
      // Subsequent passive reads may be catch-up; active RPCs remain in the
      // acquisition's candidate list even if the page starts another action.
      if (
        (event !== "chat.metadata.changed" ||
          asNullableRecord(payload)?.modelCatalogChanged !== false) &&
        trigger !== "startup" &&
        trigger !== "prefetch" &&
        trigger !== "reconnect"
      ) {
        trigger = "publication-catch-up";
      }
    },
    acquired(status: number) {
      const acquisition = {
        ...stamp(),
        acquisition: acquisitions.length + droppedAcquisitions + 1,
        caller: "ollama-provider-models.tags",
        status,
        candidateCallers: [...pending.values()],
      };
      if (acquisitions.length === 32) {
        acquisitions.shift();
        droppedAcquisitions += 1;
      }
      acquisitions.push(acquisition);
      record({ kind: "acquisition", status });
    },
    snapshot() {
      return {
        generationMeaning:
          "distinct observed catalog receipts; Gateway owner generation is not on the wire",
        attribution:
          "trigger is observed action/event context; candidateCallers are overlapping RPCs, not proven upstream causes",
        connections,
        generation,
        fingerprint,
        acquisitions,
        pending: [...pending.values()],
        events,
        droppedEvents,
        droppedAcquisitions,
        droppedRequests,
      };
    },
    observe(page: Page) {
      page.on("websocket", (socket) => {
        const connection = diagnostics.connected();
        socket.on("close", () => record({ kind: "disconnect", connection }));
        socket.on("framesent", ({ payload }) => {
          const frame = asNullableRecord(JSON.parse(payload.toString()));
          if (
            frame?.type === "req" &&
            typeof frame.id === "string" &&
            (frame.method === "models.list" || frame.method === "models.authStatus")
          ) {
            diagnostics.request(
              frame.id,
              "browser",
              frame.method,
              asNullableRecord(frame.params)?.refresh === true,
            );
          }
        });
        socket.on("framereceived", ({ payload }) => {
          const frame = asNullableRecord(JSON.parse(payload.toString()));
          if (frame?.type === "res" && typeof frame.id === "string") {
            diagnostics.reply(frame.id, frame.ok === true, frame.payload);
          } else if (frame?.type === "event" && typeof frame.event === "string") {
            diagnostics.publication(frame.event, frame.payload);
          }
        });
      });
    },
  };
  return diagnostics;
}
