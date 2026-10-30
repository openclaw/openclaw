import { createReadStream, existsSync } from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";
import { readByteStreamWithLimit } from "@openclaw/media-core/read-byte-stream-with-limit";
import { readNonBlankString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { mergeDeep } from "../infra/deep-merge.js";
import { isPlainObject } from "../infra/plain-object.js";

const AGENT_EXEC_MESSAGE_MAX_BYTES = 4 * 1024 * 1024;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

export type AgentExecCliOptions = {
  messageFile?: string;
  cwd?: string;
  stateDir?: string;
  config?: string;
  configOverride?: string[];
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

/** Resolve the one allowed prompt source for `agent exec`. */
export async function resolveAgentExecPrompt(
  positionalMessage: string | undefined,
  messageFile: string | undefined,
): Promise<string> {
  const file = readNonBlankString(messageFile);
  if (positionalMessage !== undefined && file) {
    throw new Error("Use either the prompt argument or --message-file, not both.");
  }
  if (messageFile !== undefined && !file) {
    throw new Error("--message-file must not be empty.");
  }
  if (file) {
    const stream = file === "-" ? process.stdin : createReadStream(file);
    try {
      const source = file === "-" ? "stdin" : `Message file ${file}`;
      const bytes = await readByteStreamWithLimit(stream, {
        maxBytes: AGENT_EXEC_MESSAGE_MAX_BYTES,
        onOverflow: () =>
          new Error(`${source} exceeds ${String(AGENT_EXEC_MESSAGE_MAX_BYTES)} bytes`),
      });
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
  opts: Pick<AgentExecCliOptions, "authEnvOnly" | "config" | "configOverride" | "isolated">,
): Promise<OpenClawConfig> {
  if (opts.configOverride?.length && opts.authEnvOnly === true) {
    throw new Error("--config-override cannot be combined with --auth-env-only.");
  }
  if (opts.config && (opts.isolated || opts.authEnvOnly === true)) {
    const conflicting = opts.isolated ? "--isolated" : "--auth-env-only";
    throw new Error(`--config cannot be combined with ${conflicting}.`);
  }
  if (opts.isolated || opts.authEnvOnly === true) {
    const { applyImplicitAgentRosterDefaults } = await import("../config/implicit-agent-roster.js");
    const { coerceConfig } = await import("../config/io.read-helpers.js");
    return coerceConfig(applyImplicitAgentRosterDefaults({}));
  }
  const { createConfigIO, captureRuntimeConfigAsyncReader } = await import("../config/io.js");
  if (!opts.config) {
    return await captureRuntimeConfigAsyncReader()();
  }
  // A pinned file bypasses the published runtime snapshot and fails if missing or invalid.
  const io = createConfigIO({ configPath: path.resolve(opts.config) });
  if (!existsSync(io.configPath)) {
    throw new Error(`--config file not found: ${io.configPath}`);
  }
  return await io.loadConfigAsync();
}

/** Overlay the selected config before resolving the run's agent and credential owner. */
export async function applyExecConfigOverrides(
  base: OpenClawConfig,
  overrides: string[] = [],
): Promise<OpenClawConfig> {
  if (overrides.length === 0) {
    return base;
  }
  const parsed = overrides.map((value) => {
    let override: unknown;
    try {
      override = JSON.parse(value);
    } catch {
      // Parser diagnostics can echo credential-bearing input.
      throw new Error("--config-override must contain valid JSON.");
    }
    if (!isPlainObject(override)) {
      throw new Error("--config-override must be a JSON object.");
    }
    return override;
  });
  const merged = parsed.reduce<unknown>((config, override) => mergeDeep(config, override), base);
  const { validateConfigObjectWithPlugins } = await import("../config/validation.js");
  const result = validateConfigObjectWithPlugins(merged);
  if (!result.ok) {
    throw new Error(
      `Invalid --config-override: ${result.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`,
    );
  }
  return result.config;
}

export function buildExecRunConfig(params: {
  base: OpenClawConfig;
  cwd: string;
  opts?: Pick<AgentExecCliOptions, "localModelLean">;
}): OpenClawConfig {
  const opts = params.opts ?? {};
  // Keep state under exec's lock and bind every agent to the requested folder.
  // Per-agent workspaces outrank defaults; ACP cwd can redirect the native harness.
  // Channel binding cwd needs no adjustment because exec matches no channel.
  const { base: inheritedBase, cwd } = params;
  const { session, ...root } = inheritedBase;
  const { store: _store, ...sessionWithoutStore } = session ?? {};
  const withoutSessionStore = session ? { ...root, session: sessionWithoutStore } : inheritedBase;
  const entries = withoutSessionStore.agents?.entries;
  const base: OpenClawConfig = entries
    ? {
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
      }
    : withoutSessionStore;
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
