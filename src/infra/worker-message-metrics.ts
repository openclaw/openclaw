import { types } from "node:util";
import { serialize } from "node:v8";
import { isMainThread, type Worker } from "node:worker_threads";
import { isRecord } from "../../packages/normalization-core/src/record-coerce.ts";
import { resolveGlobalSingleton } from "../shared/global-singleton.ts";
import { normalizeWorkerRequestClass } from "./sqlite-worker-request-class.ts";

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

type AuthorityComponent =
  | "admission_entry"
  | "admission_other"
  | "receipt_entry"
  | "receipt_events"
  | "receipt_value"
  | "receipt_other";
type ComponentSample = { bytes: number; samples: number; unmeasured: number };

export type WorkerMessageMetric = {
  kind: WorkerMessageKind;
  direction: WorkerMessageDirection;
  messages: number;
  payloadBytes: number;
  payloadBytesByRequestClass?: Record<string, number>;
  unmeasuredMessages: number;
  payloadComponents?: Record<string, Partial<Record<AuthorityComponent, ComponentSample>>>;
};

/** Whole-operation Bernoulli samples avoid aliasing alternating user/assistant appends. */
function sampleWorkerAuthorityOperation(requestClass: string | undefined): boolean {
  return (
    isMainThread &&
    normalizeWorkerRequestClass(requestClass).startsWith("session.actor.") &&
    Math.random() < 1 / 128
  );
}

/** The admission owner retains this sampling decision for all frames in one operation. */
export function recordWorkerAuthorityMessage(
  message: Record<string, unknown> | undefined,
  requestClass: string | undefined,
  sampled = sampleWorkerAuthorityOperation(requestClass),
): boolean {
  recordWorkerMessage(
    message?.kind === "sqlite-database-admissions" ? "admission" : "authority",
    "from_worker",
    typeof message?.payloadBytes === "number" ? message.payloadBytes : undefined,
    requestClass,
    sampled ? message : undefined,
  );
  return sampled;
}

function withoutField(value: unknown, field: string): unknown {
  if (!isRecord(value) || !Object.hasOwn(value, field)) {
    return value;
  }
  const copy = { ...value };
  delete copy[field];
  return copy;
}

function recordAuthorityPayload(
  counter: WorkerMessageMetric,
  message: Record<string, unknown>,
  requestClass: string | undefined,
): void {
  const label = normalizeWorkerRequestClass(requestClass);
  if (!label.startsWith("session.actor.")) {
    return;
  }
  const committed =
    message.kind === "native-settlement" && isRecord(message.settlement)
      ? message.settlement.committed
      : message.committed;
  const receipt = isRecord(committed);
  // Empty settlement frames carry no facts; do not count a second receipt sample.
  if (!receipt && !Object.hasOwn(message, "facts")) {
    return;
  }
  const components: AuthorityComponent[] = receipt
    ? ["receipt_entry", "receipt_events", "receipt_value", "receipt_other"]
    : ["admission_entry", "admission_other"];
  const totals = ((counter.payloadComponents ??= {})[label] ??= {});
  let bytes: number[] | undefined;
  let total =
    receipt && typeof message.payloadBytes === "number" ? message.payloadBytes : undefined;
  try {
    const facts = receipt ? committed.facts : message.facts;
    total ??= serialize(facts).byteLength;
    if (receipt && isRecord(facts) && isRecord(facts.receipt)) {
      const strippedReceipt: Record<string, unknown> = {
        ...facts.receipt,
        postimage: withoutField(facts.receipt.postimage, "entry"),
      };
      delete strippedReceipt.entryMetadata;
      const noEntries = {
        ...facts,
        receipt: strippedReceipt,
      };
      // Native cloning can change V8's array encoding. Bound each remainder by
      // its predecessor so main-side sizing cannot discard the worker's bytes.
      const afterEntries = Math.min(total, serialize(noEntries).byteLength);
      const noEvents = {
        ...noEntries,
        receipt: {
          ...noEntries.receipt,
          transcript: withoutField(
            withoutField(facts.receipt.transcript, "appendedEvents"),
            "authorityReceipts",
          ),
        },
      };
      const afterEvents = Math.min(afterEntries, serialize(noEvents).byteLength);
      // The phase result and transcript.append can alias the same append value.
      const other = Math.min(
        afterEvents,
        serialize({
          ...noEvents,
          value: undefined,
          receipt: {
            ...noEvents.receipt,
            transcript: withoutField(noEvents.receipt.transcript, "append"),
          },
        }).byteLength,
      );
      bytes = [total - afterEntries, afterEntries - afterEvents, afterEvents - other, other];
    } else if (
      !receipt &&
      isRecord(facts) &&
      isRecord(facts.publication) &&
      facts.publication.kind === "session-actor-admission"
    ) {
      const other = serialize({
        ...facts,
        publication: {
          ...facts.publication,
          snapshot: withoutField(facts.publication.snapshot, "entry"),
        },
      }).byteLength;
      bytes = [total - other, other];
    } else {
      bytes = receipt ? [0, 0, 0, total] : [0, total];
    }
    // Marginal V8 sizes preserve shared references. Unsupported graphs remain explicitly unmeasured.
    if (bytes.some((value) => value < 0)) {
      bytes = undefined;
    }
  } catch {
    // Telemetry must not refuse authority (e.g. transferable or shared-buffer facts).
  }
  for (const [index, component] of components.entries()) {
    const sample = (totals[component] ??= { bytes: 0, samples: 0, unmeasured: 0 });
    if (bytes) {
      sample.bytes += bytes[index] ?? 0;
      sample.samples++;
    } else {
      sample.unmeasured++;
      // A failed breakdown must not erase a receipt's independently known total.
      if (component === "receipt_other" && total !== undefined) {
        sample.bytes += total;
      }
    }
  }
}

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
  sampledAuthorityMessage?: Record<string, unknown>,
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
    if (kind === "sqlite_request" || kind === "sqlite_reply" || kind === "authority") {
      const classes = (counter.payloadBytesByRequestClass ??= {});
      const label = normalizeWorkerRequestClass(requestClass);
      classes[label] = (classes[label] ?? 0) + payloadBytes;
    }
  }
  if (sampledAuthorityMessage && kind === "authority" && direction === "from_worker") {
    recordAuthorityPayload(counter, sampledAuthorityMessage, requestClass);
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
        counter.payloadComponents
          ? { payloadComponents: structuredClone(counter.payloadComponents) }
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
