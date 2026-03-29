import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { GatewayClient } from "../gateway/client.js";
import {
  ensureExecApprovals,
  mergeExecApprovalsSocketDefaults,
  normalizeExecApprovals,
  readExecApprovalsSnapshot,
  saveExecApprovals,
  type ExecAsk,
  type ExecApprovalsFile,
  type ExecApprovalsResolved,
  type ExecSecurity,
} from "../infra/exec-approvals.js";
import {
  requestExecHostViaSocket,
  type ExecHostRequest,
  type ExecHostResponse,
} from "../infra/exec-host.js";
import { sanitizeHostExecEnv } from "../infra/host-env-security.js";
import { runBrowserProxyCommand } from "../plugin-sdk/browser-runtime.js";
import { buildSystemRunApprovalPlan, handleSystemRunInvoke } from "./invoke-system-run.js";
import type {
  ExecEventPayload,
  ExecFinishedEventParams,
  RunResult,
  SkillBinsProvider,
  SystemRunParams,
} from "./invoke-types.js";

const OUTPUT_CAP = 200_000;
const OUTPUT_EVENT_TAIL = 20_000;
const DEFAULT_NODE_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const WINDOWS_CODEPAGE_ENCODING_MAP: Record<number, string> = {
  65001: "utf-8",
  54936: "gb18030",
  936: "gbk",
  950: "big5",
  932: "shift_jis",
  949: "euc-kr",
  1252: "windows-1252",
};
let cachedWindowsConsoleEncoding: string | null | undefined;

const execHostEnforced = process.env.OPENCLAW_NODE_EXEC_HOST?.trim().toLowerCase() === "app";
const execHostFallbackAllowed =
  process.env.OPENCLAW_NODE_EXEC_FALLBACK?.trim().toLowerCase() !== "0";
const preferMacAppExecHost = process.platform === "darwin" && execHostEnforced;

type SystemWhichParams = {
  bins: string[];
};

type SystemExecApprovalsSetParams = {
  file: ExecApprovalsFile;
  baseHash?: string | null;
};

type ExecApprovalsSnapshot = {
  path: string;
  exists: boolean;
  hash: string;
  file: ExecApprovalsFile;
};

export type NodeInvokeRequestPayload = {
  id: string;
  nodeId: string;
  command: string;
  paramsJSON?: string | null;
  timeoutMs?: number | null;
  idempotencyKey?: string | null;
};

export type { SkillBinsProvider } from "./invoke-types.js";

function resolveExecSecurity(value?: string): ExecSecurity {
  return value === "deny" || value === "allowlist" || value === "full" ? value : "allowlist";
}

function isCmdExeInvocation(argv: string[]): boolean {
  const token = argv[0]?.trim();
  if (!token) {
    return false;
  }
  const base = path.win32.basename(token).toLowerCase();
  return base === "cmd.exe" || base === "cmd";
}

function resolveExecAsk(value?: string): ExecAsk {
  return value === "off" || value === "on-miss" || value === "always" ? value : "on-miss";
}

export function sanitizeEnv(overrides?: Record<string, string> | null): Record<string, string> {
  return sanitizeHostExecEnv({ overrides, blockPathOverrides: true });
}

function truncateOutput(raw: string, maxChars: number): { text: string; truncated: boolean } {
  if (raw.length <= maxChars) {
    return { text: raw, truncated: false };
  }
  return { text: `... (truncated) ${raw.slice(raw.length - maxChars)}`, truncated: true };
}

export function parseWindowsCodePage(raw: string): number | null {
  if (!raw) {
    return null;
  }
  const match = raw.match(/\b(\d{3,5})\b/);
  if (!match?.[1]) {
    return null;
  }
  const codePage = Number.parseInt(match[1], 10);
  if (!Number.isFinite(codePage) || codePage <= 0) {
    return null;
  }
  return codePage;
}

export function resolveWindowsConsoleEncoding(): string | null {
  if (process.platform !== "win32") {
    return null;
  }
  if (cachedWindowsConsoleEncoding !== undefined) {
    return cachedWindowsConsoleEncoding;
  }
  try {
    const result = spawnSync("cmd.exe", ["/d", "/s", "/c", "chcp"], {
      windowsHide: true,
      encoding: "buffer",
      stdio: ["ignore", "pipe", "pipe"],
    });
    // 先尝试用 GBK 解码 chcp 输出（Windows 中文默认编码）
    let raw: string;
    try {
      raw = new TextDecoder("gbk").decode(result.stdout ?? Buffer.from(""));
    } catch {
      // 如果 GBK 解码失败，回退到 UTF-8
      raw = (result.stdout ?? Buffer.from("")).toString("utf8");
    }
    const rawStderr = (result.stderr ?? Buffer.from("")).toString();
    const fullRaw = `${raw}\n${rawStderr}`;
    const codePage = parseWindowsCodePage(fullRaw);
    cachedWindowsConsoleEncoding =
      codePage !== null ? (WINDOWS_CODEPAGE_ENCODING_MAP[codePage] ?? null) : null;
  } catch {
    cachedWindowsConsoleEncoding = null;
  }
  return cachedWindowsConsoleEncoding;
}

export function decodeCapturedOutputBuffer(params: {
  buffer: Buffer;
  platform?: NodeJS.Platform;
  windowsEncoding?: string | null;
}): string {
  const utf8 = params.buffer.toString("utf8");
  const platform = params.platform ?? process.platform;
  if (platform !== "win32") {
    return utf8;
  }
  const encoding = params.windowsEncoding ?? resolveWindowsConsoleEncoding();
  
  // 如果没有获取到编码，或者是 UTF-8，尝试更智能的检测
  if (!encoding || encoding.toLowerCase() === "utf-8") {
    // 检查是否是有效的 UTF-8
    const isValidUtf8 = isValidUtf8Buffer(params.buffer);
    if (isValidUtf8) {
      return utf8;
    }
    // 如果不是有效 UTF-8，在中文 Windows 上默认尝试 GBK
    try {
      return new TextDecoder("gbk").decode(params.buffer);
    } catch {
      return utf8;
    }
  }
  
  try {
    return new TextDecoder(encoding).decode(params.buffer);
  } catch {
    // 如果指定编码失败，在中文 Windows 上回退到 GBK
    try {
      return new TextDecoder("gbk").decode(params.buffer);
    } catch {
      return utf8;
    }
  }
}

// 辅助函数：检查 Buffer 是否是有效的 UTF-8
function isValidUtf8Buffer(buffer: Buffer): boolean {
  try {
    // 尝试用 UTF-8 解码并重新编码，看是否一致
    const decoded = buffer.toString("utf8");
    const reencoded = Buffer.from(decoded, "utf8");
    // 对于短 buffer，精确比较
    if (buffer.length < 1024) {
      return buffer.equals(reencoded);
    }
    // 对于长 buffer，只比较前 1KB 和后 1KB
    const prefixMatch = buffer.subarray(0, 1024).equals(reencoded.subarray(0, Math.min(1024, reencoded.length)));
    const suffixMatch = buffer.subarray(-1024).equals(reencoded.subarray(-1024));
    return prefixMatch && suffixMatch;
  } catch {
    return false;
  }
}

function redactExecApprovals(file: ExecApprovalsFile): ExecApprovalsFile {
  const socketPath = file.socket?.path?.trim();
  return {
    ...file,
    socket: socketPath ? { path: socketPath } : undefined,
  };
}

function requireExecApprovalsBaseHash(
  params: SystemExecApprovalsSetParams,
  snapshot: ExecApprovalsSnapshot,
) {
  if (!snapshot.exists) {
    return;
  }
  if (!snapshot.hash) {
    throw new Error("INVALID_REQUEST: exec approvals base hash unavailable; reload and retry");
  }
  const baseHash = typeof params.baseHash === "string" ? params.baseHash.trim() : "";
  if (!baseHash) {
    throw new Error("INVALID_REQUEST: exec approvals base hash required; reload and retry");
  }
  if (baseHash !== snapshot.hash) {
    throw new Error("INVALID_REQUEST: exec approvals changed; reload and retry");
  }
}

async function runCommand(
  argv: string[],
  cwd: string | undefined,
  env: Record<string, string> | undefined,
  timeoutMs: number | undefined,
): Promise<RunResult> {
  return await new Promise((resolve) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let outputLen = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;
    const windowsEncoding = resolveWindowsConsoleEncoding();

    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    const onChunk = (chunk: Buffer, target: "stdout" | "stderr") => {
      if (outputLen >= OUTPUT_CAP) {
        truncated = true;
        return;
      }
      const remaining = OUTPUT_CAP - outputLen;
      const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      outputLen += slice.length;
      if (target === "stdout") {
        stdoutChunks.push(slice);
      } else {
        stderrChunks.push(slice);
      }
      if (chunk.length > remaining) {
        truncated = true;
      }
    };

    child.stdout?.on("data", (chunk) => onChunk(chunk as Buffer, "stdout"));
    child.stderr?.on("data", (chunk) => onChunk(chunk as Buffer, "stderr"));

    let timer: NodeJS.Timeout | undefined;
    if (timeoutMs && timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
      }, timeoutMs);
    }

    const finalize = (exitCode?: number, error?: string | null) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      
      const stdoutBuffer = Buffer.concat(stdoutChunks);
      const stderrBuffer = Buffer.concat(stderrChunks);
      
      const stdout = decodeCapturedOutputBuffer({
        buffer: stdoutBuffer,
        windowsEncoding,
      });
      const stderr = decodeCapturedOutputBuffer({
        buffer: stderrBuffer,
        windowsEncoding,
      });
      resolve({
        exitCode,
        timedOut,
        success: exitCode === 0 && !timedOut && !error,
        stdout,
        stderr,
        error: error ?? null,
        truncated,
      });
    };

    child.on("error", (err) => {
      finalize(undefined, err.message);
    });
    child.on("exit", (code) => {
      finalize(code === null ? undefined : code, null);
    });
  });
}

function resolveEnvPath(env?: Record<string, string>): string[] {
  const raw =
    env?.PATH ??
    (env as Record<string, string>)?.Path ??
    process.env.PATH ??
    process.env.Path ??
    DEFAULT_NODE_PATH;
  return raw.split(path.delimiter).filter(Boolean);
}

function resolveExecutable(bin: string, env?: Record<string, string>) {
  if (bin.includes("/") || bin.includes("\\")) {
    return null;
  }
  const extensions =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? process.env.PathExt ?? ".EXE;.CMD;.BAT;.COM")
          .split(";")
          .map((ext) => ext.toLowerCase())
      : [""];
  for (const dir of resolveEnvPath(env)) {
    for (const ext of extensions) {
      const candidate = path.join(dir, bin + ext);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

async function handleSystemWhich(params: SystemWhichParams, env?: Record<string, string>) {
  const bins = params.bins.map((bin) => bin.trim()).filter(Boolean);
  const found: Record<string, string> = {};
  for (const bin of bins) {
    const path = resolveExecutable(bin, env);
    if (path) {
      found[bin] = path;
    }
  }
  return { bins: found };
}

function buildExecEventPayload(payload: ExecEventPayload): ExecEventPayload {
  if (!payload.output) {
    return payload;
  }
  const trimmed = payload.output.trim();
  if (!trimmed) {
    return payload;
  }
  const { text } = truncateOutput(trimmed, OUTPUT_EVENT_TAIL);
  return { ...payload, output: text };
}

async function sendExecFinishedEvent(
  params: ExecFinishedEventParams & {
    client: GatewayClient;
  },
) {
  const combined = [params.result.stdout, params.result.stderr, params.result.error]
    .filter(Boolean)
    .join("\n");
  await sendNodeEvent(
    params.client,
    "exec.finished",
    buildExecEventPayload({
      sessionKey: params.sessionKey,
      runId: params.runId,
      host: "node",
      command: params.commandText,
      exitCode: params.result.exitCode ?? undefined,
      timedOut: params.result.timedOut,
      success: params.result.success,
      output: combined,
      suppressNotifyOnExit: params.suppressNotifyOnExit,
    }),
  );
}

async function runViaMacAppExecHost(params: {
  approvals: ExecApprovalsResolved;
  request: ExecHostRequest;
}): Promise<ExecHostResponse | null> {
  const { approvals, request } = params;
  return await requestExecHostViaSocket({
    socketPath: approvals.socketPath,
    token: approvals.token,
    request,
  });
}

async function sendJsonPayloadResult(
  client: GatewayClient,
  frame: NodeInvokeRequestPayload,
  payload: unknown,
) {
  await sendInvokeResult(client, frame, {
    ok: true,
    payloadJSON: JSON.stringify(payload),
  });
}

async function sendRawPayloadResult(
  client: GatewayClient,
  frame: NodeInvokeRequestPayload,
  payloadJSON: string,
) {
  await sendInvokeResult(client, frame, {
    ok: true,
    payloadJSON,
  });
}

async function sendErrorResult(
  client: GatewayClient,
  frame: NodeInvokeRequestPayload,
  code: string,
  message: string,
) {
  await sendInvokeResult(client, frame, {
    ok: false,
    error: { code, message },
  });
}

async function sendInvalidRequestResult(
  client: GatewayClient,
  frame: NodeInvokeRequestPayload,
  err: unknown,
) {
  await sendErrorResult(client, frame, "INVALID_REQUEST", String(err));
}

export async function handleInvoke(
  frame: NodeInvokeRequestPayload,
  client: GatewayClient,
  skillBins: SkillBinsProvider,
) {
  const command = String(frame.command ?? "");
  if (command === "system.execApprovals.get") {
    try {
      ensureExecApprovals();
      const snapshot = readExecApprovalsSnapshot();
      const payload: ExecApprovalsSnapshot = {
        path: snapshot.path,
        exists: snapshot.exists,
        hash: snapshot.hash,
        file: redactExecApprovals(snapshot.file),
      };
      await sendJsonPayloadResult(client, frame, payload);
    } catch (err) {
      const message = String(err);
      const code = message.toLowerCase().includes("timed out") ? "TIMEOUT" : "INVALID_REQUEST";
      await sendErrorResult(client, frame, code, message);
    }
    return;
  }

  if (command === "system.execApprovals.set") {
    try {
      const params = decodeParams<SystemExecApprovalsSetParams>(frame.paramsJSON);
      if (!params.file || typeof params.file !== "object") {
        throw new Error("INVALID_REQUEST: exec approvals file required");
      }
      ensureExecApprovals();
      const snapshot = readExecApprovalsSnapshot();
      requireExecApprovalsBaseHash(params, snapshot);
      const normalized = normalizeExecApprovals(params.file);
      const next = mergeExecApprovalsSocketDefaults({ normalized, current: snapshot.file });
      saveExecApprovals(next);
      const nextSnapshot = readExecApprovalsSnapshot();
      const payload: ExecApprovalsSnapshot = {
        path: nextSnapshot.path,
        exists: nextSnapshot.exists,
        hash: nextSnapshot.hash,
        file: redactExecApprovals(nextSnapshot.file),
      };
      await sendJsonPayloadResult(client, frame, payload);
    } catch (err) {
      await sendInvalidRequestResult(client, frame, err);
    }
    return;
  }

  if (command === "system.which") {
    try {
      const params = decodeParams<SystemWhichParams>(frame.paramsJSON);
      if (!Array.isArray(params.bins)) {
        throw new Error("INVALID_REQUEST: bins required");
      }
      const env = sanitizeEnv(undefined);
      const payload = await handleSystemWhich(params, env);
      await sendJsonPayloadResult(client, frame, payload);
    } catch (err) {
      await sendInvalidRequestResult(client, frame, err);
    }
    return;
  }

  if (command === "browser.proxy") {
    try {
      const payload = await runBrowserProxyCommand(frame.paramsJSON);
      await sendRawPayloadResult(client, frame, payload);
    } catch (err) {
      await sendInvalidRequestResult(client, frame, err);
    }
    return;
  }

  if (command === "system.run.prepare") {
    try {
      const params = decodeParams<{
        command?: unknown;
        rawCommand?: unknown;
        cwd?: unknown;
        agentId?: unknown;
        sessionKey?: unknown;
      }>(frame.paramsJSON);
      const prepared = buildSystemRunApprovalPlan(params);
      if (!prepared.ok) {
        await sendErrorResult(client, frame, "INVALID_REQUEST", prepared.message);
        return;
      }
      await sendJsonPayloadResult(client, frame, {
        plan: prepared.plan,
      });
    } catch (err) {
      await sendInvalidRequestResult(client, frame, err);
    }
    return;
  }

  if (command !== "system.run") {
    await sendErrorResult(client, frame, "UNAVAILABLE", "command not supported");
    return;
  }

  let params: SystemRunParams;
  try {
    params = decodeParams<SystemRunParams>(frame.paramsJSON);
  } catch (err) {
    await sendInvalidRequestResult(client, frame, err);
    return;
  }

  if (!Array.isArray(params.command) || params.command.length === 0) {
    await sendErrorResult(client, frame, "INVALID_REQUEST", "command required");
    return;
  }

  await handleSystemRunInvoke({
    client,
    params,
    skillBins,
    execHostEnforced,
    execHostFallbackAllowed,
    resolveExecSecurity,
    resolveExecAsk,
    isCmdExeInvocation,
    sanitizeEnv,
    runCommand,
    runViaMacAppExecHost,
    sendNodeEvent,
    buildExecEventPayload,
    sendInvokeResult: async (result) => {
      await sendInvokeResult(client, frame, result);
    },
    sendExecFinishedEvent: async ({ sessionKey, runId, commandText, result }) => {
      await sendExecFinishedEvent({ client, sessionKey, runId, commandText, result });
    },
    preferMacAppExecHost,
  });
}

function decodeParams<T>(raw?: string | null): T {
  if (!raw) {
    throw new Error("INVALID_REQUEST: paramsJSON required");
  }
  return JSON.parse(raw) as T;
}

export function coerceNodeInvokePayload(payload: unknown): NodeInvokeRequestPayload | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const obj = payload as Record<string, unknown>;
  const id = typeof obj.id === "string" ? obj.id.trim() : "";
  const nodeId = typeof obj.nodeId === "string" ? obj.nodeId.trim() : "";
  const command = typeof obj.command === "string" ? obj.command.trim() : "";
  if (!id || !nodeId || !command) {
    return null;
  }
  const paramsJSON =
    typeof obj.paramsJSON === "string"
      ? obj.paramsJSON
      : obj.params !== undefined
        ? JSON.stringify(obj.params)
        : null;
  const timeoutMs = typeof obj.timeoutMs === "number" ? obj.timeoutMs : null;
  const idempotencyKey = typeof obj.idempotencyKey === "string" ? obj.idempotencyKey : null;
  return {
    id,
    nodeId,
    command,
    paramsJSON,
    timeoutMs,
    idempotencyKey,
  };
}

async function sendInvokeResult(
  client: GatewayClient,
  frame: NodeInvokeRequestPayload,
  result: {
    ok: boolean;
    payload?: unknown;
    payloadJSON?: string | null;
    error?: { code?: string; message?: string } | null;
  },
) {
  try {
    await client.request("node.invoke.result", buildNodeInvokeResultParams(frame, result));
  } catch {
    // ignore: node invoke responses are best-effort
  }
}

export function buildNodeInvokeResultParams(
  frame: NodeInvokeRequestPayload,
  result: {
    ok: boolean;
    payload?: unknown;
    payloadJSON?: string | null;
    error?: { code?: string; message?: string } | null;
  },
): {
  id: string;
  nodeId: string;
  ok: boolean;
  payload?: unknown;
  payloadJSON?: string;
  error?: { code?: string; message?: string };
} {
  const params: {
    id: string;
    nodeId: string;
    ok: boolean;
    payload?: unknown;
    payloadJSON?: string;
    error?: { code?: string; message?: string };
  } = {
    id: frame.id,
    nodeId: frame.nodeId,
    ok: result.ok,
  };
  if (result.payload !== undefined) {
    params.payload = result.payload;
  }
  if (typeof result.payloadJSON === "string") {
    params.payloadJSON = result.payloadJSON;
  }
  if (result.error) {
    params.error = result.error;
  }
  return params;
}

async function sendNodeEvent(client: GatewayClient, event: string, payload: unknown) {
  try {
    await client.request("node.event", {
      event,
      payloadJSON: payload ? JSON.stringify(payload) : null,
    });
  } catch {
    // ignore: node events are best-effort
  }
}
