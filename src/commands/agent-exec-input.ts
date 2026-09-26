import { createReadStream, existsSync } from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";
import { readByteStreamWithLimit } from "@openclaw/media-core/read-byte-stream-with-limit";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { mergeDeep } from "../infra/deep-merge.js";

const AGENT_EXEC_MESSAGE_MAX_BYTES = 4 * 1024 * 1024;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

export type AgentExecCliOptions = {
  messageFile?: string;
  cwd?: string;
  stateDir?: string;
  config?: string;
  isolated?: boolean;
  model?: string;
  thinking?: string;
  fallback?: string[];
  codeMode?: "direct" | "auto" | "code";
  localModelLean?: boolean;
  authEnvOnly?: boolean;
  timeout?: string;
  json?: boolean;
};

function decodePrompt(bytes: Buffer, source: string): string {
  let value: string;
  try {
    value = UTF8_DECODER.decode(bytes).replace(/^\uFEFF/, "");
  } catch {
    throw new Error(`${source} must be valid UTF-8`);
  }
  if (!value.trim()) {
    throw new Error(`${source} is empty`);
  }
  return value;
}

async function readPromptStream(stream: AsyncIterable<unknown>, source: string): Promise<string> {
  const bytes = await readByteStreamWithLimit(stream, {
    maxBytes: AGENT_EXEC_MESSAGE_MAX_BYTES,
    onOverflow: () => new Error(`${source} exceeds ${String(AGENT_EXEC_MESSAGE_MAX_BYTES)} bytes`),
  });
  return decodePrompt(bytes, source);
}

/** Resolve the one allowed prompt source for `agent exec`. */
export async function resolveAgentExecPrompt(
  positionalMessage: string | undefined,
  messageFile: string | undefined,
  stdin: AsyncIterable<unknown> = process.stdin,
): Promise<string> {
  const file = messageFile?.trim();
  const hasPositional = positionalMessage !== undefined;
  if (hasPositional && file) {
    throw new Error("Use either the prompt argument or --message-file, not both.");
  }
  if (messageFile !== undefined && !file) {
    throw new Error("--message-file must not be empty.");
  }
  if (file) {
    const stream = file === "-" ? stdin : createReadStream(file);
    try {
      return await readPromptStream(stream, file === "-" ? "stdin" : `Message file ${file}`);
    } catch (error) {
      if (file === "-" || !(error instanceof Error) || !("code" in error)) {
        throw error;
      }
      const code = error.code;
      if (code === "ENOENT") {
        throw new Error(`Message file not found: ${file}`, { cause: error });
      }
      throw error;
    }
  }
  if (!positionalMessage?.trim()) {
    throw new Error("Missing prompt. Pass text or use --message-file <path>.");
  }
  return positionalMessage;
}

/**
 * Keep state under exec's lock and bind every agent to the requested folder.
 * Per-agent workspaces outrank defaults; ACP cwd can redirect the native harness.
 * Channel binding cwd needs no adjustment because exec matches no channel.
 */
function pinExecAgentLocations(base: OpenClawConfig, cwd: string): OpenClawConfig {
  const { session, ...root } = base;
  const { store: _store, ...sessionWithoutStore } = session ?? {};
  const withoutSessionStore = session ? { ...root, session: sessionWithoutStore } : base;
  const entries = withoutSessionStore.agents?.entries;
  if (!entries) {
    return withoutSessionStore;
  }
  return {
    ...withoutSessionStore,
    agents: {
      ...withoutSessionStore.agents,
      entries: Object.fromEntries(
        Object.entries(entries).map(([id, entry]) => {
          const { agentDir: _agentDir, runtime, ...rest } = entry;
          if (runtime?.type !== "acp" || runtime.acp?.cwd === undefined) {
            return [id, { ...rest, workspace: cwd, ...(runtime ? { runtime } : {}) }];
          }
          const { cwd: _cwd, ...acp } = runtime.acp;
          return [id, { ...rest, workspace: cwd, runtime: { ...runtime, acp } }];
        }),
      ),
    },
  };
}

/**
 * Coding one-shot defaults. These merge *under* the resolved config so an
 * operator who configured a tool profile, shell env, or sandbox keeps it;
 * notably exec must never downgrade a configured sandbox to `off`.
 */
function buildExecConfigDefaults(): OpenClawConfig {
  return {
    env: { shellEnv: { enabled: false } },
    agents: { defaults: { sandbox: { mode: "off" } } },
    tools: {
      profile: "coding",
      fs: { workspaceOnly: true },
      // No `exec.host`: the default `auto` already resolves to the gateway when
      // no sandbox is configured, and pinning `gateway` here would route
      // commands back onto the host for an inherited config that enables one.
      // `mode: "full"` stays because a headless one-shot has no approval channel.
      exec: { mode: "full" },
    },
  };
}

/**
 * Config is a credential source (provider keys, headers, env and shell imports).
 * Environment-only execution therefore skips it entirely; ordinary exec inherits it.
 */
export async function resolveExecBaseConfig(
  opts: Pick<AgentExecCliOptions, "authEnvOnly" | "config" | "isolated">,
): Promise<OpenClawConfig> {
  if (opts.config && (opts.isolated || opts.authEnvOnly === true)) {
    const conflicting = opts.isolated ? "--isolated" : "--auth-env-only";
    throw new Error(`--config cannot be combined with ${conflicting}.`);
  }
  if (opts.isolated || opts.authEnvOnly === true) {
    // Configless exec still needs the roster that ordinary missing-config migration supplies.
    const { migratePersistedImplicitMainRoster } = await import("../config/legacy.roster.js");
    const { coerceConfig } = await import("../config/io.read-helpers.js");
    return coerceConfig(migratePersistedImplicitMainRoster({}).config);
  }
  const { createConfigIO, getRuntimeConfig } = await import("../config/io.js");
  if (!opts.config) {
    return getRuntimeConfig();
  }
  // A pinned file bypasses the published runtime snapshot and fails if missing or invalid.
  const io = createConfigIO({ configPath: path.resolve(opts.config) });
  if (!existsSync(io.configPath)) {
    throw new Error(`--config file not found: ${io.configPath}`);
  }
  return io.loadConfig();
}

export function buildExecRunConfig(params: {
  base: OpenClawConfig;
  cwd: string;
  opts?: Pick<AgentExecCliOptions, "localModelLean">;
}): OpenClawConfig {
  const opts = params.opts ?? {};
  const base = pinExecAgentLocations(params.base, params.cwd);
  return mergeDeep(mergeDeep(buildExecConfigDefaults(), base), {
    agents: {
      defaults: {
        workspace: params.cwd,
        skipBootstrap: true,
        ...(opts.localModelLean ? { experimental: { localModelLean: true } } : {}),
      },
    },
    // A one-shot process cannot observe invalidation; a watcher would retain it after the turn.
    skills: { load: { watch: false } },
  }) as OpenClawConfig; // SAFETY: Merging three typed configs preserves the OpenClawConfig shape.
}
