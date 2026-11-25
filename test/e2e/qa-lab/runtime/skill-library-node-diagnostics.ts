import fs from "node:fs/promises";
import { readFileWindowFully } from "@openclaw/fs-safe/advanced";
import { redactSensitiveLines, resolveRedactOptions } from "../../../../src/logging/redact.js";

const MAX_LOG_BYTES = 16_384;

function afterPartialLine(text: string) {
  const newline = text.indexOf("\n");
  return newline < 0 ? "" : text.slice(newline + 1);
}

/** Read only at failure, before the node fixture removes its logs. */
export async function readSkillLibraryNodeDiagnostics(
  node: { logFile: string; logs: () => string },
  stage: string,
) {
  const capturedAtMonotonicMs = performance.now();
  let fileLog: string;
  try {
    const handle = await fs.open(node.logFile, "r");
    try {
      const { size } = await handle.stat();
      const start = Math.max(0, size - MAX_LOG_BYTES);
      const buffer = Buffer.alloc(size - start);
      const length = await readFileWindowFully(handle, buffer, start);
      const text = buffer.toString("utf8", 0, length);
      const completeStart = start > 0 ? afterPartialLine(text) : text;
      fileLog = completeStart.slice(0, completeStart.lastIndexOf("\n") + 1);
    } finally {
      await handle.close();
    }
  } catch {
    // A missing log must not replace the original assertion or expose error paths.
    fileLog = "[node log unavailable]";
  }
  const stdio = node.logs();
  const completeStdioStart = stdio.length >= 8_000 ? afterPartialLine(stdio) : stdio;
  const completeStdio = completeStdioStart.slice(0, completeStdioStart.lastIndexOf("\n") + 1);
  const redaction = resolveRedactOptions({ mode: "tools" });
  return {
    stage,
    capturedAtMonotonicMs,
    nodeLog: redactSensitiveLines(fileLog.split("\n"), redaction),
    nodeStdio: redactSensitiveLines(completeStdio.split("\n"), redaction),
  };
}
