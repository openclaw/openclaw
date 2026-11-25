import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
import type { WebSocket } from "ws";
import type { EventFrame } from "../../packages/gateway-protocol/src/index.js";

export function collectSessionRowFrames(ws: WebSocket, rawFrames?: string[]): EventFrame[] {
  const frames: EventFrame[] = [];
  ws.on("message", (data) => {
    const raw = rawDataToString(data);
    const frame = JSON.parse(raw) as EventFrame;
    if (frame.type === "event" && ["sessions.changed", "session.message"].includes(frame.event)) {
      frames.push(frame);
      rawFrames?.push(raw);
    }
  });
  return frames;
}

type AncestorRow = { key: string; ancestorRevision?: string } & Record<string, unknown>;
type AncestorRef = { key: string; revision: string; snapshotAt: number };

/** Each socket certifies ancestors under its own random revision; compare the rows only. */
export function withoutAncestorRevisions(payload: unknown): unknown {
  const ancestors = (payload as { ancestorSessions?: AncestorRow[] } | undefined)?.ancestorSessions;
  if (!Array.isArray(ancestors)) {
    return payload;
  }
  const rows: Record<string, unknown>[] = [];
  for (const { ancestorRevision: _revision, ...row } of ancestors) {
    rows.push(row);
  }
  return { ...(payload as object), ancestorSessions: rows };
}

/**
 * Resolve legacy ancestor references the way the capable decoder does, in stream order,
 * without ancestor revisions.
 */
export function resolveLegacyAncestorRefs(frames: EventFrame[]): EventFrame[] {
  const held = new Map<string, AncestorRow>();
  const resolvedFrames: EventFrame[] = [];
  for (const frame of frames) {
    const payload = frame.payload as {
      ancestorSessions?: AncestorRow[];
      ancestorSessionRefs?: AncestorRef[];
    };
    const ancestors = payload?.ancestorSessions;
    if (!Array.isArray(ancestors)) {
      resolvedFrames.push(frame);
      continue;
    }
    for (const row of ancestors) {
      held.set(row.key, row);
    }
    const { ancestorSessionRefs = [], ...rest } = payload;
    const resolved = [...ancestors];
    for (const ref of ancestorSessionRefs) {
      const row = held.get(ref.key);
      if (row?.ancestorRevision !== ref.revision) {
        throw new Error(`unresolved ancestor reference ${ref.key}`);
      }
      resolved.push({ ...row, snapshotAt: ref.snapshotAt });
    }
    resolvedFrames.push({
      ...frame,
      payload: withoutAncestorRevisions({ ...rest, ancestorSessions: resolved }),
    });
  }
  return resolvedFrames;
}

export async function closeSessionRowSocket(ws: WebSocket): Promise<void> {
  await new Promise<void>((resolve) => {
    ws.once("close", () => resolve());
    ws.close();
  });
}
