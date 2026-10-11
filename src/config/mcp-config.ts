import { expectDefined, stableStringify } from "@openclaw/normalization-core";
import { markClawMcpServerIndependentlyOwned } from "../state/claw-mcp-adoption.js";
import { isRecord } from "../utils.js";
import {
  readSourceConfigSnapshot,
  readSourceConfigSnapshotForWrite,
  type ConfigWriteOptions,
} from "./io.js";
import {
  canonicalizeConfiguredMcpServer,
  normalizeConfiguredMcpServers,
} from "./mcp-config-normalize.js";
import { replaceConfigFile } from "./mutate.js";
import { redactSensitiveArgv } from "./redact-argv.js";
import { REDACTED_SENTINEL, restoreRedactedValues } from "./redact-snapshot.js";
import { buildConfigSchemaCore } from "./schema.js";
import type { McpServerToolFilterConfig } from "./types.mcp.js";
import type { OpenClawConfig } from "./types.openclaw.js";
import { validateConfigObjectWithPlugins } from "./validation.js";

type ConfigMcpServers = ReturnType<typeof normalizeConfiguredMcpServers>;

type McpArgvRestoreResult =
  | { ok: true; server: Record<string, unknown> }
  | { ok: false; error: string };

type ConfigMcpSuccess = {
  path: string;
  config: OpenClawConfig;
  mcpServers: ConfigMcpServers;
};
type ConfigMcpReadSuccess = ConfigMcpSuccess & {
  runtimeConfig: Awaited<ReturnType<typeof readSourceConfigSnapshot>>["runtimeConfig"];
  sourceConfigBeforeMigrations?: Awaited<
    ReturnType<typeof readSourceConfigSnapshot>
  >["sourceConfigBeforeMigrations"];
};
type ConfigMcpFailure = { ok: false; path: string; error: string };
type ConfigMcpReadResult =
  | (ConfigMcpReadSuccess & { ok: true; baseHash?: string })
  | ConfigMcpFailure;
type ConfigMcpWriteResult =
  | (ConfigMcpSuccess & { ok: true; removed?: boolean; updated?: boolean })
  | ConfigMcpFailure;

type LoadedConfigMcpServers = Extract<ConfigMcpReadResult, { ok: true }>;
type McpConfigMutation = {
  name: string;
  previous?: Record<string, unknown>;
  next?: Record<string, unknown>;
};
type McpConfigMutationHook = (mutation: McpConfigMutation) => Promise<void>;

function normalizeToolSelectionList(value: readonly string[] | undefined): string[] | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = Array.from(
    new Set(value.map((entry) => entry.trim()).filter((entry) => entry.length > 0)),
  ).toSorted((a, b) => a.localeCompare(b));
  return normalized.length > 0 ? normalized : undefined;
}

function restoreMcpServerArgvSentinels(params: {
  incoming: Record<string, unknown>;
  original: Record<string, unknown> | undefined;
}): McpArgvRestoreResult {
  const incomingArgs = params.incoming.args;
  if (!Array.isArray(incomingArgs)) {
    return { ok: true, server: params.incoming };
  }
  const hasSentinel = incomingArgs.some(
    (arg) => typeof arg === "string" && arg.includes(REDACTED_SENTINEL),
  );
  if (!hasSentinel) {
    return { ok: true, server: params.incoming };
  }

  const originalArgs = params.original?.args;
  if (
    !Array.isArray(originalArgs) ||
    !originalArgs.every((arg) => typeof arg === "string") ||
    incomingArgs.length !== originalArgs.length
  ) {
    return {
      ok: false,
      error: `Cannot restore MCP args containing "${REDACTED_SENTINEL}" without the same original argv shape.`,
    };
  }

  const displayedArgs = redactSensitiveArgv(originalArgs, REDACTED_SENTINEL);
  if (incomingArgs.some((arg, index) => arg !== displayedArgs[index])) {
    return {
      ok: false,
      error: `Cannot restore MCP args containing "${REDACTED_SENTINEL}" after argv changed. Replace every redacted value explicitly before editing args.`,
    };
  }
  return {
    ok: true,
    server: {
      ...params.incoming,
      args: originalArgs,
    },
  };
}

function resolveConfiguredMcpServers(
  snapshot: Awaited<ReturnType<typeof readSourceConfigSnapshot>>,
): ConfigMcpReadResult {
  if (!snapshot.valid) {
    return {
      ok: false,
      path: snapshot.path,
      error: "Config file is invalid; fix it before using MCP config commands.",
    };
  }
  const sourceConfig = snapshot.sourceConfig;
  return {
    ok: true,
    path: snapshot.path,
    config: structuredClone(sourceConfig),
    mcpServers: normalizeConfiguredMcpServers(sourceConfig.mcp?.servers),
    runtimeConfig: snapshot.runtimeConfig,
    ...(snapshot.sourceConfigBeforeMigrations
      ? { sourceConfigBeforeMigrations: snapshot.sourceConfigBeforeMigrations }
      : {}),
    baseHash: snapshot.hash,
  };
}

export async function listConfiguredMcpServers(): Promise<ConfigMcpReadResult> {
  return resolveConfiguredMcpServers(await readSourceConfigSnapshot());
}

async function commitConfiguredMcpServers(params: {
  loaded: LoadedConfigMcpServers;
  writeOptions: ConfigWriteOptions;
  servers: ConfigMcpServers;
  errorLabel: string;
  success?: { removed?: boolean; updated?: boolean };
  independentlyOwnedName?: string;
  assertCurrent?: () => void;
  assertCurrentAsync?: () => Promise<void>;
  mutation?: { name: string; onCommitted?: McpConfigMutationHook };
}): Promise<ConfigMcpWriteResult> {
  const next = structuredClone(params.loaded.config);
  if (Object.keys(params.servers).length > 0) {
    next.mcp = { ...next.mcp, servers: params.servers };
  } else if (next.mcp) {
    delete next.mcp.servers;
    if (Object.keys(next.mcp).length === 0) {
      delete next.mcp;
    }
  }

  const validated = validateConfigObjectWithPlugins(next);
  if (!validated.ok) {
    const issue = expectDefined(validated.issues[0], "issues entry at 0");
    return {
      ok: false,
      path: params.loaded.path,
      error: `Config invalid after MCP ${params.errorLabel} (${issue.path}: ${issue.message}).`,
    };
  }
  // Validation materializes runtime defaults; persist only the source candidate.
  const committed = await replaceConfigFile({
    sourceConfig: next,
    baseHash: params.loaded.baseHash,
    writeOptions: {
      ...params.writeOptions,
      assertCurrent: () => {
        params.writeOptions.assertCurrent?.();
        params.assertCurrent?.();
      },
      beforeCommit: async () => {
        await params.writeOptions.beforeCommit?.();
        await params.assertCurrentAsync?.();
      },
    },
  });
  if (params.mutation?.onCommitted) {
    const previous = params.loaded.mcpServers[params.mutation.name];
    const nextServer = params.servers[params.mutation.name];
    await params.mutation.onCommitted({
      name: params.mutation.name,
      ...(previous ? { previous } : {}),
      ...(nextServer ? { next: nextServer } : {}),
    });
  }
  if (params.independentlyOwnedName) {
    markClawMcpServerIndependentlyOwned(params.independentlyOwnedName);
  }
  return {
    ok: true,
    path: params.loaded.path,
    config: committed.nextConfig,
    mcpServers: params.servers,
    ...params.success,
  };
}

type McpServerMutationRequest =
  | ({ kind: "set"; server: Record<string, unknown> } & Omit<
      Parameters<typeof setConfiguredMcpServer>[0],
      "server"
    >)
  | ({ kind: "unset" } & Parameters<typeof unsetConfiguredMcpServer>[0])
  | ({ kind: "update" } & Parameters<typeof updateConfiguredMcpServerConfig>[0]);

async function mutateConfiguredMcpServer(
  params: McpServerMutationRequest,
  onCommitted?: McpConfigMutationHook,
): Promise<ConfigMcpWriteResult> {
  const name = params.name.trim();
  if (!name) {
    return { ok: false, path: "", error: "MCP server name is required." };
  }
  const { snapshot, writeOptions } = await readSourceConfigSnapshotForWrite();
  const loaded = resolveConfiguredMcpServers(snapshot);
  if (!loaded.ok) {
    return loaded;
  }
  const exists = Object.hasOwn(loaded.mcpServers, name);
  const successKey = params.kind === "unset" ? "removed" : "updated";
  if (params.kind !== "set" && !exists) {
    const { baseHash: _baseHash, ...unchanged } = loaded;
    return { ...unchanged, [successKey]: false };
  }
  if (params.kind === "set" && params.createOnly && exists) {
    return {
      ok: false,
      path: loaded.path,
      error: `MCP server ${JSON.stringify(name)} already exists.`,
    };
  }
  const existingServer = loaded.mcpServers[name];
  if (
    params.kind !== "update" &&
    params.expectedServer &&
    ((params.kind === "set" && (!exists || !existingServer)) ||
      (existingServer &&
        stableStringify(canonicalizeConfiguredMcpServer(existingServer)) !==
          stableStringify(canonicalizeConfiguredMcpServer(params.expectedServer))))
  ) {
    return {
      ok: false,
      path: loaded.path,
      error: `MCP server ${JSON.stringify(name)} changed and was not ${successKey}.`,
    };
  }

  const servers = structuredClone(loaded.mcpServers);
  if (params.kind === "set") {
    const argvRestored = restoreMcpServerArgvSentinels({
      incoming: params.server,
      original: existingServer,
    });
    if (!argvRestored.ok) {
      return { ok: false, path: loaded.path, error: argvRestored.error };
    }
    // Restore display placeholders before canonicalization so show -> set retains credentials.
    const restored = restoreRedactedValues(
      { mcp: { servers: { [name]: argvRestored.server } } },
      { mcp: { servers: loaded.mcpServers } },
      buildConfigSchemaCore().uiHints,
    );
    if (!restored.ok) {
      return {
        ok: false,
        path: loaded.path,
        error:
          restored.humanReadableMessage ??
          "MCP server config contains an unrestorable redacted value.",
      };
    }
    const restoredServer = (restored.result as { mcp?: { servers?: Record<string, unknown> } }).mcp
      ?.servers?.[name];
    if (!isRecord(restoredServer)) {
      return { ok: false, path: loaded.path, error: "MCP server config must be a JSON object." };
    }
    servers[name] = canonicalizeConfiguredMcpServer(restoredServer);
  } else if (params.kind === "unset") {
    delete servers[name];
  } else {
    servers[name] = params.update({ ...servers[name] });
  }
  return commitConfiguredMcpServers({
    loaded,
    writeOptions,
    servers,
    errorLabel: params.kind === "update" ? params.errorLabel : params.kind,
    success: params.kind === "set" ? undefined : { [successKey]: true },
    independentlyOwnedName:
      params.kind === "unset" || params.recordIndependentOwner === false ? undefined : name,
    assertCurrent: params.kind === "update" ? undefined : params.assertCurrent,
    assertCurrentAsync: params.kind === "unset" ? params.assertCurrentAsync : undefined,
    mutation: { name, onCommitted },
  });
}

async function updateConfiguredMcpServerConfig(params: {
  name: string;
  update: (server: Record<string, unknown>) => Record<string, unknown>;
  errorLabel: string;
  recordIndependentOwner?: boolean;
  onCommitted?: McpConfigMutationHook;
}): Promise<ConfigMcpWriteResult> {
  return mutateConfiguredMcpServer({ ...params, kind: "update" }, params.onCommitted);
}

async function updateConfiguredMcpServerTools(
  params: {
    name: string;
    tools: McpServerToolFilterConfig | null;
    recordIndependentOwner?: boolean;
  },
  onCommitted?: McpConfigMutationHook,
): Promise<ConfigMcpWriteResult> {
  return updateConfiguredMcpServerConfig({
    name: params.name,
    recordIndependentOwner: params.recordIndependentOwner,
    errorLabel: "tool selection update",
    onCommitted,
    update: (server) => {
      if (params.tools === null) {
        delete server.toolFilter;
      } else {
        const include = normalizeToolSelectionList(params.tools.include);
        const exclude = normalizeToolSelectionList(params.tools.exclude);
        if (include || exclude) {
          server.toolFilter = {
            ...(isRecord(server.toolFilter) ? server.toolFilter : {}),
            ...(include ? { include } : {}),
            ...(exclude ? { exclude } : {}),
          };
        } else {
          delete server.toolFilter;
        }
      }
      return server;
    },
  });
}

async function updateConfiguredMcpServer(
  params: {
    name: string;
    update: (server: Record<string, unknown>) => Record<string, unknown>;
    recordIndependentOwner?: boolean;
  },
  onCommitted?: McpConfigMutationHook,
): Promise<ConfigMcpWriteResult> {
  return updateConfiguredMcpServerConfig({
    name: params.name,
    recordIndependentOwner: params.recordIndependentOwner,
    errorLabel: "configure",
    onCommitted,
    update: (server) => canonicalizeConfiguredMcpServer(params.update(server)),
  });
}

async function setConfiguredMcpServer(
  params: {
    name: string;
    server: unknown;
    createOnly?: boolean;
    recordIndependentOwner?: boolean;
    expectedServer?: Record<string, unknown>;
    assertCurrent?: () => void;
  },
  onCommitted?: McpConfigMutationHook,
): Promise<ConfigMcpWriteResult> {
  const name = params.name.trim();
  if (!name) {
    return { ok: false, path: "", error: "MCP server name is required." };
  }
  if (!isRecord(params.server)) {
    return { ok: false, path: "", error: "MCP server config must be a JSON object." };
  }
  return mutateConfiguredMcpServer({ ...params, kind: "set", server: params.server }, onCommitted);
}

async function unsetConfiguredMcpServer(
  params: {
    name: string;
    expectedServer?: Record<string, unknown>;
    assertCurrent?: () => void;
    assertCurrentAsync?: () => Promise<void>;
  },
  onCommitted?: McpConfigMutationHook,
): Promise<ConfigMcpWriteResult> {
  return mutateConfiguredMcpServer({ ...params, kind: "unset" }, onCommitted);
}

/** Low-level config writers; production mutations must use the agents-owned lifecycle facade. */
export const mcpConfigInternal = {
  set: setConfiguredMcpServer,
  unset: unsetConfiguredMcpServer,
  update: updateConfiguredMcpServer,
  updateTools: updateConfiguredMcpServerTools,
};
