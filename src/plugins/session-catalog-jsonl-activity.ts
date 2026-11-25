import fs from "node:fs/promises";
import { readFileRangeAsync } from "../config/sessions/file-range.js";
import { hasErrnoCode } from "../infra/errno.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  isExternalUserText,
  type SessionUpstreamActivity,
  type SessionUpstreamProbe,
} from "./session-catalog.js";

const MAX_UPSTREAM_SCAN_BYTES = 1024 * 1024;
const log = createSubsystemLogger("plugins/session-catalog");

/** Read one bounded append window; each catalog owns its row and timestamp semantics. */
export async function readSessionCatalogJsonlActivity(params: {
  probe: SessionUpstreamProbe;
  filePath: string;
  offset: number;
  /** False stops before an unclassifiable row; undefined skips a non-user row. */
  classifyLine: (
    line: string,
    lineNumber: number,
  ) => { userText?: string; occurredAt?: number } | false | undefined;
}): Promise<SessionUpstreamActivity | undefined> {
  const { probe, filePath, offset } = params;
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(filePath, "r");
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      return { kind: "missing", sessionKey: probe.sessionKey };
    }
    // An inaccessible transcript must remain retryable without silently hiding the failure.
    log.warn(
      `failed to read session catalog transcript ${filePath}: ${String(error)}. ` +
        "Check that the transcript path exists and the Gateway can read it; the probe will retry automatically.",
    );
    return undefined;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      return { kind: "missing", sessionKey: probe.sessionKey };
    }
    if (stat.size <= offset) {
      return undefined;
    }
    const tail = await readFileRangeAsync(
      handle,
      offset,
      Math.min(stat.size - offset, MAX_UPSTREAM_SCAN_BYTES),
    );
    let classifiedBytes = 0;
    let lineStart = 0;
    let lineNumber = 0;
    let humanTurns = 0;
    let occurredAt: number | undefined;
    for (let index = 0; index < tail.length; index += 1) {
      if (tail[index] !== 0x0a) {
        continue;
      }
      const line = tail.subarray(lineStart, index).toString("utf8");
      lineNumber += 1;
      const user = line.trim() ? params.classifyLine(line, lineNumber) : undefined;
      if (user === false) {
        break;
      }
      if (user && isExternalUserText(probe, user.userText)) {
        humanTurns += 1;
        occurredAt = Math.max(occurredAt ?? 0, user.occurredAt ?? stat.mtimeMs);
      }
      classifiedBytes = index + 1;
      lineStart = index + 1;
    }
    if (classifiedBytes === 0) {
      return undefined;
    }
    const nextOffset = offset + classifiedBytes;
    return {
      kind: "activity",
      sessionKey: probe.sessionKey,
      humanTurns,
      nextMarker: { offset: nextOffset },
      ...(humanTurns > 0
        ? { occurredAt: occurredAt ?? stat.mtimeMs, dedupeId: String(nextOffset) }
        : {}),
    };
  } finally {
    await handle.close();
  }
}
