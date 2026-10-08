import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstatSync } from "node:fs";
import path from "node:path";
import {
  linuxProcessGenerationMatches,
  readLinuxProcessGeneration,
  type LinuxProcessGeneration,
} from "../process/supervisor/service-child-group-ownership.js";
import { resolveDiagnosticProcessEnv } from "./process-env.js";

const LOCATOR = "OPENCLAW_PROCESS_CWD_PROVIDER";
const SCHEMA = "openclaw-cwd-provider.v1";
const RESPONSE_LIMIT = 16_384;

// A builtin-only child keeps the census synchronous and must exit before its
// response is consumed. The provider authenticates this child's kernel peer ID.
const CLIENT = `
import { readFileSync } from 'node:fs';
import { createConnection } from 'node:net';
const input = JSON.parse(readFileSync(0, 'utf8'));
const socket = createConnection(input.socket);
let chunks = [], bytes = 0, failed = false;
const fail = () => { failed = true; process.exitCode = 1; socket.destroy(); };
socket.setTimeout(1000, fail);
socket.on('error', fail);
socket.on('connect', () => socket.write(JSON.stringify(input.request) + '\\n'));
socket.on('data', chunk => {
  bytes += chunk.length;
  if (bytes > ${RESPONSE_LIMIT}) return fail();
  chunks.push(chunk);
});
socket.on('end', () => {
  if (!failed) process.stdout.write(Buffer.concat(chunks));
});
`;

function socketIdentity(socket: string): string | undefined {
  if (!/^\/run\/openclaw-cwd-[0-9a-f]{32}\/provider\.sock$/u.test(socket)) {
    return undefined;
  }
  try {
    const identities = ["/run", path.dirname(socket), socket].map((file, index) => {
      const info = lstatSync(file, { bigint: true });
      if (
        info.uid !== 0n ||
        (index === 2 && info.nlink !== 1n) ||
        (index === 2
          ? !info.isSocket() || (info.mode & 0o777n) !== 0o660n
          : !info.isDirectory() || (info.mode & 0o022n) !== 0n) ||
        (index > 0 && info.gid !== BigInt(process.getgid?.() ?? -1))
      ) {
        throw new Error("Untrusted process cwd provider path");
      }
      return [info.dev, info.ino, info.mode, info.uid, info.gid, info.ctimeNs].join(":");
    });
    return identities.join(";");
  } catch {
    return undefined;
  }
}

export function hasProcessCwdProvider(): boolean {
  const socket = process.env[LOCATOR];
  return Boolean(process.platform === "linux" && socket && socketIdentity(socket) !== undefined);
}

/** The locator grants nothing: root ownership and the provider's unit admission do. */
export function readProviderProcessWorkingDirectory(
  pid: number,
  generation: LinuxProcessGeneration,
  deadline: number,
): string | undefined {
  const socket = process.env[LOCATOR];
  const inspectorUid = process.getuid?.();
  if (
    process.platform !== "linux" ||
    !socket ||
    !Number.isSafeInteger(pid) ||
    pid < 1 ||
    !Number.isFinite(deadline) ||
    Date.now() >= deadline ||
    inspectorUid === undefined ||
    !Number.isSafeInteger(inspectorUid) ||
    inspectorUid < 0 ||
    generation.uids.length !== 4 ||
    !generation.uids.every((uid) => uid === inspectorUid)
  ) {
    return undefined;
  }
  const endpoint = socketIdentity(socket);
  const consumer = readLinuxProcessGeneration(process.pid);
  if (
    !endpoint ||
    !consumer ||
    !linuxProcessGenerationMatches(generation, readLinuxProcessGeneration(pid))
  ) {
    return undefined;
  }
  try {
    const nonce = randomBytes(16).toString("hex");
    const request = {
      schema: SCHEMA,
      nonce,
      consumer: { pid: process.pid, startTicks: consumer.startTicks },
      target: { pid, startTicks: generation.startTicks },
    };
    const timeout = Math.min(1_500, Math.floor(deadline - Date.now()));
    if (timeout < 1) {
      return undefined;
    }
    const child = spawnSync(process.execPath, ["--input-type=module", "--eval", CLIENT], {
      input: JSON.stringify({ socket, request }),
      encoding: "utf8",
      env: resolveDiagnosticProcessEnv(),
      timeout,
      killSignal: "SIGKILL",
      maxBuffer: RESPONSE_LIMIT,
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (
      child.error ||
      child.status !== 0 ||
      child.signal !== null ||
      child.stderr !== "" ||
      Date.now() >= deadline ||
      socketIdentity(socket) !== endpoint ||
      !linuxProcessGenerationMatches(consumer, readLinuxProcessGeneration(process.pid)) ||
      !linuxProcessGenerationMatches(generation, readLinuxProcessGeneration(pid))
    ) {
      return undefined;
    }
    const response: unknown = JSON.parse(child.stdout);
    if (!response || typeof response !== "object" || Array.isArray(response)) {
      return undefined;
    }
    if (
      !("schema" in response) ||
      response.schema !== SCHEMA ||
      !("nonce" in response) ||
      response.nonce !== nonce ||
      !("consumer" in response) ||
      !response.consumer ||
      typeof response.consumer !== "object" ||
      Array.isArray(response.consumer) ||
      !("pid" in response.consumer) ||
      response.consumer.pid !== process.pid ||
      !("startTicks" in response.consumer) ||
      response.consumer.startTicks !== consumer.startTicks ||
      !("target" in response) ||
      !response.target ||
      typeof response.target !== "object" ||
      Array.isArray(response.target)
    ) {
      return undefined;
    }
    const target = response.target;
    if (
      !("pid" in target) ||
      target.pid !== pid ||
      !("startTicks" in target) ||
      target.startTicks !== generation.startTicks ||
      !("ppid" in target) ||
      target.ppid !== generation.ppid ||
      !("uids" in target) ||
      !Array.isArray(target.uids) ||
      target.uids.length !== 4 ||
      !target.uids.every((value, index) => value === generation.uids[index]) ||
      !("gids" in target) ||
      !Array.isArray(target.gids) ||
      target.gids.length !== 4 ||
      !target.gids.every((value, index) => value === generation.gids[index]) ||
      !("cwd" in response) ||
      typeof response.cwd !== "string" ||
      !path.posix.isAbsolute(response.cwd) ||
      response.cwd.includes("\0") ||
      response.cwd.endsWith(" (deleted)") ||
      Buffer.byteLength(response.cwd) > 4096
    ) {
      return undefined;
    }
    return response.cwd;
  } catch {
    return undefined;
  }
}
