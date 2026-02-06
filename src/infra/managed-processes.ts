import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type {
  GatewayStartupCommand,
  GatewayStartupCommandLogConfig,
  GatewayStartupCommandRestartPolicy,
  GatewayStartupCommandStartPolicy,
} from "../config/types.gateway.js";
import { STATE_DIR } from "../config/paths.js";
import { createSubsystemLogger, type SubsystemLogger } from "../logging/subsystem.js";

type NormalizedStartupCommand = Omit<GatewayStartupCommand, "log"> & {
  id: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  startPolicy: GatewayStartupCommandStartPolicy;
  restart: GatewayStartupCommandRestartPolicy;
  stopSignal: string;
  stopTimeoutMs: number;
  log: GatewayStartupCommandLogConfig | undefined;
};

type ManagedProcessEntry = {
  config: NormalizedStartupCommand;
  pidPath: string;
  signature: string;
  pid: number | null;
  child: ChildProcess | null;
  restartAttempts: number;
  restartTimer?: NodeJS.Timeout;
  stdoutWriter?: RollingFileWriter | null;
  stderrWriter?: RollingFileWriter | null;
};

type ManagedProcessPidFile = {
  id: string;
  name?: string;
  pid: number;
  startedAt: string;
  argv: string[];
  command: string;
  args: string[];
  cwd: string;
  signature: string;
};

type ManagedProcessManagerOptions = {
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
  cwd?: string;
  log?: SubsystemLogger;
};

type StopOptions = {
  reason?: string;
};

const DEFAULT_STOP_SIGNAL = "SIGTERM";
const DEFAULT_STOP_TIMEOUT_MS = 10_000;
const DEFAULT_START_POLICY: GatewayStartupCommandStartPolicy = "reuse";
const DEFAULT_RESTART_POLICY: GatewayStartupCommandRestartPolicy = "off";

const LOG_MAX_BYTES = 5 * 1024 * 1024;
const LOG_MAX_FILES = 3;

const RESTART_BACKOFF_MS = {
  min: 1_000,
  max: 30_000,
};

const SIGKILL = "SIGKILL";

export interface IManagedProcessManager {
  start(commands?: GatewayStartupCommand[]): Promise<void>;
  stopAll(opts?: StopOptions): Promise<void>;
}

export function createManagedProcessManager(
  options: ManagedProcessManagerOptions = {},
): IManagedProcessManager {
  const env = options.env ?? process.env;
  const stateDir = options.stateDir ?? STATE_DIR;
  const cwd = options.cwd ?? process.cwd();
  const log = options.log ?? createSubsystemLogger("gateway/managed-processes");
  const manager = new ManagedProcessManager({ env, stateDir, cwd, log });
  return manager;
}

class ManagedProcessManager implements IManagedProcessManager {
  private readonly env: NodeJS.ProcessEnv;
  private readonly stateDir: string;
  private readonly cwd: string;
  private readonly log: SubsystemLogger;
  private readonly pidDir: string;
  private readonly logDir: string;
  private readonly entries = new Map<string, ManagedProcessEntry>();
  private shuttingDown = false;

  constructor(params: {
    env: NodeJS.ProcessEnv;
    stateDir: string;
    cwd: string;
    log: SubsystemLogger;
  }) {
    this.env = params.env;
    this.stateDir = params.stateDir;
    this.cwd = params.cwd;
    this.log = params.log;
    this.pidDir = path.join(this.stateDir, "managed-processes", "pids");
    this.logDir = path.join(this.stateDir, "managed-processes", "logs");
  }

  async start(commands?: GatewayStartupCommand[]) {
    const normalized = normalizeStartupCommands(commands ?? [], {
      env: this.env,
      cwd: this.cwd,
      log: this.log,
    });
    if (normalized.length === 0) {
      return;
    }
    await ensureDir(this.pidDir);
    await ensureDir(this.logDir);

    for (const config of normalized) {
      if (!config.enabled) {
        this.log.info(`startup command disabled: ${config.id}`);
        continue;
      }
      if (config.startPolicy === "never") {
        this.log.info(`startup command skipped (startPolicy=never): ${config.id}`);
        continue;
      }

      const pidPath = path.join(this.pidDir, `${config.id}.json`);
      const signature = buildSignature(config);
      const existing = await readPidFile(pidPath);
      if (existing) {
        const isAlive = await isPidAlive(existing.pid);
        if (isAlive && existing.signature === signature) {
          if (config.startPolicy === "reuse") {
            this.log.info(`reusing startup command pid ${existing.pid} for ${config.id}`);
            this.entries.set(config.id, {
              config,
              pidPath,
              signature,
              pid: existing.pid,
              child: null,
              restartAttempts: 0,
            });
            continue;
          }
          if (config.startPolicy === "always") {
            this.log.warn(
              `terminating existing startup command pid ${existing.pid} for ${config.id}`,
            );
            await this.stopProcessByPid(existing.pid, config.stopSignal, config.stopTimeoutMs);
          }
        } else if (isAlive && existing.signature !== signature) {
          this.log.warn(`startup command pid file mismatch for ${config.id}; starting fresh`);
        }
        if (!isAlive) {
          await removePidFile(pidPath);
        }
      }

      await this.spawnProcess({ config, pidPath, signature });
    }
  }

  async stopAll(opts?: StopOptions) {
    this.shuttingDown = true;
    const reason = opts?.reason ? ` (${opts.reason})` : "";
    this.log.info(`stopping managed processes${reason}`);
    const entries = Array.from(this.entries.values());
    await Promise.allSettled(
      entries.map(async (entry) => {
        await this.stopEntry(entry);
      }),
    );
    this.entries.clear();
  }

  private async spawnProcess(params: {
    config: NormalizedStartupCommand;
    pidPath: string;
    signature: string;
  }) {
    const { config, pidPath, signature } = params;
    const logWriters = await this.prepareLogWriters(config);
    try {
      const child = spawn(config.command, config.args, {
        cwd: config.cwd,
        env: config.env,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.unref();

      const entry: ManagedProcessEntry = {
        config,
        pidPath,
        signature,
        pid: child.pid ?? null,
        child,
        restartAttempts: 0,
        stdoutWriter: logWriters.stdoutWriter,
        stderrWriter: logWriters.stderrWriter,
      };
      this.entries.set(config.id, entry);

      if (!child.pid) {
        this.log.warn(`startup command spawn missing pid: ${config.id}`);
      } else {
        await writePidFile(pidPath, {
          id: config.id,
          name: config.name,
          pid: child.pid,
          startedAt: new Date().toISOString(),
          argv: [config.command, ...config.args],
          command: config.command,
          args: config.args,
          cwd: config.cwd,
          signature,
        });
      }

      if (child.stdout) {
        child.stdout.on("data", (chunk) => {
          if (logWriters.stdoutWriter) {
            logWriters.stdoutWriter.write(chunk);
          }
          if (logWriters.inherit) {
            process.stdout.write(chunk);
          }
        });
      }
      if (child.stderr) {
        child.stderr.on("data", (chunk) => {
          if (logWriters.stderrWriter) {
            logWriters.stderrWriter.write(chunk);
          }
          if (logWriters.inherit) {
            process.stderr.write(chunk);
          }
        });
      }

      child.on("exit", (code, signal) => {
        void removePidFile(pidPath);
        if (this.shuttingDown) {
          return;
        }
        if (config.restart === "on-failure" && (code !== 0 || signal)) {
          const attempts = entry.restartAttempts + 1;
          entry.restartAttempts = attempts;
          const backoff = Math.min(
            RESTART_BACKOFF_MS.max,
            RESTART_BACKOFF_MS.min * 2 ** Math.min(attempts - 1, 6),
          );
          this.log.warn(
            `startup command exited (${config.id}) code=${code ?? "null"} signal=${signal ?? "null"}; restarting in ${backoff}ms`,
          );
          entry.restartTimer = setTimeout(() => {
            entry.restartTimer = undefined;
            void this.spawnProcess({ config, pidPath, signature });
          }, backoff);
        } else if (code !== 0 || signal) {
          this.log.warn(
            `startup command exited (${config.id}) code=${code ?? "null"} signal=${signal ?? "null"}`,
          );
        }
      });
    } catch (err) {
      await logWriters.stdoutWriter?.close();
      await logWriters.stderrWriter?.close();
      this.log.error(`failed to spawn startup command ${config.id}: ${String(err)}`);
    }
  }

  private async stopEntry(entry: ManagedProcessEntry) {
    if (entry.restartTimer) {
      clearTimeout(entry.restartTimer);
      entry.restartTimer = undefined;
    }
    const pid = entry.child?.pid ?? entry.pid;
    if (!pid) {
      return;
    }
    await this.stopProcessByPid(pid, entry.config.stopSignal, entry.config.stopTimeoutMs);
    await removePidFile(entry.pidPath);
    await entry.stdoutWriter?.close();
    await entry.stderrWriter?.close();
  }

  private async stopProcessByPid(pid: number, signal: string, timeoutMs: number) {
    const stopSignal = signal || DEFAULT_STOP_SIGNAL;
    const deadline = Date.now() + timeoutMs;
    await sendSignal(pid, stopSignal);
    while (Date.now() < deadline) {
      if (!(await isPidAlive(pid))) {
        return;
      }
      await delay(200);
    }
    await sendSignal(pid, SIGKILL);
  }

  private async prepareLogWriters(config: NormalizedStartupCommand) {
    const logMode = config.log?.mode ?? "inherit";
    if (logMode === "discard") {
      return { stdoutWriter: null, stderrWriter: null, inherit: false };
    }

    const stdoutPath =
      logMode === "file" && config.log?.stdoutPath
        ? resolvePath(config.log.stdoutPath, this.cwd)
        : path.join(this.logDir, `${config.id}.stdout.log`);
    const stderrPath =
      logMode === "file" && config.log?.stderrPath
        ? resolvePath(config.log.stderrPath, this.cwd)
        : path.join(this.logDir, `${config.id}.stderr.log`);

    await ensureDir(path.dirname(stdoutPath));
    await ensureDir(path.dirname(stderrPath));

    return {
      stdoutWriter: new RollingFileWriter(stdoutPath),
      stderrWriter: new RollingFileWriter(stderrPath),
      inherit: logMode === "inherit",
    };
  }
}

class RollingFileWriter {
  private readonly filePath: string;
  private size = 0;
  private stream: fs.WriteStream | null = null;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(filePath: string) {
    this.filePath = filePath;
    this.size = this.readInitialSize();
    this.stream = fs.createWriteStream(this.filePath, { flags: "a" });
  }

  write(chunk: Buffer) {
    this.writeChain = this.writeChain.then(() => this.writeInternal(chunk));
  }

  async close() {
    await this.writeChain;
    if (this.stream) {
      await new Promise<void>((resolve) => {
        this.stream?.end(() => resolve());
      });
    }
  }

  private async writeInternal(chunk: Buffer) {
    if (!this.stream) {
      return;
    }
    if (this.size + chunk.length > LOG_MAX_BYTES) {
      await this.rotate();
    }
    await new Promise<void>((resolve, reject) => {
      this.stream?.write(chunk, (err) => {
        if (err) {
          reject(err);
          return;
        }
        this.size += chunk.length;
        resolve();
      });
    }).catch(() => {});
  }

  private async rotate() {
    if (!this.stream) {
      return;
    }
    await new Promise<void>((resolve) => {
      this.stream?.end(() => resolve());
    });
    for (let i = LOG_MAX_FILES - 1; i >= 1; i -= 1) {
      const src = `${this.filePath}.${i}`;
      const dest = `${this.filePath}.${i + 1}`;
      if (fs.existsSync(src)) {
        await fs.promises.rename(src, dest).catch(() => {});
      }
    }
    if (fs.existsSync(this.filePath)) {
      await fs.promises.rename(this.filePath, `${this.filePath}.1`).catch(() => {});
    }
    this.size = 0;
    this.stream = fs.createWriteStream(this.filePath, { flags: "a" });
  }

  private readInitialSize() {
    try {
      const stat = fs.statSync(this.filePath);
      return stat.size;
    } catch {
      return 0;
    }
  }
}

function normalizeStartupCommands(
  commands: GatewayStartupCommand[],
  params: { env: NodeJS.ProcessEnv; cwd: string; log: SubsystemLogger },
): NormalizedStartupCommand[] {
  const seen = new Set<string>();
  return commands
    .map((command, index) => {
      const baseId = command.id || command.name || `startup-${index + 1}`;
      const id = normalizeId(baseId, seen);
      const cwd = command.cwd ? resolvePath(command.cwd, params.cwd) : params.cwd;
      const env = resolveEnv(params.env, command.env);
      const args = Array.isArray(command.args) ? command.args.map(String) : [];
      const startPolicy = command.startPolicy ?? DEFAULT_START_POLICY;
      const restart = command.restart ?? DEFAULT_RESTART_POLICY;
      const stopSignal = command.stopSignal ?? DEFAULT_STOP_SIGNAL;
      const stopTimeoutMs =
        typeof command.stopTimeoutMs === "number" && Number.isFinite(command.stopTimeoutMs)
          ? Math.max(0, Math.floor(command.stopTimeoutMs))
          : DEFAULT_STOP_TIMEOUT_MS;
      return {
        ...command,
        id,
        args,
        cwd,
        env,
        startPolicy,
        restart,
        stopSignal,
        stopTimeoutMs,
        log: command.log,
      };
    })
    .filter((entry) => {
      if (!entry.command) {
        params.log.warn(`startup command missing executable: ${entry.id}`);
        return false;
      }
      return true;
    });
}

function normalizeId(value: string, seen: Set<string>) {
  let base = value.trim().replace(/[^a-zA-Z0-9_-]+/g, "-");
  if (!base) {
    base = "startup";
  }
  let candidate = base;
  let counter = 1;
  while (seen.has(candidate)) {
    counter += 1;
    candidate = `${base}-${counter}`;
  }
  seen.add(candidate);
  return candidate;
}

function resolveEnv(base: NodeJS.ProcessEnv, extra?: Record<string, string>) {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (typeof value === "string") {
      env[key] = value;
    }
  }
  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      env[key] = String(value);
    }
  }
  return env;
}

function resolvePath(input: string, cwd: string) {
  const trimmed = input.trim();
  if (!trimmed) {
    return trimmed;
  }
  if (trimmed.startsWith("~")) {
    const expanded = trimmed.replace(/^~(?=$|[\\/])/, process.env.HOME ?? "");
    return path.resolve(expanded);
  }
  if (path.isAbsolute(trimmed)) {
    return path.resolve(trimmed);
  }
  return path.resolve(cwd, trimmed);
}

function buildSignature(config: NormalizedStartupCommand) {
  return JSON.stringify({ command: config.command, args: config.args, cwd: config.cwd });
}

async function readPidFile(pidPath: string): Promise<ManagedProcessPidFile | null> {
  try {
    const raw = await fs.promises.readFile(pidPath, "utf8");
    return JSON.parse(raw) as ManagedProcessPidFile;
  } catch {
    return null;
  }
}

async function writePidFile(pidPath: string, payload: ManagedProcessPidFile) {
  await ensureDir(path.dirname(pidPath));
  await fs.promises.writeFile(pidPath, JSON.stringify(payload, null, 2), "utf8");
}

async function removePidFile(pidPath: string) {
  await fs.promises.unlink(pidPath).catch(() => {});
}

async function ensureDir(dir: string) {
  await fs.promises.mkdir(dir, { recursive: true }).catch(() => {});
}

async function isPidAlive(pid: number) {
  if (!Number.isFinite(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function sendSignal(pid: number, signal: NodeJS.Signals | string) {
  if (!Number.isFinite(pid) || pid <= 0) {
    return;
  }
  try {
    if (process.platform === "win32") {
      process.kill(pid, signal as NodeJS.Signals);
      return;
    }
    process.kill(-pid, signal as NodeJS.Signals);
  } catch {
    try {
      process.kill(pid, signal as NodeJS.Signals);
    } catch {
      /* ignore */
    }
  }
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
