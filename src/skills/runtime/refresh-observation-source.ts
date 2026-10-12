import path from "node:path";
import type { Root } from "@openclaw/fs-safe/root";
import type { WatchHealth, WatchScope } from "@openclaw/fs-safe/watch";
import {
  resolveFsObservationMode,
  resolveFsObservationIntervalMs,
} from "../../infra/fs-observation-mode.js";
import { observationPrefixKind } from "../../infra/fs-observation-root.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { WatchTarget } from "./refresh-watch-targets.types.js";

/** Observe a blocking link entry, never an implicit recursive target admission. */
export async function skillsObservationScope(
  authority: Root,
  target: WatchTarget,
  signal: AbortSignal,
): Promise<WatchScope> {
  const relative = path.relative(authority.rootDir, target.path);
  const parts = relative.split(path.sep).filter(Boolean);
  let parent = ".";
  for (const part of parts) {
    signal.throwIfAborted();
    parent = path.join(parent, part);
    const kind = await observationPrefixKind(authority, parent, signal);
    if (kind === "missing") {
      break;
    }
    if (kind !== "directory") {
      return { path: parent, kind: "entry" };
    }
  }
  // Tree depth counts entries, not registered directories. Source-origin
  // metadata is two entries below the deepest admitted skill directory.
  return { path: relative || ".", kind: "tree", depth: target.depth + 2 };
}

/** Capture transport policy and its diagnostic lifetime with the subscription. */
export function skillsObservationTransport(targetPath: string) {
  const mode = resolveFsObservationMode();
  const pollIntervalMs = resolveFsObservationIntervalMs(process.env, 30_000);
  let pollingFallbackWarned = false;
  return {
    mode,
    pollIntervalMs,
    reportHealth: (health: WatchHealth) => {
      if (
        mode !== "auto" ||
        health.mode !== "poll" ||
        health.state !== "ready" ||
        pollingFallbackWarned
      ) {
        return;
      }
      pollingFallbackWarned = true;
      const reason = health.failure
        ? `${health.failure.code ? `${health.failure.code}: ` : ""}${String(health.failure.error)}`
        : "fs-safe did not report a reason";
      createSubsystemLogger("gateway/skills").warn(
        `skills watcher using fallback polling (${targetPath}) every ${pollIntervalMs} ms: ${reason}`,
      );
    },
  };
}
