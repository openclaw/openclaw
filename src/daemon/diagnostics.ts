/** Reads recent gateway service logs for actionable daemon restart diagnostics. */
import fs from "node:fs/promises";
import { resolveGatewayLogPaths, resolveGatewaySupervisorLogPaths } from "./restart-logs.js";

// Error patterns worth surfacing from gateway service logs after failed starts.
const GATEWAY_LOG_ERROR_PATTERNS = [
  /refusing to bind gateway/i,
  /gateway auth mode/i,
  /gateway start blocked/i,
  /failed to bind gateway socket/i,
  /tailscale .* requires/i,
];

const GATEWAY_DIAGNOSTIC_LOG_TAIL_BYTES = 256 * 1024;

/** Reads complete lines from a bounded gateway log tail. */
export async function readGatewayLogTailLines(filePath: string): Promise<string[]> {
  const handle = await fs.open(filePath, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size <= 0) {
      return [];
    }
    const bytesToRead = Math.min(stat.size, GATEWAY_DIAGNOSTIC_LOG_TAIL_BYTES);
    const buffer = Buffer.alloc(bytesToRead);
    const readStart = stat.size - bytesToRead;
    const { bytesRead } = await handle.read(buffer, 0, bytesToRead, readStart);
    let textStart = 0;
    if (readStart > 0) {
      const precedingByte = Buffer.alloc(1);
      const precedingRead = await handle.read(precedingByte, 0, 1, readStart - 1);
      if (precedingRead.bytesRead !== 1 || precedingByte[0] !== 0x0a) {
        // A byte-bound tail can start inside a line or UTF-8 sequence. Drop that
        // fragment so diagnostics never report a stale, corrupted partial line.
        const firstNewline = buffer.subarray(0, bytesRead).indexOf(0x0a);
        if (firstNewline === -1) {
          return [];
        }
        textStart = firstNewline + 1;
      }
    }
    const lines = buffer.subarray(textStart, bytesRead).toString("utf8").split(/\r?\n/u);
    if (lines.at(-1) === "") {
      lines.pop();
    }
    return lines;
  } finally {
    await handle.close();
  }
}

function findLastNonEmptyLine(lines: string[]): string | null {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]?.trim();
    if (line) {
      return line;
    }
  }
  return null;
}

export async function readLastGatewayErrorLine(
  env: NodeJS.ProcessEnv,
  options?: { platform?: NodeJS.Platform },
): Promise<string | null> {
  const platform = options?.platform ?? process.platform;
  const readStderr = platform !== "darwin";
  // launchd supervisor mode combines child stderr into stdout; other platforms
  // keep stderr as the strongest failure signal.
  const { stdoutPath, stderrPath } =
    platform === "darwin"
      ? resolveGatewaySupervisorLogPaths(env, { platform })
      : resolveGatewayLogPaths(env);
  const stderrLines = readStderr ? await readGatewayLogTailLines(stderrPath).catch(() => []) : [];
  const stdoutLines = await readGatewayLogTailLines(stdoutPath).catch(() => []);
  // stderr is the strongest failure signal on non-darwin platforms, so place it
  // last and scan from the end: the most recent stderr error line then wins over
  // any (possibly stale) stdout match, matching the stderr-first fallback below.
  const lines = [...stdoutLines, ...stderrLines].map((line) => line.trim());
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line) {
      continue;
    }
    if (GATEWAY_LOG_ERROR_PATTERNS.some((pattern) => pattern.test(line))) {
      return line;
    }
  }
  return readStderr
    ? (findLastNonEmptyLine(stderrLines) ?? findLastNonEmptyLine(stdoutLines))
    : findLastNonEmptyLine(stdoutLines);
}
