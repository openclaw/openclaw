import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { CONTROL_UI_BUILD_INFO } from "../build-info.ts";
import { scheduleStaleChunkReload } from "./stale-chunk-reload.ts";

/** Unclaimed background failures may reload only when the serving build changed. */
export async function recoverUnclaimedImport(url: string): Promise<void> {
  try {
    const response = await fetch(url, {
      cache: "no-store",
      headers: { "X-OpenClaw-Reachability-Probe": "1" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      return;
    }
    // Public-asset/cache stamps can survive updates; use the full build identity.
    const encoded = /globalThis\.OPENCLAW_CONTROL_UI_BUILD_INFO=(.*?);<\/script>/u.exec(
      await response.text(),
    )?.[1];
    const buildInfo: unknown = encoded ? JSON.parse(encoded) : null;
    if (isRecord(buildInfo) && buildInfo.buildId === CONTROL_UI_BUILD_INFO.buildId) {
      return;
    }
    await scheduleStaleChunkReload();
  } catch {
    // A second interruption cannot justify replacing a usable document.
  }
}
