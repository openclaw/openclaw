/** Transport-independent CLI node-host runtime shared by Gateway and app workers. */
import fs from "node:fs";
import type { OpenClawConfig } from "../config/config.js";
import { getRuntimeConfig } from "../config/config.js";
import type { SkillBinTrustEntry } from "../infra/exec-approvals.js";
import { resolveExecutableFromPathEnv } from "../infra/executable-path.js";
import {
  NODE_AGENT_CLI_CLAUDE_RUN_COMMAND,
  NODE_DUPLEX_INVOKE_IDLE_TIMEOUT_MS,
  NODE_EXEC_APPROVALS_COMMANDS,
  NODE_FS_LIST_DIR_COMMAND,
  NODE_MCP_TOOLS_CALL_COMMAND,
  NODE_SYSTEM_RUN_COMMANDS,
} from "../infra/node-commands.js";
import { ensureOpenClawCliOnPath } from "../infra/path-env.js";
import { logDebug } from "../logger.js";
import type { OpenClawPluginNodeHostCommandIo } from "../plugins/types.js";
import type { NodeHostClient } from "./client.js";
import { handleInvoke, type NodeInvokeRequestPayload, type SkillBinsProvider } from "./invoke.js";
import { startNodeHostMcpManager, type NodeHostMcpManager } from "./mcp.js";
import { createNodeInvokeProgressWriter } from "./node-invoke-progress.js";
import {
  ensureNodeHostPluginRegistry,
  isRegisteredNodeHostCommandDuplex,
  listRegisteredNodeHostCapsAndCommands,
} from "./plugin-node-host.js";
import { scanNodeHostedSkills } from "./skills.js";

const DEFAULT_NODE_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

type NodeHostManifest = {
  caps: string[];
  commands: string[];
  pathEnv: string;
};

export type NodeHostInventory = {
  skills: unknown[] | null;
  pluginTools: unknown[];
};

type PreparedNodeHostRuntime = {
  manifest: NodeHostManifest;
  initialInventory: NodeHostInventory;
  start(params: {
    client: NodeHostClient;
    onInventoryChanged?: (inventory: NodeHostInventory) => void;
  }): ActiveNodeHostRuntime;
};

type ActiveNodeHostRuntime = {
  invoke(frame: NodeInvokeRequestPayload): Promise<void>;
  handleInput(invokeId: string, seq: number, payloadJSON: string): void;
  cancel(invokeId: string): void;
  cancelAll(): void;
  close(): Promise<void>;
};

type NodeInvokeInputTarget = {
  nextInputSeq: number;
  input?: (payloadJSON: string) => void;
  // PTY handlers attach only after async spawn, while Gateway input may arrive immediately.
  // Keep that spawn-window input so the sequence cannot wedge before registration.
  pendingInput: Array<{ payloadJSON: string; bytes: number }>;
  pendingInputBytes: number;
  inputFailed: boolean;
  abort: (reason: Error) => void;
};

const MAX_PENDING_INVOKE_INPUT_BYTES = 64 * 1024;

function dispatchNodeInvokeInput(
  target: NodeInvokeInputTarget | undefined,
  seq: number,
  payloadJSON: string,
): boolean {
  if (!target || target.inputFailed || seq < target.nextInputSeq) {
    return false;
  }
  if (seq > target.nextInputSeq) {
    logDebug(`node-host: input sequence gap: expected ${target.nextInputSeq}, received ${seq}`);
  }
  target.nextInputSeq = seq + 1;
  if (target.input) {
    target.input(payloadJSON);
    return true;
  }
  const bytes = Buffer.byteLength(payloadJSON, "utf8");
  if (target.pendingInputBytes + bytes > MAX_PENDING_INVOKE_INPUT_BYTES) {
    target.pendingInput.length = 0;
    target.pendingInputBytes = 0;
    target.inputFailed = true;
    target.abort(new Error("terminal input exceeded the 64 KiB pre-spawn buffer"));
    logDebug("node-host: aborted invoke after buffered input exceeded 64 KiB");
    return false;
  }
  target.pendingInput.push({ payloadJSON, bytes });
  target.pendingInputBytes += bytes;
  return true;
}

function registerNodeInvokeInputHandler(
  target: NodeInvokeInputTarget,
  input: (payloadJSON: string) => void,
): void {
  if (target.inputFailed) {
    return;
  }
  target.input = input;
  for (const pending of target.pendingInput.splice(0)) {
    input(pending.payloadJSON);
  }
  target.pendingInputBytes = 0;
}

function resolveExecutablePathFromEnv(bin: string, pathEnv: string): string | null {
  if (bin.includes("/") || bin.includes("\\")) {
    return null;
  }
  return resolveExecutableFromPathEnv(bin, pathEnv) ?? null;
}

function resolveExecutableTrustPathFromEnv(bin: string, pathEnv: string): string | null {
  const resolvedPath = resolveExecutablePathFromEnv(bin, pathEnv);
  if (!resolvedPath) {
    return null;
  }
  try {
    return fs.realpathSync(resolvedPath);
  } catch {
    return resolvedPath;
  }
}

function resolveSkillBinTrustEntries(bins: string[], pathEnv: string): SkillBinTrustEntry[] {
  const trustEntries: SkillBinTrustEntry[] = [];
  const seen = new Set<string>();
  for (const raw of bins) {
    const name = raw.trim();
    if (!name) {
      continue;
    }
    const resolvedPath = resolveExecutableTrustPathFromEnv(name, pathEnv);
    if (!resolvedPath) {
      continue;
    }
    const key = `${name}\u0000${resolvedPath}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    trustEntries.push({ name, resolvedPath });
  }
  return trustEntries.toSorted(
    (left, right) =>
      left.name.localeCompare(right.name) || left.resolvedPath.localeCompare(right.resolvedPath),
  );
}

class SkillBinsCache implements SkillBinsProvider {
  private bins: SkillBinTrustEntry[] = [];
  private lastRefresh = 0;
  private readonly ttlMs = 90_000;

  constructor(
    private readonly client: NodeHostClient,
    private readonly pathEnv: string,
  ) {}

  async current(force = false): Promise<SkillBinTrustEntry[]> {
    if (force || Date.now() - this.lastRefresh > this.ttlMs) {
      await this.refresh();
    }
    return this.bins;
  }

  private async refresh() {
    try {
      const res = await this.client.request<{ bins: Array<unknown> }>("skills.bins", {});
      const bins = Array.isArray(res?.bins) ? res.bins.map((bin) => String(bin)) : [];
      this.bins = resolveSkillBinTrustEntries(bins, this.pathEnv);
      this.lastRefresh = Date.now();
    } catch {
      if (!this.lastRefresh) {
        this.bins = [];
      }
    }
  }
}

function ensureNodePathEnv(): string {
  ensureOpenClawCliOnPath({ pathEnv: process.env.PATH ?? "" });
  const current = process.env.PATH ?? "";
  if (current.trim()) {
    return current;
  }
  process.env.PATH = DEFAULT_NODE_PATH;
  return DEFAULT_NODE_PATH;
}

function createInventory(params: {
  skills: unknown[] | null;
  pluginTools: unknown[];
  mcpManager?: NodeHostMcpManager;
}): NodeHostInventory {
  const pluginTools = [...params.pluginTools, ...(params.mcpManager?.descriptors ?? [])].toSorted(
    (left, right) => {
      const a = left as { pluginId?: string; name?: string };
      const b = right as { pluginId?: string; name?: string };
      return (
        (a.pluginId ?? "").localeCompare(b.pluginId ?? "") ||
        (a.name ?? "").localeCompare(b.name ?? "")
      );
    },
  );
  return { skills: params.skills, pluginTools };
}

export async function prepareNodeHostRuntime(params?: {
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  /** The embedded app worker never advertises native agent runs. */
  enableAgentRuns?: boolean;
}): Promise<PreparedNodeHostRuntime> {
  const config = params?.config ?? getRuntimeConfig();
  const env = params?.env ?? process.env;
  await ensureNodeHostPluginRegistry({ config, env });
  const pathEnv = ensureNodePathEnv();
  env.PATH = pathEnv;
  const duplexEnabled = params?.enableAgentRuns === true;
  const pluginNodeHost = listRegisteredNodeHostCapsAndCommands(
    { config, env },
    { includeDuplex: duplexEnabled },
  );
  // Opt-in and binary resolution are node-local enforcement points. A Gateway
  // cannot advertise or enable this command on the host's behalf.
  const claudePath =
    params?.enableAgentRuns === true && config.nodeHost?.agentRuns?.claude?.enabled === true
      ? resolveExecutableTrustPathFromEnv("claude", pathEnv)
      : null;
  const skills = config.nodeHost?.skills?.enabled === false ? null : scanNodeHostedSkills();
  const manifest: NodeHostManifest = {
    caps: [...new Set(["system", "mcp", ...pluginNodeHost.caps])].toSorted(),
    commands: [
      ...new Set([
        ...NODE_SYSTEM_RUN_COMMANDS,
        ...NODE_EXEC_APPROVALS_COMMANDS,
        NODE_FS_LIST_DIR_COMMAND,
        NODE_MCP_TOOLS_CALL_COMMAND,
        ...(claudePath ? [NODE_AGENT_CLI_CLAUDE_RUN_COMMAND] : []),
        ...pluginNodeHost.commands,
      ]),
    ].toSorted(),
    pathEnv,
  };
  const initialInventory = createInventory({
    skills,
    pluginTools: pluginNodeHost.nodePluginTools,
  });

  return {
    manifest,
    initialInventory,
    start({ client, onInventoryChanged }) {
      const mcpAbort = new AbortController();
      const skillBins = new SkillBinsCache(client, pathEnv);
      const activeInvokes = new Map<
        string,
        NodeInvokeInputTarget & { controller: AbortController }
      >();
      let manager: NodeHostMcpManager | undefined;
      const startup = startNodeHostMcpManager(config.nodeHost?.mcp?.servers, {
        signal: mcpAbort.signal,
      }).then((resolved) => {
        manager = resolved;
        onInventoryChanged?.(
          createInventory({
            skills,
            pluginTools: pluginNodeHost.nodePluginTools,
            mcpManager: manager,
          }),
        );
        return resolved;
      });
      return {
        async invoke(frame) {
          const duplexCommand = duplexEnabled && isRegisteredNodeHostCommandDuplex(frame.command);
          const controller =
            (claudePath && frame.command === NODE_AGENT_CLI_CLAUDE_RUN_COMMAND) || duplexCommand
              ? new AbortController()
              : undefined;
          const active: (NodeInvokeInputTarget & { controller: AbortController }) | undefined =
            controller
              ? {
                  controller,
                  nextInputSeq: 0,
                  pendingInput: [],
                  pendingInputBytes: 0,
                  inputFailed: false,
                  abort: (reason) => controller.abort(reason),
                }
              : undefined;
          if (active) {
            activeInvokes.set(frame.id, active);
          }
          const progress = duplexCommand
            ? createNodeInvokeProgressWriter({
                client,
                frame,
                idleTimeoutMs: NODE_DUPLEX_INVOKE_IDLE_TIMEOUT_MS,
                onError: () => controller?.abort(),
              })
            : undefined;
          progress?.startHeartbeats();
          const pluginCommandIo: OpenClawPluginNodeHostCommandIo | undefined =
            controller && active && progress
              ? {
                  signal: controller.signal,
                  emitChunk: async (chunk) => await progress.write(chunk),
                  onInput: (callback) => {
                    if (activeInvokes.get(frame.id) === active) {
                      registerNodeInvokeInputHandler(active, callback);
                    }
                  },
                }
              : undefined;
          try {
            await handleInvoke(frame, client, skillBins, manager, {
              ...(claudePath ? { claudePath } : {}),
              ...(controller ? { signal: controller.signal } : {}),
              ...(pluginCommandIo ? { pluginCommandIo } : {}),
            });
          } finally {
            progress?.stop();
            await progress?.flush();
            if (active && activeInvokes.get(frame.id) === active) {
              activeInvokes.delete(frame.id);
            }
          }
        },
        handleInput(invokeId, seq, payloadJSON) {
          const active = activeInvokes.get(invokeId);
          if (!dispatchNodeInvokeInput(active, seq, payloadJSON)) {
            logDebug(`node-host: dropped inactive or duplicate input for invoke ${invokeId}`);
          }
        },
        cancel(invokeId) {
          activeInvokes.get(invokeId)?.controller.abort();
        },
        cancelAll() {
          for (const active of activeInvokes.values()) {
            active.controller.abort();
          }
          activeInvokes.clear();
        },
        async close() {
          this.cancelAll();
          mcpAbort.abort();
          const resolved = manager ?? (await startup.catch(() => undefined));
          await resolved?.close();
        },
      };
    },
  };
}
