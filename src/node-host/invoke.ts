import { spawn } from "node:child_process";
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
import { runBrowserProxyCommand } from "./invoke-browser.js";
import { handleSystemRunInvoke } from "./invoke-system-run.js";

const OUTPUT_CAP = 200_000;
const OUTPUT_EVENT_TAIL = 20_000;
const DEFAULT_NODE_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

const execHostEnforced = process.env.OPENCLAW_NODE_EXEC_HOST?.trim().toLowerCase() === "app";
const execHostFallbackAllowed =
  process.env.OPENCLAW_NODE_EXEC_FALLBACK?.trim().toLowerCase() !== "0";

type SystemRunParams = {
  command: string[];
  rawCommand?: string | null;
  cwd?: string | null;
  env?: Record<string, string>;
  timeoutMs?: number | null;
  needsScreenRecording?: boolean | null;
  agentId?: string | null;
  sessionKey?: string | null;
  approved?: boolean | null;
  approvalDecision?: string | null;
  runId?: string | null;
};

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

type RunResult = {
  exitCode?: number;
  timedOut: boolean;
  success: boolean;
  stdout: string;
  stderr: string;
  error?: string | null;
  truncated: boolean;
};

type ExecEventPayload = {
  sessionKey: string;
  runId: string;
  host: string;
  command?: string;
  exitCode?: number;
  timedOut?: boolean;
  success?: boolean;
  output?: string;
  reason?: string;
};

export type NodeInvokeRequestPayload = {
  id: string;
  nodeId: string;
  command: string;
  paramsJSON?: string | null;
  timeoutMs?: number | null;
  idempotencyKey?: string | null;
};

export type SkillBinsProvider = {
  current(force?: boolean): Promise<Set<string>>;
};

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
    let stdout = "";
    let stderr = "";
    let outputLen = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;

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
      const str = slice.toString("utf8");
      outputLen += slice.length;
      if (target === "stdout") {
        stdout += str;
      } else {
        stderr += str;
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

async function sendExecFinishedEvent(params: {
  client: GatewayClient;
  sessionKey: string;
  runId: string;
  cmdText: string;
  result: {
    stdout?: string;
    stderr?: string;
    error?: string | null;
    exitCode?: number | null;
    timedOut?: boolean;
    success?: boolean;
  };
}) {
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
      command: params.cmdText,
      exitCode: params.result.exitCode ?? undefined,
      timedOut: params.result.timedOut,
      success: params.result.success,
      output: combined,
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

  // macOS native command shims — translate structured Node API calls into shell commands.
  // This allows the headless macOS node to handle commands that would normally require
  // the iOS/Android Node app, by delegating to macOS CLI tools.
  if (process.platform === "darwin" && command !== "system.run") {
    const shimResult = await handleDarwinShim(command, frame);
    if (shimResult !== null) {
      await sendInvokeResult(client, frame, shimResult);
      return;
    }
    // If shim returned null, command is not shimmed — fall through to unsupported
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
    sendExecFinishedEvent: async ({ sessionKey, runId, cmdText, result }) => {
      await sendExecFinishedEvent({ client, sessionKey, runId, cmdText, result });
    },
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

// ==================== macOS Darwin Shims ====================
// Translate structured Node API commands into macOS shell commands.
// Returns null if the command is not shimmed.

type InvokeResult = {
  ok: boolean;
  payload?: unknown;
  payloadJSON?: string;
  error?: { code: string; message: string };
};

function execShim(cmd: string, args: string[], timeoutMs = 15_000): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { timeout: timeoutMs, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
    proc.on("close", (code) => resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code: code ?? 1 }));
    proc.on("error", (err) => resolve({ stdout: "", stderr: String(err), code: 1 }));
  });
}

async function handleDarwinShim(
  command: string,
  frame: NodeInvokeRequestPayload,
): Promise<InvokeResult | null> {
  const params = frame.paramsJSON ? JSON.parse(frame.paramsJSON) : {};

  switch (command) {
    case "system.notify": {
      const title = String(params.title ?? "OpenClaw");
      const body = String(params.body ?? "");
      const sound = String(params.sound ?? "default");
      const script = `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)} sound name ${JSON.stringify(sound)}`;
      const r = await execShim("osascript", ["-e", script]);
      return { ok: r.code === 0, payload: { delivered: r.code === 0 } };
    }

    case "camera.list": {
      const r = await execShim("system_profiler", ["SPCameraDataType", "-json"]);
      if (r.code !== 0) return { ok: false, error: { code: "UNAVAILABLE", message: r.stderr || "cannot list cameras" } };
      try {
        const data = JSON.parse(r.stdout);
        const cameras = data.SPCameraDataType ?? [];
        const devices = cameras.map((c: Record<string, string>) => ({
          name: c._name ?? "Unknown",
          id: c._name ?? "",
          position: "front",
        }));
        return { ok: true, payload: { devices } };
      } catch {
        return { ok: true, payload: { devices: [{ name: "FaceTime HD Camera", id: "default", position: "front" }] } };
      }
    }

    case "camera.snap": {
      const tmpFile = `/tmp/openclaw-snap-${Date.now()}.jpg`;
      // Try imagesnap first, fall back to screencapture of the camera window
      const hasImagesnap = (await execShim("which", ["imagesnap"])).code === 0;
      if (hasImagesnap) {
        const r = await execShim("imagesnap", ["-w", "2", tmpFile], 10_000);
        if (r.code === 0 && fs.existsSync(tmpFile)) {
          const data = fs.readFileSync(tmpFile);
          const b64 = data.toString("base64");
          fs.unlinkSync(tmpFile);
          return { ok: true, payload: { base64: b64, format: "jpeg", width: 0, height: 0 } };
        }
      }
      // Fallback: ffmpeg single-frame capture
      const hasFfmpeg = (await execShim("which", ["ffmpeg"])).code === 0;
      if (hasFfmpeg) {
        const r = await execShim("ffmpeg", ["-f", "avfoundation", "-framerate", "30", "-i", "0", "-frames:v", "1", "-y", tmpFile], 10_000);
        if (r.code === 0 && fs.existsSync(tmpFile)) {
          const data = fs.readFileSync(tmpFile);
          const b64 = data.toString("base64");
          fs.unlinkSync(tmpFile);
          return { ok: true, payload: { base64: b64, format: "jpeg", width: 0, height: 0 } };
        }
      }
      return { ok: false, error: { code: "UNAVAILABLE", message: "install imagesnap (brew install imagesnap) or ffmpeg for camera capture" } };
    }

    case "camera.clip": {
      const durationMs = Number(params.durationMs ?? 3000);
      const durationSec = Math.max(1, Math.round(durationMs / 1000));
      const tmpFile = `/tmp/openclaw-clip-${Date.now()}.mp4`;
      const hasFfmpeg = (await execShim("which", ["ffmpeg"])).code === 0;
      if (!hasFfmpeg) return { ok: false, error: { code: "UNAVAILABLE", message: "install ffmpeg for video capture" } };
      const r = await execShim("ffmpeg", ["-f", "avfoundation", "-framerate", "30", "-i", "0:0", "-t", String(durationSec), "-y", tmpFile], durationMs + 10_000);
      if (r.code === 0 && fs.existsSync(tmpFile)) {
        const data = fs.readFileSync(tmpFile);
        const b64 = data.toString("base64");
        fs.unlinkSync(tmpFile);
        return { ok: true, payload: { base64: b64, format: "mp4", durationMs: durationSec * 1000, hasAudio: true } };
      }
      return { ok: false, error: { code: "UNAVAILABLE", message: r.stderr || "ffmpeg clip capture failed" } };
    }

    case "screen.record": {
      const tmpFile = `/tmp/openclaw-screen-${Date.now()}.png`;
      const r = await execShim("screencapture", ["-x", tmpFile], 5_000);
      if (r.code === 0 && fs.existsSync(tmpFile)) {
        const data = fs.readFileSync(tmpFile);
        const b64 = data.toString("base64");
        fs.unlinkSync(tmpFile);
        return { ok: true, payload: { base64: b64, format: "png" } };
      }
      return { ok: false, error: { code: "UNAVAILABLE", message: "screencapture failed (check Screen Recording permission)" } };
    }

    case "location.get": {
      // Use CoreLocation via swift CLI one-liner
      const script = `
import CoreLocation
import Foundation
class D:NSObject,CLLocationManagerDelegate{
  let m=CLLocationManager();let s=DispatchSemaphore(value:0)
  var loc:CLLocation?
  override init(){super.init();m.delegate=self;m.desiredAccuracy=kCLLocationAccuracyBest;m.requestWhenInUseAuthorization();m.requestLocation()}
  func locationManager(_ m:CLLocationManager,didUpdateLocations l:[CLLocation]){loc=l.last;s.signal()}
  func locationManager(_ m:CLLocationManager,didFailWithError e:Error){s.signal()}
  func wait()->CLLocation?{s.wait(timeout:.now()+10);return loc}
}
let d=D();if let l=d.wait(){print("{\\"lat\\":\\(l.coordinate.latitude),\\"lon\\":\\(l.coordinate.longitude),\\"alt\\":\\(l.altitude),\\"acc\\":\\(l.horizontalAccuracy)}")}else{print("{\\"error\\":\\"location unavailable\\"}")}
`;
      const r = await execShim("swift", ["-e", script], 15_000);
      if (r.code === 0 && r.stdout.includes("lat")) {
        try {
          const loc = JSON.parse(r.stdout);
          return { ok: true, payload: { latitude: loc.lat, longitude: loc.lon, altitude: loc.alt, accuracy: loc.acc } };
        } catch {
          return { ok: false, error: { code: "UNAVAILABLE", message: "failed to parse location" } };
        }
      }
      return { ok: false, error: { code: "UNAVAILABLE", message: "Location Services unavailable (check System Settings > Privacy)" } };
    }

    case "device.info":
    case "device.status": {
      const [sw, hw] = await Promise.all([
        execShim("sw_vers", []),
        execShim("system_profiler", ["SPHardwareDataType", "-json"]),
      ]);
      const info: Record<string, unknown> = { platform: "macos" };
      if (sw.code === 0) {
        for (const line of sw.stdout.split("\n")) {
          const [k, v] = line.split(":").map((s) => s.trim());
          if (k && v) info[k.replace(/\s+/g, "_").toLowerCase()] = v;
        }
      }
      if (hw.code === 0) {
        try { info.hardware = JSON.parse(hw.stdout); } catch { /* ignore */ }
      }
      return { ok: true, payload: info };
    }

    case "contacts.search":
    case "calendar.events":
    case "reminders.list":
    case "photos.latest": {
      // These require macOS CLI tools or AppleScript bridges
      // Delegate to system.run with appropriate AppleScript
      return { ok: false, error: { code: "UNAVAILABLE", message: `${command} not yet shimmed on macOS headless node — use system.run with AppleScript/CLI as workaround` } };
    }

    default:
      return null;
  }
}
