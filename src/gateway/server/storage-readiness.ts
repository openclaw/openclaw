// Gateway storage readiness probes critical writable roots used by state/workspace flows.
import { randomUUID } from "node:crypto";
import fs, { existsSync } from "node:fs";
import path from "node:path";
import {
  listAgentIds,
  resolveAgentConfig,
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../../agents/agent-scope-config.js";
import { resolveStateDir } from "../../config/paths.js";
import { resolveStorePath } from "../../config/sessions/paths.js";
import { listConfiguredSessionStoreAgentIds } from "../../config/sessions/targets.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveOpenClawStateSqliteDir } from "../../state/openclaw-state-db.paths.js";

export const STORAGE_READINESS_FAILURE = "workspace-storage-unwritable";

export type StorageReadinessResult = {
  ready: boolean;
  failing: string[];
};

export type StorageReadinessChecker = () => StorageReadinessResult;

export type RefreshableStorageReadinessChecker = StorageReadinessChecker & {
  refresh: () => Promise<StorageReadinessResult>;
};

export type WritableProbeFileHandle = {
  close: () => Promise<void>;
  sync: () => Promise<void>;
  writeFile: (data: string) => Promise<void>;
};

export type WritableProbeFs = {
  mkdir: (root: string, options: { recursive: true }) => Promise<unknown>;
  open: (path: string, flags: "wx", mode: number) => Promise<WritableProbeFileHandle>;
  unlink: (path: string) => Promise<void>;
};

type ResolveGatewayStorageReadinessRootsOptions = {
  config: OpenClawConfig;
  stateDir?: string;
  env?: NodeJS.ProcessEnv;
  workspaceExists?: (workspaceDir: string) => boolean;
};

const DEFAULT_STORAGE_READINESS_CACHE_TTL_MS = 1_000;
const DEFAULT_STORAGE_READINESS_PROBE_TIMEOUT_MS = 2_000;
const DEFAULT_STORAGE_READINESS_TIMEOUT_RETRY_MS = 10_000;
const MAX_ABANDONED_TIMED_OUT_PROBES = 1;
const DEFAULT_PROBE_FILE_NAME = ".openclaw-readyz-write-probe";
const PROBE_PAYLOAD = "openclaw-readyz\n";

function shouldProbeAgentWorkspaceDir(params: {
  config: OpenClawConfig;
  agentId: string;
  env: NodeJS.ProcessEnv;
  workspaceDir: string;
  workspaceExists: (workspaceDir: string) => boolean;
}): boolean {
  const configuredWorkspace = resolveAgentConfig(params.config, params.agentId)?.workspace?.trim();
  if (configuredWorkspace) {
    return true;
  }
  if (params.config.agents?.defaults?.workspace?.trim()) {
    return true;
  }
  if (params.env.OPENCLAW_WORKSPACE_DIR?.trim()) {
    return true;
  }
  if (params.agentId !== resolveDefaultAgentId(params.config)) {
    return true;
  }
  return params.workspaceExists(params.workspaceDir);
}

function resolveWorkspaceCreationProbeRoot(
  workspaceDir: string,
  workspaceExists: (workspaceDir: string) => boolean,
): string | undefined {
  let candidate = path.dirname(workspaceDir);
  while (candidate && candidate !== path.dirname(candidate)) {
    if (workspaceExists(candidate)) {
      return candidate;
    }
    candidate = path.dirname(candidate);
  }
  return workspaceExists(candidate) ? candidate : undefined;
}

export function resolveGatewayStorageReadinessRoots(
  options: ResolveGatewayStorageReadinessRootsOptions,
): string[] {
  const env = options.env ?? process.env;
  const stateDir = options.stateDir ?? resolveStateDir(env);
  const pinnedStateEnv: NodeJS.ProcessEnv = { ...env, OPENCLAW_STATE_DIR: stateDir };
  const workspaceExists = options.workspaceExists ?? existsSync;
  const roots = [stateDir, resolveOpenClawStateSqliteDir(pinnedStateEnv)];

  for (const agentId of listAgentIds(options.config)) {
    roots.push(resolveAgentDir(options.config, agentId, pinnedStateEnv));
    const workspaceDir = resolveAgentWorkspaceDir(options.config, agentId, pinnedStateEnv);
    if (
      shouldProbeAgentWorkspaceDir({
        config: options.config,
        agentId,
        env: pinnedStateEnv,
        workspaceDir,
        workspaceExists,
      })
    ) {
      roots.push(workspaceDir);
    } else {
      const creationProbeRoot = resolveWorkspaceCreationProbeRoot(workspaceDir, workspaceExists);
      if (creationProbeRoot) {
        roots.push(creationProbeRoot);
      }
    }
  }

  for (const agentId of listConfiguredSessionStoreAgentIds(options.config)) {
    roots.push(
      path.dirname(
        resolveStorePath(options.config.session?.store, { agentId, env: pinnedStateEnv }),
      ),
    );
  }

  return roots;
}

/** Create a cached async write probe for critical Gateway storage roots. */
export function createStorageReadinessChecker(deps: {
  getWritableRoots: () => readonly string[];
  cacheTtlMs?: number;
  fs?: WritableProbeFs;
  now?: () => number;
  probeFileName?: string;
  createProbeFileName?: () => string;
  probeTimeoutMs?: number;
  timeoutRetryMs?: number;
  autoStart?: boolean;
}): RefreshableStorageReadinessChecker {
  const fsImpl = deps.fs ?? fs.promises;
  const now = deps.now ?? Date.now;
  const probeFileName = deps.probeFileName ?? DEFAULT_PROBE_FILE_NAME;
  const createProbeFileName =
    deps.createProbeFileName ?? (() => `${probeFileName}.${process.pid}.${randomUUID()}`);
  const cacheTtlMs = Math.max(0, deps.cacheTtlMs ?? DEFAULT_STORAGE_READINESS_CACHE_TTL_MS);
  const probeTimeoutMs = Math.max(
    1,
    deps.probeTimeoutMs ?? DEFAULT_STORAGE_READINESS_PROBE_TIMEOUT_MS,
  );
  const timeoutRetryMs = Math.max(
    1,
    deps.timeoutRetryMs ?? DEFAULT_STORAGE_READINESS_TIMEOUT_RETRY_MS,
  );
  let nextRefreshAt = Number.NEGATIVE_INFINITY;
  let cachedState: StorageReadinessResult = {
    ready: false,
    failing: [STORAGE_READINESS_FAILURE],
  };
  let refreshGeneration = 0;
  let abandonedTimedOutProbes = 0;
  let refreshInFlight: {
    abandon: () => void;
    bounded: Promise<StorageReadinessResult>;
    generation: number;
    timedOut: boolean;
  } | null = null;

  const maybeAbandonTimedOutProbe = () => {
    if (!refreshInFlight?.timedOut || abandonedTimedOutProbes >= MAX_ABANDONED_TIMED_OUT_PROBES) {
      return;
    }
    refreshInFlight.abandon();
  };

  const applyProbeResult = (generation: number, ready: boolean) => {
    if (generation !== refreshGeneration) {
      return;
    }
    const checkedAt = now();
    nextRefreshAt = checkedAt + cacheTtlMs;
    cachedState = ready
      ? { ready: true, failing: [] }
      : { ready: false, failing: [STORAGE_READINESS_FAILURE] };
  };

  const refresh = async (): Promise<StorageReadinessResult> => {
    if (refreshInFlight) {
      return await refreshInFlight.bounded;
    }

    const generation = ++refreshGeneration;
    let abandoned = false;
    const abandon = () => {
      if (abandoned) {
        return;
      }
      abandoned = true;
      abandonedTimedOutProbes += 1;
      if (refreshInFlight?.generation === generation) {
        refreshInFlight = null;
      }
    };
    const probeTask = (async () => {
      const ready = await probeWritableRoots({
        getWritableRoots: deps.getWritableRoots,
        createProbeFileName,
        fs: fsImpl,
      });
      applyProbeResult(generation, ready);
    })();

    const bounded = withProbeTimeout({
      probeTask,
      timeoutMs: probeTimeoutMs,
      onTimeout: () => {
        if (generation !== refreshGeneration) {
          return;
        }
        refreshGeneration += 1;
        nextRefreshAt = now() + timeoutRetryMs;
        cachedState = { ready: false, failing: [STORAGE_READINESS_FAILURE] };
        if (refreshInFlight?.generation === generation) {
          refreshInFlight.timedOut = true;
          maybeAbandonTimedOutProbe();
        }
      },
      getCachedState: () => cachedState,
    });
    refreshInFlight = { abandon, bounded, generation, timedOut: false };
    void probeTask.finally(() => {
      if (abandoned) {
        abandonedTimedOutProbes -= 1;
      }
      if (refreshInFlight?.generation === generation) {
        refreshInFlight = null;
      }
      maybeAbandonTimedOutProbe();
    });

    return await bounded;
  };

  const checker = (() => {
    const checkedAt = now();
    if (checkedAt >= nextRefreshAt && !refreshInFlight) {
      void refresh();
    }
    return cachedState;
  }) as RefreshableStorageReadinessChecker;
  checker.refresh = refresh;

  if (deps.autoStart !== false) {
    void refresh();
  }

  return checker;
}

async function probeWritableRoots(params: {
  getWritableRoots: () => readonly string[];
  createProbeFileName: () => string;
  fs: WritableProbeFs;
}): Promise<boolean> {
  let roots: string[];
  try {
    roots = getDistinctWritableRoots(params.getWritableRoots);
  } catch {
    return false;
  }

  const results = await Promise.all(
    roots.map(
      async (root) => await probeWritableRoot(root, params.createProbeFileName(), params.fs),
    ),
  );
  return results.every(Boolean);
}

async function withProbeTimeout(params: {
  probeTask: Promise<void>;
  timeoutMs: number;
  onTimeout: () => void;
  getCachedState: () => StorageReadinessResult;
}): Promise<StorageReadinessResult> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutTask = new Promise<StorageReadinessResult>((resolve) => {
    timeoutHandle = setTimeout(() => {
      params.onTimeout();
      resolve(params.getCachedState());
    }, params.timeoutMs);
    timeoutHandle.unref?.();
  });

  try {
    return await Promise.race([params.probeTask.then(() => params.getCachedState()), timeoutTask]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

function getDistinctWritableRoots(getWritableRoots: () => readonly string[]): string[] {
  const roots = getWritableRoots();
  const seen = new Set<string>();
  const distinct: string[] = [];
  for (const root of roots) {
    const trimmed = root.trim();
    if (!trimmed) {
      continue;
    }
    const resolved = path.resolve(trimmed);
    if (seen.has(resolved)) {
      continue;
    }
    seen.add(resolved);
    distinct.push(resolved);
  }
  return distinct;
}

async function probeWritableRoot(
  root: string,
  probeFileName: string,
  fsImpl: WritableProbeFs,
): Promise<boolean> {
  const probePath = path.join(root, probeFileName);
  let handle: WritableProbeFileHandle | undefined;
  let failed = false;
  let createdProbeFile = false;

  try {
    await fsImpl.mkdir(root, { recursive: true });
    handle = await fsImpl.open(probePath, "wx", 0o600);
    createdProbeFile = true;
    await handle.writeFile(PROBE_PAYLOAD);
    await handle.sync();
  } catch {
    failed = true;
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch {
        failed = true;
      }
    }
    if (createdProbeFile) {
      try {
        await fsImpl.unlink(probePath);
      } catch (err) {
        if (!isMissingFileError(err)) {
          failed = true;
        }
      }
    }
  }

  return !failed;
}

function isMissingFileError(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT";
}
