import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { findOverlappingWorkspaceAgentIds } from "../../agents/agent-delete-safety.js";
import {
  listAgentIds,
  resolveAgentDir,
  resolveAgentWorkspaceDir,
} from "../../agents/agent-scope.js";
import { mergeIdentityMarkdownContent } from "../../agents/identity-file.js";
import { resolveAgentIdentity } from "../../agents/identity.js";
import {
  DEFAULT_AGENTS_FILENAME,
  DEFAULT_BOOTSTRAP_FILENAME,
  DEFAULT_HEARTBEAT_FILENAME,
  DEFAULT_IDENTITY_FILENAME,
  DEFAULT_MEMORY_FILENAME,
  DEFAULT_SOUL_FILENAME,
  DEFAULT_TOOLS_FILENAME,
  DEFAULT_USER_FILENAME,
  ensureAgentWorkspace,
  isWorkspaceSetupCompleted,
} from "../../agents/workspace.js";
import {
  applyAgentConfig,
  findAgentEntryIndex,
  listAgentEntries,
  pruneAgentConfig,
} from "../../commands/agents.config.js";
import { replaceConfigFile } from "../../config/config.js";
import {
  purgeAgentSessionStoreEntries,
  resolveSessionTranscriptsDirForAgent,
} from "../../config/sessions.js";
import type { IdentityConfig } from "../../config/types.base.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { sameFileIdentity } from "../../infra/file-identity.js";
import {
  FsSafeError,
  openFileWithinRoot,
  readFileWithinRoot,
  SafeOpenError,
  writeFileWithinRoot,
} from "../../infra/fs-safe.js";
import { movePathToTrash } from "../../plugin-sdk/browser-maintenance.js";
import { DEFAULT_AGENT_ID, normalizeAgentId } from "../../routing/session-key.js";
import { resolveUserPath } from "../../utils.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateAgentsCreateParams,
  validateAgentsDeleteParams,
  validateAgentsFilesGetParams,
  validateAgentsFilesListParams,
  validateAgentsFilesSetParams,
  validateAgentsListParams,
  validateAgentsRuntimeStatusParams,
  validateAgentsUpdateParams,
} from "../protocol/index.js";
import { listAgentsForGateway } from "../session-utils.js";
import type { GatewayRequestHandlers, RespondFn } from "./types.js";

const BOOTSTRAP_FILE_NAMES = [
  DEFAULT_AGENTS_FILENAME,
  DEFAULT_SOUL_FILENAME,
  DEFAULT_TOOLS_FILENAME,
  DEFAULT_IDENTITY_FILENAME,
  DEFAULT_USER_FILENAME,
  DEFAULT_HEARTBEAT_FILENAME,
  DEFAULT_BOOTSTRAP_FILENAME,
] as const;
const BOOTSTRAP_FILE_NAMES_POST_ONBOARDING = BOOTSTRAP_FILE_NAMES.filter(
  (name) => name !== DEFAULT_BOOTSTRAP_FILENAME,
);

type RuntimeExecFileFn = (
  file: string,
  args?: readonly string[],
  options?: { timeout?: number; maxBuffer?: number },
) => Promise<{ stdout: string | Buffer; stderr: string | Buffer }>;

type TestRootAdapter = (rootDir: string) => Promise<{
  open: (
    relativePath: string,
    options?: Record<string, unknown>,
  ) => ReturnType<typeof openFileWithinRoot>;
  read: (
    relativePath: string,
    options?: Record<string, unknown>,
  ) => ReturnType<typeof readFileWithinRoot>;
  stat: (relativePath: string) => Promise<unknown>;
  write: (
    relativePath: string,
    data: string | Buffer,
    options?: Record<string, unknown>,
  ) => Promise<unknown>;
}>;

const execFileAsync = promisify(execFile) as RuntimeExecFileFn;

const agentsHandlerDeps = {
  isWorkspaceSetupCompleted,
  openFileWithinRoot,
  readFileWithinRoot,
  writeFileWithinRoot,
  fetchFn: fetch,
  execFileFn: execFileAsync,
  statWorkspaceFile: statWorkspaceFileSafely,
};

export const __testing = {
  setDepsForTests(
    overrides: Partial<{
      isWorkspaceSetupCompleted: typeof isWorkspaceSetupCompleted;
      openFileWithinRoot: typeof openFileWithinRoot;
      readFileWithinRoot: typeof readFileWithinRoot;
      writeFileWithinRoot: typeof writeFileWithinRoot;
      fetchFn: typeof fetch;
      execFileFn: RuntimeExecFileFn;
      statWorkspaceFile: typeof statWorkspaceFileSafely;
      root: TestRootAdapter;
    }>,
  ) {
    const { root, ...directOverrides } = overrides;
    Object.assign(agentsHandlerDeps, directOverrides);
    if (root) {
      agentsHandlerDeps.openFileWithinRoot = async ({ rootDir, relativePath, ...options }) => {
        const rootHandle = await root(rootDir);
        return await rootHandle.open(relativePath, options);
      };
      agentsHandlerDeps.readFileWithinRoot = async ({ rootDir, relativePath, ...options }) => {
        const rootHandle = await root(rootDir);
        return await rootHandle.read(relativePath, options);
      };
      agentsHandlerDeps.writeFileWithinRoot = async ({
        rootDir,
        relativePath,
        data,
        ...options
      }) => {
        const rootHandle = await root(rootDir);
        await rootHandle.write(relativePath, data, options);
      };
      agentsHandlerDeps.statWorkspaceFile = async (_workspaceDir, relativePath) => {
        const rootHandle = await root(_workspaceDir);
        let stat: unknown;
        try {
          stat = await rootHandle.stat(relativePath);
        } catch (err) {
          if (
            (err instanceof SafeOpenError && err.code === "not-found") ||
            (err as NodeJS.ErrnoException | undefined)?.code === "ENOENT"
          ) {
            return null;
          }
          throw err;
        }
        const isFile =
          typeof (stat as { isFile?: unknown }).isFile === "function"
            ? (stat as { isFile: () => boolean }).isFile()
            : (stat as { isFile?: unknown }).isFile === true;
        const isSymbolicLink =
          typeof (stat as { isSymbolicLink?: unknown }).isSymbolicLink === "function"
            ? (stat as { isSymbolicLink: () => boolean }).isSymbolicLink()
            : (stat as { isSymbolicLink?: unknown }).isSymbolicLink === true;
        if (!isFile || isSymbolicLink || ((stat as { nlink?: number }).nlink ?? 1) > 1) {
          return null;
        }
        return {
          size: (stat as { size?: number }).size ?? 0,
          updatedAtMs: Math.floor((stat as { mtimeMs?: number }).mtimeMs ?? 0),
        };
      };
    }
  },
  resetDepsForTests() {
    agentsHandlerDeps.isWorkspaceSetupCompleted = isWorkspaceSetupCompleted;
    agentsHandlerDeps.openFileWithinRoot = openFileWithinRoot;
    agentsHandlerDeps.readFileWithinRoot = readFileWithinRoot;
    agentsHandlerDeps.writeFileWithinRoot = writeFileWithinRoot;
    agentsHandlerDeps.fetchFn = fetch;
    agentsHandlerDeps.execFileFn = execFileAsync;
    agentsHandlerDeps.statWorkspaceFile = statWorkspaceFileSafely;
  },
};

type OllamaPsModel = {
  name?: unknown;
  model?: unknown;
  size?: unknown;
  size_vram?: unknown;
  context_length?: unknown;
  processor?: unknown;
  expires_at?: unknown;
  details?: {
    parameter_size?: unknown;
    quantization_level?: unknown;
  };
};

type OllamaPsResponse = {
  models?: unknown;
};

const OLLAMA_PS_URL = "http://127.0.0.1:11434/api/ps";
const OLLAMA_TAGS_URL = "http://127.0.0.1:11434/api/tags";
const OLLAMA_STATUS_TIMEOUT_MS = 1_500;
const HIGH_LOCAL_MODEL_BYTES = 32 * 1024 ** 3;
const LARGE_CONTEXT_THRESHOLD = 65_536;
const KIB = 1024;
const TOP_PROCESS_LIMIT = 8;
const MACOS_VM_STAT_TIMEOUT_MS = 1_500;

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

async function fetchOllamaRunningModels(): Promise<{
  available: boolean;
  error?: string;
  models: Array<{
    provider: "ollama";
    name: string;
    model: string;
    sizeBytes: number;
    sizeVramBytes?: number;
    contextLength?: number;
    processor?: string;
    expiresAt?: string;
    parameterSize?: string;
    quantization?: string;
  }>;
}> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OLLAMA_STATUS_TIMEOUT_MS);
  timeout.unref?.();
  try {
    const res = await agentsHandlerDeps.fetchFn(OLLAMA_PS_URL, { signal: controller.signal });
    if (!res.ok) {
      return { available: false, error: `Ollama status returned HTTP ${res.status}`, models: [] };
    }
    const body = (await res.json()) as OllamaPsResponse;
    const rawModels = Array.isArray(body.models) ? body.models : [];
    const models = rawModels.flatMap((raw) => {
      const entry = raw as OllamaPsModel;
      const name = readString(entry.name) ?? readString(entry.model);
      const model = readString(entry.model) ?? name;
      const sizeBytes = readNonNegativeInteger(entry.size);
      if (!name || !model || sizeBytes === undefined) {
        return [];
      }
      const contextLength = readNonNegativeInteger(entry.context_length);
      return [
        {
          provider: "ollama" as const,
          name,
          model,
          sizeBytes,
          sizeVramBytes: readNonNegativeInteger(entry.size_vram),
          contextLength: contextLength && contextLength > 0 ? contextLength : undefined,
          processor: readString(entry.processor),
          expiresAt: readString(entry.expires_at),
          parameterSize: readString(entry.details?.parameter_size),
          quantization: readString(entry.details?.quantization_level),
        },
      ];
    });
    return { available: true, models };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { available: false, error: message, models: [] };
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchOllamaInstalledModels(): Promise<{
  available: boolean;
  error?: string;
  models: Array<{
    provider: "ollama";
    name: string;
    model: string;
    sizeBytes: number;
    parameterSize?: string;
    quantization?: string;
  }>;
}> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OLLAMA_STATUS_TIMEOUT_MS);
  timeout.unref?.();
  try {
    const res = await agentsHandlerDeps.fetchFn(OLLAMA_TAGS_URL, { signal: controller.signal });
    if (!res.ok) {
      return { available: false, error: `Ollama catalog returned HTTP ${res.status}`, models: [] };
    }
    const body = (await res.json()) as OllamaPsResponse;
    const rawModels = Array.isArray(body.models) ? body.models : [];
    const models = rawModels.flatMap((raw) => {
      const entry = raw as OllamaPsModel;
      const name = readString(entry.name) ?? readString(entry.model);
      const model = readString(entry.model) ?? name;
      const sizeBytes = readNonNegativeInteger(entry.size);
      if (!name || !model || sizeBytes === undefined) {
        return [];
      }
      return [
        {
          provider: "ollama" as const,
          name,
          model,
          sizeBytes,
          parameterSize: readString(entry.details?.parameter_size),
          quantization: readString(entry.details?.quantization_level),
        },
      ];
    });
    return { available: true, models };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { available: false, error: message, models: [] };
  } finally {
    clearTimeout(timeout);
  }
}

async function readOllamaProcessMemory(): Promise<{
  available: boolean;
  rssBytes: number;
  processCount: number;
  error?: string;
}> {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    return { available: false, rssBytes: 0, processCount: 0, error: "unsupported platform" };
  }
  try {
    const { stdout } = await agentsHandlerDeps.execFileFn("ps", ["-axo", "rss=,comm="], {
      timeout: OLLAMA_STATUS_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    });
    let rssKiB = 0;
    let processCount = 0;
    for (const line of String(stdout).split(/\r?\n/)) {
      const match = line.trim().match(/^(\d+)\s+(.+)$/);
      if (!match) {
        continue;
      }
      const command = match[2] ?? "";
      const executable = path.basename(command).toLowerCase();
      if (executable !== "ollama" && !command.toLowerCase().includes("/ollama")) {
        continue;
      }
      rssKiB += Number.parseInt(match[1] ?? "0", 10);
      processCount += 1;
    }
    return { available: true, rssBytes: Math.max(0, rssKiB) * KIB, processCount };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { available: false, rssBytes: 0, processCount: 0, error: message };
  }
}

type RuntimeProcessMemoryEntry = {
  pid: number;
  name: string;
  command: string;
  rssBytes: number;
  category: "openclaw" | "ollama" | "other";
};

type MacOsMemorySnapshot = {
  available: boolean;
  pageSizeBytes: number;
  freeBytes: number;
  speculativeBytes: number;
  purgeableBytes: number;
  fileBackedBytes: number;
  anonymousBytes: number;
  wiredBytes: number;
  compressedBytes: number;
  reclaimableBytes: number;
  availabilityEstimateBytes: number;
  error?: string;
};

function categorizeRuntimeProcess(command: string): RuntimeProcessMemoryEntry["category"] {
  const lower = command.toLowerCase();
  const executable = path.basename(command.split(/\s+/)[0] ?? "").toLowerCase();
  if (executable === "ollama" || lower.includes("/ollama")) {
    return "ollama";
  }
  if (lower.includes("openclaw") || lower.includes(".openclaw")) {
    return "openclaw";
  }
  return "other";
}

function displayProcessName(command: string): string {
  const executable = path.basename(command.split(/\s+/)[0] ?? "").trim();
  return executable || command.slice(0, 64) || "process";
}

async function readProcessMemorySnapshot(): Promise<{
  available: boolean;
  totalRssBytes: number;
  openclawRssBytes: number;
  ollamaRssBytes: number;
  otherRssBytes: number;
  top: RuntimeProcessMemoryEntry[];
  error?: string;
}> {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    return {
      available: false,
      totalRssBytes: 0,
      openclawRssBytes: 0,
      ollamaRssBytes: 0,
      otherRssBytes: 0,
      top: [],
      error: "unsupported platform",
    };
  }
  try {
    const { stdout } = await agentsHandlerDeps.execFileFn("ps", ["-axo", "pid=,rss=,command="], {
      timeout: OLLAMA_STATUS_TIMEOUT_MS,
      maxBuffer: 2 * 1024 * 1024,
    });
    const entries: RuntimeProcessMemoryEntry[] = [];
    for (const line of String(stdout).split(/\r?\n/)) {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
      if (!match) {
        continue;
      }
      const command = match[3]?.trim() ?? "";
      const rssKiB = Number.parseInt(match[2] ?? "0", 10);
      if (!command || !Number.isFinite(rssKiB) || rssKiB <= 0) {
        continue;
      }
      entries.push({
        pid: Number.parseInt(match[1] ?? "0", 10),
        name: displayProcessName(command),
        command,
        rssBytes: rssKiB * KIB,
        category: categorizeRuntimeProcess(command),
      });
    }
    let openclawRssBytes = 0;
    let ollamaRssBytes = 0;
    let otherRssBytes = 0;
    let totalRssBytes = 0;
    for (const entry of entries) {
      totalRssBytes += entry.rssBytes;
      if (entry.category === "openclaw") {
        openclawRssBytes += entry.rssBytes;
      } else if (entry.category === "ollama") {
        ollamaRssBytes += entry.rssBytes;
      } else {
        otherRssBytes += entry.rssBytes;
      }
    }
    return {
      available: true,
      totalRssBytes,
      openclawRssBytes,
      ollamaRssBytes,
      otherRssBytes,
      top: entries.toSorted((a, b) => b.rssBytes - a.rssBytes).slice(0, TOP_PROCESS_LIMIT),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      available: false,
      totalRssBytes: 0,
      openclawRssBytes: 0,
      ollamaRssBytes: 0,
      otherRssBytes: 0,
      top: [],
      error: message,
    };
  }
}

function readVmStatPageCount(stdout: string, label: string): number {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = stdout.match(new RegExp(`${escaped}:\\s+([0-9]+)\\.?`, "i"));
  if (!match) {
    return 0;
  }
  const value = Number.parseInt(match[1] ?? "0", 10);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function bytesFromPages(pages: number, pageSizeBytes: number): number {
  return Math.max(0, pages) * pageSizeBytes;
}

async function readMacOsMemorySnapshot(totalBytes: number): Promise<MacOsMemorySnapshot> {
  if (process.platform !== "darwin") {
    return {
      available: false,
      pageSizeBytes: 0,
      freeBytes: 0,
      speculativeBytes: 0,
      purgeableBytes: 0,
      fileBackedBytes: 0,
      anonymousBytes: 0,
      wiredBytes: 0,
      compressedBytes: 0,
      reclaimableBytes: 0,
      availabilityEstimateBytes: 0,
      error: "unsupported platform",
    };
  }
  try {
    const { stdout } = await agentsHandlerDeps.execFileFn("vm_stat", [], {
      timeout: MACOS_VM_STAT_TIMEOUT_MS,
      maxBuffer: 512 * 1024,
    });
    const text = String(stdout);
    const pageSizeMatch = text.match(/page size of\s+([0-9]+)\s+bytes/i);
    const pageSizeBytes = Number.parseInt(pageSizeMatch?.[1] ?? "0", 10);
    if (!Number.isFinite(pageSizeBytes) || pageSizeBytes <= 0) {
      throw new Error("could not read vm_stat page size");
    }

    const freeBytes = bytesFromPages(readVmStatPageCount(text, "Pages free"), pageSizeBytes);
    const speculativeBytes = bytesFromPages(
      readVmStatPageCount(text, "Pages speculative"),
      pageSizeBytes,
    );
    const purgeableBytes = bytesFromPages(
      readVmStatPageCount(text, "Pages purgeable"),
      pageSizeBytes,
    );
    const fileBackedBytes = bytesFromPages(
      readVmStatPageCount(text, "File-backed pages"),
      pageSizeBytes,
    );
    const anonymousBytes = bytesFromPages(
      readVmStatPageCount(text, "Anonymous pages"),
      pageSizeBytes,
    );
    const wiredBytes = bytesFromPages(readVmStatPageCount(text, "Pages wired down"), pageSizeBytes);
    const compressedBytes = bytesFromPages(
      readVmStatPageCount(text, "Pages occupied by compressor"),
      pageSizeBytes,
    );
    const reclaimableBytes = speculativeBytes + purgeableBytes + fileBackedBytes;
    return {
      available: true,
      pageSizeBytes,
      freeBytes,
      speculativeBytes,
      purgeableBytes,
      fileBackedBytes,
      anonymousBytes,
      wiredBytes,
      compressedBytes,
      reclaimableBytes,
      availabilityEstimateBytes: Math.min(totalBytes, freeBytes + reclaimableBytes),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      available: false,
      pageSizeBytes: 0,
      freeBytes: 0,
      speculativeBytes: 0,
      purgeableBytes: 0,
      fileBackedBytes: 0,
      anonymousBytes: 0,
      wiredBytes: 0,
      compressedBytes: 0,
      reclaimableBytes: 0,
      availabilityEstimateBytes: 0,
      error: message,
    };
  }
}

export async function buildAgentsRuntimeStatus() {
  const totalBytes = os.totalmem();
  const freeBytes = os.freemem();
  const usedBytes = Math.max(0, totalBytes - freeBytes);
  const ollama = await fetchOllamaRunningModels();
  const installedOllama = await fetchOllamaInstalledModels();
  const ollamaProcess = await readOllamaProcessMemory();
  const processMemory = await readProcessMemorySnapshot();
  const macosMemory = await readMacOsMemorySnapshot(totalBytes);
  const totalLoadedBytes = ollama.models.reduce((sum, model) => sum + model.sizeBytes, 0);
  const totalLoadedVramBytes = ollama.models.reduce(
    (sum, model) => sum + (model.sizeVramBytes ?? 0),
    0,
  );
  const warnings: string[] = [];
  if (!ollama.available && ollama.error) {
    warnings.push(`Ollama runtime telemetry is unavailable: ${ollama.error}`);
  }
  if (!installedOllama.available && installedOllama.error) {
    warnings.push(`Ollama installed model catalog is unavailable: ${installedOllama.error}`);
  }
  if (!ollamaProcess.available && ollamaProcess.error && ollama.available) {
    warnings.push(`Ollama process memory telemetry is unavailable: ${ollamaProcess.error}`);
  }
  if (!processMemory.available && processMemory.error) {
    warnings.push(`Process memory breakdown is unavailable: ${processMemory.error}`);
  }
  if (!macosMemory.available && macosMemory.error && process.platform === "darwin") {
    warnings.push(`macOS reclaimable memory telemetry is unavailable: ${macosMemory.error}`);
  }
  for (const model of ollama.models) {
    if (model.sizeBytes >= HIGH_LOCAL_MODEL_BYTES) {
      warnings.push(`${model.name} is using ${Math.round(model.sizeBytes / 1024 ** 3)} GB`);
    }
    if ((model.contextLength ?? 0) > LARGE_CONTEXT_THRESHOLD) {
      warnings.push(`${model.name} is loaded with ${model.contextLength} context`);
    }
  }
  return {
    ts: Date.now(),
    system: {
      totalBytes,
      freeBytes,
      usedBytes,
      usedRatio: totalBytes > 0 ? usedBytes / totalBytes : 0,
      processes: processMemory,
      macosMemory,
    },
    localModels: {
      provider: "ollama",
      available: ollama.available,
      error: ollama.error,
      totalLoadedBytes,
      totalLoadedVramBytes,
      count: ollama.models.length,
      models: ollama.models,
      installedAvailable: installedOllama.available,
      installedError: installedOllama.error,
      installedModels: installedOllama.models,
      process: {
        available: ollamaProcess.available,
        rssBytes: ollamaProcess.rssBytes,
        processCount: ollamaProcess.processCount,
        error: ollamaProcess.error,
      },
    },
    warnings,
  };
}

const MEMORY_FILE_NAMES = [DEFAULT_MEMORY_FILENAME] as const;

const ALLOWED_FILE_NAMES = new Set<string>([...BOOTSTRAP_FILE_NAMES, ...MEMORY_FILE_NAMES]);

function resolveAgentWorkspaceFileOrRespondError(
  params: Record<string, unknown>,
  respond: RespondFn,
  cfg: OpenClawConfig,
): {
  cfg: OpenClawConfig;
  agentId: string;
  workspaceDir: string;
  name: string;
} | null {
  const rawAgentId = params.agentId;
  const agentId = resolveAgentIdOrError(
    typeof rawAgentId === "string" || typeof rawAgentId === "number" ? String(rawAgentId) : "",
    cfg,
  );
  if (!agentId) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown agent id"));
    return null;
  }
  const rawName = params.name;
  const name = (
    typeof rawName === "string" || typeof rawName === "number" ? String(rawName) : ""
  ).trim();
  if (!ALLOWED_FILE_NAMES.has(name)) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, `unsupported file "${name}"`));
    return null;
  }
  const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
  return { cfg, agentId, workspaceDir, name };
}

type FileMeta = {
  size: number;
  updatedAtMs: number;
};

function isPathInsideDirectory(rootDir: string, candidatePath: string): boolean {
  const relative = path.relative(rootDir, candidatePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function statWorkspaceFileSafely(
  workspaceDir: string,
  name: string,
): Promise<FileMeta | null> {
  try {
    const workspaceReal = await fs.realpath(workspaceDir);
    const candidatePath = path.resolve(workspaceReal, name);
    if (!isPathInsideDirectory(workspaceReal, candidatePath)) {
      return null;
    }

    const pathStat = await fs.lstat(candidatePath);
    if (!pathStat.isFile() || pathStat.nlink > 1) {
      return null;
    }

    const realPath = await fs.realpath(candidatePath);
    if (!isPathInsideDirectory(workspaceReal, realPath)) {
      return null;
    }

    const realStat = await fs.stat(realPath);
    if (!realStat.isFile() || realStat.nlink > 1 || !sameFileIdentity(pathStat, realStat)) {
      return null;
    }

    return {
      size: realStat.size,
      updatedAtMs: Math.floor(realStat.mtimeMs),
    };
  } catch {
    return null;
  }
}

function isSafeWorkspaceFileError(err: unknown): err is SafeOpenError | FsSafeError {
  return err instanceof SafeOpenError || err instanceof FsSafeError;
}

function getSafeWorkspaceFileErrorCode(err: SafeOpenError | FsSafeError): string {
  return typeof (err as { code?: unknown }).code === "string" ? (err as { code: string }).code : "";
}

async function listAgentFiles(workspaceDir: string, options?: { hideBootstrap?: boolean }) {
  const files: Array<{
    name: string;
    path: string;
    missing: boolean;
    size?: number;
    updatedAtMs?: number;
  }> = [];

  const bootstrapFileNames = options?.hideBootstrap
    ? BOOTSTRAP_FILE_NAMES_POST_ONBOARDING
    : BOOTSTRAP_FILE_NAMES;
  for (const name of bootstrapFileNames) {
    const filePath = path.join(workspaceDir, name);
    const meta = await agentsHandlerDeps.statWorkspaceFile(workspaceDir, name);
    if (meta) {
      files.push({
        name,
        path: filePath,
        missing: false,
        size: meta.size,
        updatedAtMs: meta.updatedAtMs,
      });
    } else {
      files.push({ name, path: filePath, missing: true });
    }
  }

  const primaryMeta = await agentsHandlerDeps.statWorkspaceFile(
    workspaceDir,
    DEFAULT_MEMORY_FILENAME,
  );
  if (primaryMeta) {
    files.push({
      name: DEFAULT_MEMORY_FILENAME,
      path: path.join(workspaceDir, DEFAULT_MEMORY_FILENAME),
      missing: false,
      size: primaryMeta.size,
      updatedAtMs: primaryMeta.updatedAtMs,
    });
  } else {
    files.push({
      name: DEFAULT_MEMORY_FILENAME,
      path: path.join(workspaceDir, DEFAULT_MEMORY_FILENAME),
      missing: true,
    });
  }

  return files;
}

function resolveAgentIdOrError(agentIdRaw: string, cfg: OpenClawConfig) {
  const agentId = normalizeAgentId(agentIdRaw);
  const allowed = new Set(listAgentIds(cfg));
  if (!allowed.has(agentId)) {
    return null;
  }
  return agentId;
}

function sanitizeIdentityLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function resolveOptionalStringParam(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function respondInvalidMethodParams(
  respond: RespondFn,
  method: string,
  errors: Parameters<typeof formatValidationErrors>[0],
): void {
  respond(
    false,
    undefined,
    errorShape(
      ErrorCodes.INVALID_REQUEST,
      `invalid ${method} params: ${formatValidationErrors(errors)}`,
    ),
  );
}

function isConfiguredAgent(cfg: OpenClawConfig, agentId: string): boolean {
  return findAgentEntryIndex(listAgentEntries(cfg), agentId) >= 0;
}

function respondAgentNotFound(respond: RespondFn, agentId: string): void {
  respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, `agent "${agentId}" not found`));
}

async function moveToTrashBestEffort(pathname: string): Promise<void> {
  if (!pathname) {
    return;
  }
  try {
    await fs.access(pathname);
  } catch {
    return;
  }
  try {
    await movePathToTrash(pathname);
  } catch {
    // Best-effort: path may already be gone or trash unavailable.
  }
}

function respondWorkspaceFileUnsafe(respond: RespondFn, name: string): void {
  respond(
    false,
    undefined,
    errorShape(ErrorCodes.INVALID_REQUEST, `unsafe workspace file "${name}"`),
  );
}

function respondWorkspaceFileMissing(params: {
  respond: RespondFn;
  agentId: string;
  workspaceDir: string;
  name: string;
  filePath: string;
}): void {
  params.respond(
    true,
    {
      agentId: params.agentId,
      workspace: params.workspaceDir,
      file: { name: params.name, path: params.filePath, missing: true },
    },
    undefined,
  );
}

async function writeWorkspaceFileOrRespond(params: {
  respond: RespondFn;
  workspaceDir: string;
  name: string;
  content: string;
}): Promise<boolean> {
  await fs.mkdir(params.workspaceDir, { recursive: true });
  try {
    await agentsHandlerDeps.writeFileWithinRoot({
      rootDir: params.workspaceDir,
      relativePath: params.name,
      data: params.content,
      encoding: "utf8",
    });
  } catch (err) {
    if (isSafeWorkspaceFileError(err)) {
      respondWorkspaceFileUnsafe(params.respond, params.name);
      return false;
    }
    throw err;
  }
  return true;
}

function normalizeIdentityForFile(
  identity: IdentityConfig | undefined,
): IdentityConfig | undefined {
  if (!identity) {
    return undefined;
  }
  const resolved = {
    name: identity.name?.trim() || undefined,
    theme: identity.theme?.trim() || undefined,
    emoji: identity.emoji?.trim() || undefined,
    avatar: identity.avatar?.trim() || undefined,
  } satisfies IdentityConfig;
  if (!resolved.name && !resolved.theme && !resolved.emoji && !resolved.avatar) {
    return undefined;
  }
  return resolved;
}

async function readWorkspaceFileContent(
  workspaceDir: string,
  name: string,
): Promise<string | undefined> {
  try {
    const safeRead = await agentsHandlerDeps.readFileWithinRoot({
      rootDir: workspaceDir,
      relativePath: name,
      rejectHardlinks: true,
      nonBlockingRead: true,
    });
    return safeRead.buffer.toString("utf-8");
  } catch (err) {
    if (isSafeWorkspaceFileError(err) && getSafeWorkspaceFileErrorCode(err) === "not-found") {
      return undefined;
    }
    throw err;
  }
}

async function buildIdentityMarkdownForWrite(params: {
  workspaceDir: string;
  identity: IdentityConfig;
  fallbackWorkspaceDir?: string;
  preferFallbackWorkspaceContent?: boolean;
}): Promise<string> {
  let baseContent: string | undefined;
  if (params.preferFallbackWorkspaceContent && params.fallbackWorkspaceDir) {
    baseContent = await readWorkspaceFileContent(
      params.fallbackWorkspaceDir,
      DEFAULT_IDENTITY_FILENAME,
    );
    if (baseContent === undefined) {
      baseContent = await readWorkspaceFileContent(params.workspaceDir, DEFAULT_IDENTITY_FILENAME);
    }
  } else {
    baseContent = await readWorkspaceFileContent(params.workspaceDir, DEFAULT_IDENTITY_FILENAME);
    if (baseContent === undefined && params.fallbackWorkspaceDir) {
      baseContent = await readWorkspaceFileContent(
        params.fallbackWorkspaceDir,
        DEFAULT_IDENTITY_FILENAME,
      );
    }
  }

  return mergeIdentityMarkdownContent(baseContent, params.identity);
}

async function buildIdentityMarkdownOrRespondUnsafe(params: {
  respond: RespondFn;
  workspaceDir: string;
  identity: IdentityConfig;
  fallbackWorkspaceDir?: string;
  preferFallbackWorkspaceContent?: boolean;
}): Promise<string | null> {
  try {
    return await buildIdentityMarkdownForWrite(params);
  } catch (err) {
    if (isSafeWorkspaceFileError(err)) {
      respondWorkspaceFileUnsafe(params.respond, DEFAULT_IDENTITY_FILENAME);
      return null;
    }
    throw err;
  }
}

export const agentsHandlers: GatewayRequestHandlers = {
  "agents.list": ({ params, respond, context }) => {
    if (!validateAgentsListParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid agents.list params: ${formatValidationErrors(validateAgentsListParams.errors)}`,
        ),
      );
      return;
    }

    const cfg = context.getRuntimeConfig();
    const result = listAgentsForGateway(cfg);
    respond(true, result, undefined);
  },
  "agents.runtime.status": async ({ params, respond }) => {
    if (!validateAgentsRuntimeStatusParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid agents.runtime.status params: ${formatValidationErrors(
            validateAgentsRuntimeStatusParams.errors,
          )}`,
        ),
      );
      return;
    }

    respond(true, await buildAgentsRuntimeStatus(), undefined);
  },
  "agents.create": async ({ params, respond, context }) => {
    if (!validateAgentsCreateParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid agents.create params: ${formatValidationErrors(
            validateAgentsCreateParams.errors,
          )}`,
        ),
      );
      return;
    }

    const cfg = context.getRuntimeConfig();
    const rawName = params.name.trim();
    const agentId = normalizeAgentId(rawName);
    if (agentId === DEFAULT_AGENT_ID) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `"${DEFAULT_AGENT_ID}" is reserved`),
      );
      return;
    }

    if (findAgentEntryIndex(listAgentEntries(cfg), agentId) >= 0) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `agent "${agentId}" already exists`),
      );
      return;
    }

    const workspaceDir = resolveUserPath(params.workspace.trim());

    const safeName = sanitizeIdentityLine(rawName);
    const model = resolveOptionalStringParam(params.model);
    const emoji = resolveOptionalStringParam(params.emoji);
    const avatar = resolveOptionalStringParam(params.avatar);

    const identity = {
      name: safeName,
      ...(emoji ? { emoji: sanitizeIdentityLine(emoji) } : {}),
      ...(avatar ? { avatar: sanitizeIdentityLine(avatar) } : {}),
    };

    // Resolve agentDir against the config we're about to persist (vs the pre-write config),
    // so subsequent resolutions can't disagree about the agent's directory.
    let nextConfig = applyAgentConfig(cfg, {
      agentId,
      name: safeName,
      workspace: workspaceDir,
      model,
      identity,
    });
    const agentDir = resolveAgentDir(nextConfig, agentId);
    nextConfig = applyAgentConfig(nextConfig, { agentId, agentDir });

    // Ensure workspace & transcripts exist BEFORE writing config so a failure
    // here does not leave a broken config entry behind.
    const skipBootstrap = Boolean(nextConfig.agents?.defaults?.skipBootstrap);
    await ensureAgentWorkspace({
      dir: workspaceDir,
      ensureBootstrapFiles: !skipBootstrap,
      skipOptionalBootstrapFiles: nextConfig.agents?.defaults?.skipOptionalBootstrapFiles,
    });
    await fs.mkdir(resolveSessionTranscriptsDirForAgent(agentId), { recursive: true });

    const persistedIdentity = normalizeIdentityForFile(resolveAgentIdentity(nextConfig, agentId));
    if (persistedIdentity) {
      const identityContent = await buildIdentityMarkdownOrRespondUnsafe({
        respond,
        workspaceDir,
        identity: persistedIdentity,
      });
      if (identityContent === null) {
        return;
      }
      if (
        !(await writeWorkspaceFileOrRespond({
          respond,
          workspaceDir,
          name: DEFAULT_IDENTITY_FILENAME,
          content: identityContent,
        }))
      ) {
        return;
      }
    }
    await replaceConfigFile({
      nextConfig,
      afterWrite: { mode: "auto" },
    });

    respond(true, { ok: true, agentId, name: safeName, workspace: workspaceDir, model }, undefined);
  },
  "agents.update": async ({ params, respond, context }) => {
    if (!validateAgentsUpdateParams(params)) {
      respondInvalidMethodParams(respond, "agents.update", validateAgentsUpdateParams.errors);
      return;
    }

    const cfg = context.getRuntimeConfig();
    const agentId = normalizeAgentId(params.agentId);
    if (!isConfiguredAgent(cfg, agentId)) {
      respondAgentNotFound(respond, agentId);
      return;
    }

    const workspaceDir =
      typeof params.workspace === "string" && params.workspace.trim()
        ? resolveUserPath(params.workspace.trim())
        : undefined;

    const model = resolveOptionalStringParam(params.model);
    const roomId = resolveOptionalStringParam(params.roomId);
    const emoji = resolveOptionalStringParam(params.emoji);
    const avatar = resolveOptionalStringParam(params.avatar);

    const safeName =
      typeof params.name === "string" && params.name.trim()
        ? sanitizeIdentityLine(params.name.trim())
        : undefined;

    const hasIdentityFields = Boolean(safeName || emoji || avatar);
    const identity = hasIdentityFields
      ? {
          ...(safeName ? { name: safeName } : {}),
          ...(emoji ? { emoji: sanitizeIdentityLine(emoji) } : {}),
          ...(avatar ? { avatar: sanitizeIdentityLine(avatar) } : {}),
        }
      : undefined;

    const nextConfig = applyAgentConfig(cfg, {
      agentId,
      ...(safeName ? { name: safeName } : {}),
      ...(roomId ? { roomId } : {}),
      ...(workspaceDir ? { workspace: workspaceDir } : {}),
      ...(model ? { model } : {}),
      ...(identity ? { identity } : {}),
    });

    let ensuredWorkspace: Awaited<ReturnType<typeof ensureAgentWorkspace>> | undefined;
    if (workspaceDir) {
      const skipBootstrap = Boolean(nextConfig.agents?.defaults?.skipBootstrap);
      ensuredWorkspace = await ensureAgentWorkspace({
        dir: workspaceDir,
        ensureBootstrapFiles: !skipBootstrap,
        skipOptionalBootstrapFiles: nextConfig.agents?.defaults?.skipOptionalBootstrapFiles,
      });
    }

    const persistedIdentity = normalizeIdentityForFile(resolveAgentIdentity(nextConfig, agentId));
    if (persistedIdentity && (workspaceDir || hasIdentityFields)) {
      const identityWorkspaceDir = resolveAgentWorkspaceDir(nextConfig, agentId);
      const previousWorkspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
      const fallbackWorkspaceDir =
        workspaceDir && identityWorkspaceDir !== previousWorkspaceDir
          ? previousWorkspaceDir
          : undefined;
      const identityContent = await buildIdentityMarkdownOrRespondUnsafe({
        respond,
        workspaceDir: identityWorkspaceDir,
        identity: persistedIdentity,
        fallbackWorkspaceDir,
        preferFallbackWorkspaceContent:
          Boolean(fallbackWorkspaceDir) && ensuredWorkspace?.identityPathCreated === true,
      });
      if (identityContent === null) {
        return;
      }
      if (
        !(await writeWorkspaceFileOrRespond({
          respond,
          workspaceDir: identityWorkspaceDir,
          name: DEFAULT_IDENTITY_FILENAME,
          content: identityContent,
        }))
      ) {
        return;
      }
    }

    await replaceConfigFile({
      nextConfig,
      afterWrite: { mode: "auto" },
    });

    respond(true, { ok: true, agentId }, undefined);
  },
  "agents.delete": async ({ params, respond, context }) => {
    if (!validateAgentsDeleteParams(params)) {
      respondInvalidMethodParams(respond, "agents.delete", validateAgentsDeleteParams.errors);
      return;
    }

    const cfg = context.getRuntimeConfig();
    const agentId = normalizeAgentId(params.agentId);
    if (agentId === DEFAULT_AGENT_ID) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `"${DEFAULT_AGENT_ID}" cannot be deleted`),
      );
      return;
    }
    if (!isConfiguredAgent(cfg, agentId)) {
      respondAgentNotFound(respond, agentId);
      return;
    }

    const deleteFiles = typeof params.deleteFiles === "boolean" ? params.deleteFiles : true;
    const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
    const agentDir = resolveAgentDir(cfg, agentId);
    const sessionsDir = resolveSessionTranscriptsDirForAgent(agentId);

    const result = pruneAgentConfig(cfg, agentId);
    await replaceConfigFile({
      nextConfig: result.config,
      afterWrite: { mode: "auto" },
    });

    // Purge session store entries so orphaned sessions cannot be targeted (#65524).
    await purgeAgentSessionStoreEntries(cfg, agentId);

    if (deleteFiles) {
      const workspaceSharedWith = findOverlappingWorkspaceAgentIds(cfg, agentId, workspaceDir);
      const deleteWorkspace = workspaceSharedWith.length === 0;
      await Promise.all([
        ...(deleteWorkspace ? [moveToTrashBestEffort(workspaceDir)] : []),
        moveToTrashBestEffort(agentDir),
        moveToTrashBestEffort(sessionsDir),
      ]);
    }

    respond(true, { ok: true, agentId, removedBindings: result.removedBindings }, undefined);
  },
  "agents.files.list": async ({ params, respond, context }) => {
    if (!validateAgentsFilesListParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid agents.files.list params: ${formatValidationErrors(
            validateAgentsFilesListParams.errors,
          )}`,
        ),
      );
      return;
    }
    const cfg = context.getRuntimeConfig();
    const agentId = resolveAgentIdOrError(params.agentId, cfg);
    if (!agentId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown agent id"));
      return;
    }
    const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
    let hideBootstrap = false;
    try {
      hideBootstrap = await agentsHandlerDeps.isWorkspaceSetupCompleted(workspaceDir);
    } catch {
      // Fall back to showing BOOTSTRAP if workspace state cannot be read.
    }
    const files = await listAgentFiles(workspaceDir, { hideBootstrap });
    respond(true, { agentId, workspace: workspaceDir, files }, undefined);
  },
  "agents.files.get": async ({ params, respond, context }) => {
    if (!validateAgentsFilesGetParams(params)) {
      respondInvalidMethodParams(respond, "agents.files.get", validateAgentsFilesGetParams.errors);
      return;
    }
    const resolved = resolveAgentWorkspaceFileOrRespondError(
      params,
      respond,
      context.getRuntimeConfig(),
    );
    if (!resolved) {
      return;
    }
    const { agentId, workspaceDir, name } = resolved;
    const filePath = path.join(workspaceDir, name);
    let safeRead: Awaited<ReturnType<typeof readFileWithinRoot>>;
    try {
      safeRead = await agentsHandlerDeps.readFileWithinRoot({
        rootDir: workspaceDir,
        relativePath: name,
        rejectHardlinks: true,
        nonBlockingRead: true,
      });
    } catch (err) {
      if (isSafeWorkspaceFileError(err) && getSafeWorkspaceFileErrorCode(err) === "not-found") {
        respondWorkspaceFileMissing({ respond, agentId, workspaceDir, name, filePath });
        return;
      }
      if (isSafeWorkspaceFileError(err)) {
        respondWorkspaceFileUnsafe(respond, name);
        return;
      }
      throw err;
    }
    respond(
      true,
      {
        agentId,
        workspace: workspaceDir,
        file: {
          name,
          path: filePath,
          missing: false,
          size: safeRead.stat.size,
          updatedAtMs: Math.floor(safeRead.stat.mtimeMs),
          content: safeRead.buffer.toString("utf-8"),
        },
      },
      undefined,
    );
  },
  "agents.files.set": async ({ params, respond, context }) => {
    if (!validateAgentsFilesSetParams(params)) {
      respondInvalidMethodParams(respond, "agents.files.set", validateAgentsFilesSetParams.errors);
      return;
    }
    const resolved = resolveAgentWorkspaceFileOrRespondError(
      params,
      respond,
      context.getRuntimeConfig(),
    );
    if (!resolved) {
      return;
    }
    const { agentId, workspaceDir, name } = resolved;
    await fs.mkdir(workspaceDir, { recursive: true });
    const filePath = path.join(workspaceDir, name);
    const content = params.content;
    try {
      await agentsHandlerDeps.writeFileWithinRoot({
        rootDir: workspaceDir,
        relativePath: name,
        data: content,
        encoding: "utf8",
      });
    } catch (err) {
      if (!isSafeWorkspaceFileError(err)) {
        throw err;
      }
      respondWorkspaceFileUnsafe(respond, name);
      return;
    }
    const meta = await statWorkspaceFileSafely(workspaceDir, name);
    respond(
      true,
      {
        ok: true,
        agentId,
        workspace: workspaceDir,
        file: {
          name,
          path: filePath,
          missing: false,
          size: meta?.size,
          updatedAtMs: meta?.updatedAtMs,
          content,
        },
      },
      undefined,
    );
  },
};
