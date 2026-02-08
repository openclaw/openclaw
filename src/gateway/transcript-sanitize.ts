import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export type TranscriptSanitizeOpts = {
  maxEntryBytes: number; // hard cap for a single JSONL line
  artifactsDir?: string; // base dir for oversized artifacts
  previewChars?: number; // keep a small preview in transcript
};

function safeStringify(value: unknown): string {
  // JSON.stringify can throw on circular refs (shouldn't happen, but be defensive)
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({ __error: "stringify_failed" });
  }
}

export function sanitizeTranscriptEntry(
  transcriptPath: string,
  entry: unknown,
  opts: TranscriptSanitizeOpts,
): { entry: unknown; note?: string } {
  const maxEntryBytes = Math.max(1024, opts.maxEntryBytes);
  const previewChars = Math.max(0, Math.min(opts.previewChars ?? 2048, 32_768));

  const raw = safeStringify(entry);
  const rawBytes = Buffer.byteLength(raw, "utf8");
  if (rawBytes <= maxEntryBytes) {
    return { entry };
  }

  // Write artifact
  const baseDir = opts.artifactsDir
    ? opts.artifactsDir
    : path.join(path.dirname(transcriptPath), "artifacts", "transcript-blobs");
  fs.mkdirSync(baseDir, { recursive: true });

  const sha = crypto.createHash("sha256").update(raw).digest("hex");
  const artifactPath = path.join(baseDir, `${sha}.json`);
  if (!fs.existsSync(artifactPath)) {
    fs.writeFileSync(artifactPath, raw, "utf8");
  }

  // Replace message content with a pointer + preview.
  // We avoid making assumptions about exact message schema; best-effort if it looks like { type, message }.
  const note = `[openclaw] transcript entry elided (${rawBytes} bytes) → ${artifactPath} (sha256=${sha})`;

  const e: any = typeof entry === "object" && entry !== null ? structuredClone(entry as any) : { value: entry };

  // If this is a {type:"message", message:{...}} entry, try to preserve role and timestamp.
  if (e && typeof e === "object" && e.type === "message" && e.message && typeof e.message === "object") {
    const msg: any = e.message;
    const role = typeof msg.role === "string" ? msg.role : "unknown";

    let previewText = "";
    try {
      const msgStr = safeStringify(msg);
      previewText = msgStr.length > previewChars ? msgStr.slice(0, previewChars) + "…" : msgStr;
    } catch {
      previewText = "";
    }

    msg.content = [
      { type: "text", text: `${note}\nrole=${role}` },
      ...(previewText
        ? [{ type: "text", text: `preview (json):\n${previewText}` }]
        : []),
    ];

    // keep a structured pointer too
    msg.elided = {
      artifactPath,
      sha256: sha,
      bytes: rawBytes,
    };

    e.message = msg;
    return { entry: e, note };
  }

  return {
    entry: {
      type: "custom",
      timestamp: new Date().toISOString(),
      note,
      elided: { artifactPath, sha256: sha, bytes: rawBytes },
    },
    note,
  };
}
