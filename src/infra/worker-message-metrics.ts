import { types } from "node:util";
import { isMainThread, type Worker } from "node:worker_threads";
import { isRecord } from "../../packages/normalization-core/src/record-coerce.ts";
import { resolveGlobalSingleton } from "../shared/global-singleton.ts";
import { normalizeWorkerRequestClass } from "./sqlite-worker-request-class.js";

export type WorkerMessageKind =
  | "sqlite_request"
  | "sqlite_reply"
  | "task_input"
  | "task_reply"
  | "task_request"
  | "task_notification"
  | "task_consumed"
  | "admission"
  | "authority"
  | "resource"
  | "lifecycle"
  | "memory"
  | "realtime"
  | "other";

export type WorkerMessageDirection = "to_worker" | "from_worker";

export type WorkerMessageMetric = {
  kind: WorkerMessageKind;
  direction: WorkerMessageDirection;
  messages: number;
  payloadBytes: number;
  payloadBytesByRequestClass?: Record<string, number>;
  unmeasuredMessages: number;
};

const counters = resolveGlobalSingleton(
  Symbol.for("openclaw.workerMessageMetrics"),
  () => new Map<WorkerMessageKind, Partial<Record<WorkerMessageDirection, WorkerMessageMetric>>>(),
);

/** The main endpoint counts each crossing once, using byte lengths already known by its owner. */
export function recordWorkerMessage(
  kind: WorkerMessageKind,
  direction: WorkerMessageDirection,
  payloadBytes?: number,
  requestClass?: string,
): void {
  if (!isMainThread) {
    return;
  }
  let directions = counters.get(kind);
  if (!directions) {
    directions = {};
    counters.set(kind, directions);
  }
  const counter = (directions[direction] ??= {
    kind,
    direction,
    messages: 0,
    payloadBytes: 0,
    unmeasuredMessages: 0,
  });
  counter.messages++;
  if (payloadBytes === undefined) {
    counter.unmeasuredMessages++;
  } else {
    counter.payloadBytes += payloadBytes;
    if (kind === "sqlite_request" || kind === "sqlite_reply") {
      const classes = (counter.payloadBytesByRequestClass ??= {});
      const label = normalizeWorkerRequestClass(requestClass);
      classes[label] = (classes[label] ?? 0) + payloadBytes;
    }
  }
}

/** Process-lifetime totals survive worker retirement and Gateway restarts in the same process. */
export function getWorkerMessageMetrics(): WorkerMessageMetric[] {
  return [...counters.values()].flatMap((directions) =>
    Object.values(directions).map((counter) =>
      Object.assign(
        {},
        counter,
        counter.payloadBytesByRequestClass
          ? { payloadBytesByRequestClass: Object.assign({}, counter.payloadBytesByRequestClass) }
          : undefined,
      ),
    ),
  );
}

function messageData(message: unknown): Record<string, unknown> | undefined {
  return isRecord(message) && !types.isProxy(message) ? message : undefined;
}

function dataProperty(message: Record<string, unknown>, key: string): unknown {
  return Object.getOwnPropertyDescriptor(message, key)?.value;
}

function messageBody(message: unknown): unknown {
  const data = messageData(message);
  const type = data && dataProperty(data, "type");
  // Retained workers relay these envelopes through the native lifetime owner.
  return data && (type === "post" || type === "message") ? dataProperty(data, "value") : message;
}

/** Known payload bytes only: no serialization, graph traversal, or envelope estimate. */
export function workerMessagePayloadBytes(message: unknown): number | undefined {
  if (!isMainThread) {
    return undefined;
  }
  const body = messageBody(message);
  const data = messageData(body);
  const payload =
    data &&
    (Object.getOwnPropertyDescriptor(data, "value") ??
      Object.getOwnPropertyDescriptor(data, "input"));
  if (payload && !("value" in payload)) {
    return undefined;
  }
  const value: unknown = payload ? payload.value : body;
  if (types.isProxy(value)) {
    return undefined;
  }
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    const preparation =
      data && dataProperty(data, "type") === "open" ? dataProperty(data, "preparation") : undefined;
    return value.byteLength + (ArrayBuffer.isView(preparation) ? preparation.byteLength : 0);
  }
  // UTF-16 storage is an O(1) approximation; UTF-8 byteLength would scan the string.
  if (typeof value === "string") {
    return value.length * 2;
  }
  if (value === null || value === undefined) {
    return 0;
  }
  return undefined;
}

function messageKind(message: unknown, fallback: WorkerMessageKind): WorkerMessageKind {
  const body = messageData(messageBody(message));
  if (!body) {
    return fallback;
  }
  switch (dataProperty(body, "status")) {
    case "ok":
    case "failed":
      return "task_reply";
    case "request":
      return "task_request";
    case "notification":
      return "task_notification";
    case "consumed":
      return "task_consumed";
    case "memory":
      return "memory";
    case "ready":
      return "lifecycle";
  }
  if (typeof dataProperty(body, "taskId") === "number") {
    return "task_input";
  }
  if (typeof dataProperty(body, "actor") === "number") {
    return "sqlite_request";
  }
  if (
    typeof dataProperty(body, "id") === "number" &&
    typeof dataProperty(body, "ok") === "boolean"
  ) {
    return "sqlite_reply";
  }
  if (typeof dataProperty(body, "operationId") === "number") {
    switch (dataProperty(body, "type")) {
      case "prepare":
      case "reclaim":
      case "canonical-validation":
        return "sqlite_request";
      case "reclaimed":
      case "refused":
      case "checkpoint":
        return "sqlite_reply";
      case "admission":
      case "admission-request":
      case "admission-release":
        return "admission";
      case "commit-request":
        return "authority";
    }
  }
  switch (dataProperty(body, "type")) {
    case "resource-owner":
    case "resource-message":
    case "resource-closed":
      return "resource";
    case "cpu":
    case "heap":
      return "memory";
    case "create":
    case "created":
    case "stop":
    case "stopped":
    case "close":
    case "closed":
    case "release":
    case "execution-exit":
    case "error":
    case "messageerror":
    case "create-error":
    case "stop-error":
    case "request-error":
      return "lifecycle";
  }
  return dataProperty(body, "closeResource") === true ? "resource" : fallback;
}

/** Observe each native boundary once; null preserves a prepared unknown byte count. */
export function observeWorkerMessage(
  message: unknown,
  direction: "to_worker" | "from_worker",
  fallbackKind: WorkerMessageKind = "other",
  payloadBytes?: number | null,
  requestClass?: string,
): void {
  if (isMainThread) {
    recordWorkerMessage(
      messageKind(message, fallbackKind),
      direction,
      payloadBytes === undefined ? workerMessagePayloadBytes(message) : (payloadBytes ?? undefined),
      requestClass,
    );
  }
}

/** Inspect instrumentation safety without invoking foreign worker accessors. */
export function canObserveWorkerMessages(worker: Worker): boolean {
  if (!Object.isExtensible(worker)) {
    return false;
  }
  for (const method of ["postMessage", "emit"]) {
    let owner: object | null = worker;
    while (owner) {
      const descriptor = Object.getOwnPropertyDescriptor(owner, method);
      if (descriptor) {
        if (!descriptor.writable || typeof descriptor.value !== "function") {
          return false;
        }
        break;
      }
      owner = Reflect.getPrototypeOf(owner);
    }
    if (!owner) {
      return false;
    }
  }
  return true;
}
