import { hash, randomUUID } from "node:crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  TRAJECTORY_RUNTIME_CAPTURE_MAX_BYTES,
  TRAJECTORY_RUNTIME_EVENT_MAX_BYTES,
} from "./paths.js";
import type { TrajectoryEvent } from "./types.js";

export const TRAJECTORY_SNAPSHOT_FRAGMENT = "model.snapshot.fragment";

type SerializedEvent = { event: TrajectoryEvent; line: string };

/** Split only the prepared diagnostic snapshot; individual values keep their existing bounds. */
export function fragmentTrajectorySnapshot(
  event: TrajectoryEvent,
  originalBytes: number,
  maxCaptureBytes: number,
): SerializedEvent[] | undefined {
  const captureLimit = Math.min(maxCaptureBytes, TRAJECTORY_RUNTIME_CAPTURE_MAX_BYTES);
  const snapshot = event.data?.messagesSnapshot;
  if (
    event.type !== "model.completed" ||
    !Array.isArray(snapshot) ||
    snapshot.length === 0 ||
    event.data?.truncated !== undefined ||
    event.data?.droppedFields !== undefined ||
    originalBytes > captureLimit
  ) {
    return undefined;
  }
  const id = randomUUID();
  const messages = snapshot.map((value) => {
    const json = JSON.stringify(value) ?? "null";
    return { value, json, bytes: Buffer.byteLength(json) };
  });
  // Older exporters omit credential-classified fields, including this private content checksum.
  let integrityToken = "0".repeat(64);
  const fragment = (chunk: unknown[], index: number, count: number): TrajectoryEvent => ({
    ...event,
    type: TRAJECTORY_SNAPSHOT_FRAGMENT,
    seq: event.seq + index,
    sourceSeq: event.seq + index,
    data: {
      truncated: true,
      reason: "trajectory-snapshot-fragment",
      snapshotId: id,
      index,
      count,
      integrityToken,
      messagesSnapshot: chunk,
    },
  });
  const groups: (typeof messages)[] = [];
  let group: typeof messages = [];
  let groupBytes = 0;
  // Reserve the longest numeric header while choosing groups; final headers are smaller.
  const overhead = Buffer.byteLength(
    JSON.stringify(fragment([], Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)),
  );
  for (const message of messages) {
    if (overhead + message.bytes > TRAJECTORY_RUNTIME_EVENT_MAX_BYTES) {
      return undefined;
    }
    if (
      overhead + groupBytes + (group.length ? 1 : 0) + message.bytes >
      TRAJECTORY_RUNTIME_EVENT_MAX_BYTES
    ) {
      groups.push(group);
      group = [];
      groupBytes = 0;
    }
    groupBytes += (group.length ? 1 : 0) + message.bytes;
    group.push(message);
  }
  groups.push(group);
  const data = { ...event.data };
  delete data.messagesSnapshot;
  const parent: TrajectoryEvent = {
    ...event,
    seq: event.seq + groups.length,
    sourceSeq: event.seq + groups.length,
    data: {
      ...data,
      truncated: true,
      reason: "trajectory-event-size-limit",
      originalBytes,
      limitBytes: TRAJECTORY_RUNTIME_EVENT_MAX_BYTES,
      droppedFields: ["messagesSnapshot"],
      messagesSnapshotFragments: { id, count: groups.length, integrityToken },
    },
  };
  const sizes = groups.map(
    (chunk, index) =>
      Buffer.byteLength(JSON.stringify(fragment([], index, groups.length))) +
      chunk.reduce((sum, message) => sum + message.bytes, 0) +
      chunk.length -
      1,
  );
  sizes.push(Buffer.byteLength(JSON.stringify(parent)));
  if (
    sizes.some((bytes) => bytes > TRAJECTORY_RUNTIME_EVENT_MAX_BYTES) ||
    sizes.reduce((total, bytes) => total + bytes + 1, 0) > captureLimit
  ) {
    return undefined;
  }
  integrityToken = hash("sha256", `[${messages.map(({ json }) => json).join(",")}]`);
  parent.data!.messagesSnapshotFragments = { id, count: groups.length, integrityToken };
  const records = groups.map((chunk, index) => {
    const entry = fragment(
      chunk.map(({ value }) => value),
      index,
      groups.length,
    );
    const header = JSON.stringify({
      ...entry,
      data: { ...entry.data, messagesSnapshot: undefined },
    });
    return {
      event: entry,
      // The header ends with the data and event braces; append the already encoded array once.
      line: `${header.slice(0, -2)},"messagesSnapshot":[${chunk.map(({ json }) => json).join(",")}]}}`,
    };
  });
  records.push({ event: parent, line: JSON.stringify(parent) });
  return records;
}

/** Restore only complete groups. Lost/evicted fragments keep their explicit partial markers. */
export function restoreTrajectorySnapshots(events: TrajectoryEvent[]): TrajectoryEvent[] {
  const groups = new Map<string, TrajectoryEvent[]>();
  for (const event of events) {
    if (event.type !== TRAJECTORY_SNAPSHOT_FRAGMENT || typeof event.data?.snapshotId !== "string") {
      continue;
    }
    const group = groups.get(event.data.snapshotId) ?? [];
    group.push(event);
    groups.set(event.data.snapshotId, group);
  }
  const consumed = new Set<TrajectoryEvent>();
  const replacements = new Map<TrajectoryEvent, TrajectoryEvent>();
  const parents = new Set<unknown>();
  // The store scopes the rows; the snapshot UUID and sequence bind each fragment group.
  const sameContext = (left: TrajectoryEvent, right: TrajectoryEvent) =>
    left.source === "runtime" &&
    right.source === "runtime" &&
    left.sessionKey === right.sessionKey &&
    left.ts === right.ts &&
    left.workspaceDir === right.workspaceDir &&
    left.provider === right.provider &&
    left.modelId === right.modelId &&
    left.modelApi === right.modelApi;
  for (const event of events) {
    const data = event.data;
    const reference = data?.messagesSnapshotFragments;
    if (
      event.type !== "model.completed" ||
      !data ||
      !isRecord(reference) ||
      data.truncated !== true ||
      data.reason !== "trajectory-event-size-limit" ||
      !Array.isArray(data.droppedFields) ||
      !data.droppedFields.includes("messagesSnapshot")
    ) {
      continue;
    }
    const { id, count, integrityToken } = reference;
    parents.add(id);
    const fragments = typeof id === "string" ? groups.get(id) : undefined;
    if (
      !fragments ||
      !Number.isSafeInteger(count) ||
      Number(count) < 1 ||
      fragments.length !== count ||
      typeof integrityToken !== "string" ||
      !/^[a-f0-9]{64}$/.test(integrityToken)
    ) {
      continue;
    }
    const ordered = fragments.toSorted(
      (left, right) => Number(left.data?.index) - Number(right.data?.index),
    );
    const parentSeq = event.sourceSeq ?? event.seq;
    const messages: unknown[] = [];
    let complete = true;
    for (const [index, part] of ordered.entries()) {
      if (
        !sameContext(part, event) ||
        part.data?.truncated !== true ||
        part.data.reason !== "trajectory-snapshot-fragment" ||
        part.data.index !== index ||
        part.data.count !== count ||
        part.data.integrityToken !== integrityToken ||
        (part.sourceSeq ?? part.seq) !== parentSeq - count + index ||
        !Array.isArray(part.data.messagesSnapshot)
      ) {
        complete = false;
        break;
      }
      for (const message of part.data.messagesSnapshot) {
        messages.push(message);
      }
    }
    if (!complete) {
      continue;
    }
    if (hash("sha256", JSON.stringify(messages)) !== integrityToken) {
      continue;
    }
    const restored: Record<string, unknown> = { ...data, messagesSnapshot: messages };
    delete restored.messagesSnapshotFragments;
    const droppedFields = data.droppedFields.filter((key) => key !== "messagesSnapshot");
    if (droppedFields.length > 0) {
      restored.droppedFields = droppedFields;
    } else {
      for (const key of ["truncated", "reason", "originalBytes", "limitBytes", "droppedFields"]) {
        delete restored[key];
      }
    }
    replacements.set(event, { ...event, data: restored });
    for (const part of fragments) {
      consumed.add(part);
    }
  }
  const reportedOrphans = new Set<unknown>();
  return events.flatMap((event) => {
    if (consumed.has(event)) {
      return [];
    }
    if (event.type === TRAJECTORY_SNAPSHOT_FRAGMENT) {
      const id = event.data?.snapshotId;
      if (parents.has(id) || reportedOrphans.has(id)) {
        return [];
      }
      reportedOrphans.add(id);
      return [
        {
          ...event,
          type: "trace.truncated",
          data: { truncated: true, reason: "incomplete-trajectory-snapshot" },
        },
      ];
    }
    const restored = replacements.get(event);
    if (restored) {
      return [restored];
    }
    if (event.type === "model.completed" && event.data?.messagesSnapshotFragments) {
      const data = { ...event.data };
      delete data.messagesSnapshotFragments;
      return [{ ...event, data }];
    }
    return [event];
  });
}
