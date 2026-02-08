import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

export type MemoryFileEntry = {
  path: string;
  absPath: string;
  mtimeMs: number;
  size: number;
  hash: string;
};

export type MemoryChunk = {
  startLine: number;
  endLine: number;
  text: string;
  hash: string;
};

export function ensureDir(dir: string): string {
  try {
    fsSync.mkdirSync(dir, { recursive: true });
  } catch {}
  return dir;
}

export function normalizeRelPath(value: string): string {
  const trimmed = value.trim().replace(/^[./]+/, "");
  return trimmed.replace(/\\/g, "/");
}

export function normalizeExtraMemoryPaths(workspaceDir: string, extraPaths?: string[]): string[] {
  if (!extraPaths?.length) {
    return [];
  }
  const resolved = extraPaths
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) =>
      path.isAbsolute(value) ? path.resolve(value) : path.resolve(workspaceDir, value),
    );
  return Array.from(new Set(resolved));
}

export function isMemoryPath(relPath: string): boolean {
  const normalized = normalizeRelPath(relPath);
  if (!normalized) {
    return false;
  }
  switch (normalized) {
    case "MEMORY.md":
    case "memory.md":
    case "STM.md":
    case "stm.md":
    case "WORKING.md":
    case "working.md":
      return true;
    default:
      return normalized.startsWith("memory/");
  }
}

type FileStat = Awaited<ReturnType<typeof fs.lstat>>;

function tryLstatSync(targetPath: string): FileStat | null {
  try {
    return fsSync.lstatSync(targetPath);
  } catch {
    return null;
  }
}

async function tryLstat(targetPath: string): Promise<FileStat | null> {
  try {
    return await fs.lstat(targetPath);
  } catch {
    return null;
  }
}

function isRegularFileSync(targetPath: string): boolean {
  const stat = tryLstatSync(targetPath);
  return Boolean(stat && !stat.isSymbolicLink() && stat.isFile());
}

function isRegularDirSync(targetPath: string): boolean {
  const stat = tryLstatSync(targetPath);
  return Boolean(stat && !stat.isSymbolicLink() && stat.isDirectory());
}

async function isRegularFile(targetPath: string): Promise<boolean> {
  const stat = await tryLstat(targetPath);
  return Boolean(stat && !stat.isSymbolicLink() && stat.isFile());
}

async function isRegularDir(targetPath: string): Promise<boolean> {
  const stat = await tryLstat(targetPath);
  return Boolean(stat && !stat.isSymbolicLink() && stat.isDirectory());
}

export function isLtmOptedInSync(workspaceDir: string): boolean {
  const ltmDir = path.join(workspaceDir, "ltm");
  if (!isRegularDirSync(ltmDir)) {
    return false;
  }
  return (
    isRegularFileSync(path.join(ltmDir, "index.md")) || isRegularDirSync(path.join(ltmDir, "nodes"))
  );
}

export async function isLtmOptedIn(workspaceDir: string): Promise<boolean> {
  const ltmDir = path.join(workspaceDir, "ltm");
  if (!(await isRegularDir(ltmDir))) {
    return false;
  }
  return (
    (await isRegularFile(path.join(ltmDir, "index.md"))) ||
    (await isRegularDir(path.join(ltmDir, "nodes")))
  );
}

type MemoryLayoutResult = {
  created: {
    stm: boolean;
    working: boolean;
    ltmIndex: boolean;
    ltmNodes: boolean;
  };
};

type MemoryLayoutLogger = (message: string) => void;

export async function ensureWmStmLtmLayout(params: {
  workspaceDir: string;
  allowCreate: boolean;
  log?: MemoryLayoutLogger;
}): Promise<MemoryLayoutResult> {
  const created = {
    stm: false,
    working: false,
    ltmIndex: false,
    ltmNodes: false,
  };
  if (!params.allowCreate) {
    return { created };
  }
  const workspaceDir = params.workspaceDir.trim();
  if (!workspaceDir) {
    params.log?.("memory layout: missing workspaceDir");
    return { created };
  }
  const log = params.log;

  const ensureDir = async (targetPath: string, label: string) => {
    const stat = await tryLstat(targetPath);
    if (stat) {
      if (stat.isSymbolicLink()) {
        log?.(`memory layout: skip ${label} (symlink)`);
        return { ok: false, created: false };
      }
      if (!stat.isDirectory()) {
        log?.(`memory layout: skip ${label} (not a directory)`);
        return { ok: false, created: false };
      }
      return { ok: true, created: false };
    }
    try {
      await fs.mkdir(targetPath, { recursive: true });
      return { ok: true, created: true };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EEXIST") {
        return { ok: true, created: false };
      }
      log?.(`memory layout: failed to create ${label}: ${String(err)}`);
      return { ok: false, created: false };
    }
  };

  const ensureFile = async (targetPath: string, content: string, label: string) => {
    const stat = await tryLstat(targetPath);
    if (stat) {
      if (stat.isSymbolicLink()) {
        log?.(`memory layout: skip ${label} (symlink)`);
        return { ok: false, created: false };
      }
      if (!stat.isFile()) {
        log?.(`memory layout: skip ${label} (not a file)`);
        return { ok: false, created: false };
      }
      return { ok: true, created: false };
    }
    try {
      await fs.writeFile(targetPath, content, { flag: "wx" });
      return { ok: true, created: true };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EEXIST") {
        return { ok: true, created: false };
      }
      log?.(`memory layout: failed to create ${label}: ${String(err)}`);
      return { ok: false, created: false };
    }
  };

  const stm = await ensureFile(path.join(workspaceDir, "STM.md"), "# STM\n", "STM.md");
  created.stm = stm.created;

  const working = await ensureFile(
    path.join(workspaceDir, "WORKING.md"),
    "# WORKING\n",
    "WORKING.md",
  );
  created.working = working.created;

  if (isLtmOptedInSync(workspaceDir)) {
    const ltmDir = path.join(workspaceDir, "ltm");
    const ltmDirResult = await ensureDir(ltmDir, "ltm/");
    if (ltmDirResult.ok) {
      const nodes = await ensureDir(path.join(ltmDir, "nodes"), "ltm/nodes/");
      created.ltmNodes = nodes.created;
      const index = await ensureFile(
        path.join(ltmDir, "index.md"),
        "# LTM Index\n",
        "ltm/index.md",
      );
      created.ltmIndex = index.created;
    }
  }

  return { created };
}

async function walkDir(dir: string, files: string[]) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      continue;
    }
    if (entry.isDirectory()) {
      await walkDir(full, files);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    if (!entry.name.endsWith(".md")) {
      continue;
    }
    files.push(full);
  }
}

export async function listMemoryFiles(
  workspaceDir: string,
  extraPaths?: string[],
): Promise<string[]> {
  const result: string[] = [];
  const memoryDir = path.join(workspaceDir, "memory");
  const ltmDir = path.join(workspaceDir, "ltm");

  const addMarkdownFile = async (absPath: string) => {
    try {
      const stat = await fs.lstat(absPath);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        return;
      }
      if (!absPath.endsWith(".md")) {
        return;
      }
      result.push(absPath);
    } catch {}
  };

  for (const entry of ["MEMORY.md", "memory.md", "STM.md", "stm.md"]) {
    await addMarkdownFile(path.join(workspaceDir, entry));
  }
  try {
    const dirStat = await fs.lstat(memoryDir);
    if (!dirStat.isSymbolicLink() && dirStat.isDirectory()) {
      await walkDir(memoryDir, result);
    }
  } catch {}

  if (await isLtmOptedIn(workspaceDir)) {
    await walkDir(ltmDir, result);
  }

  const normalizedExtraPaths = normalizeExtraMemoryPaths(workspaceDir, extraPaths);
  if (normalizedExtraPaths.length > 0) {
    for (const inputPath of normalizedExtraPaths) {
      try {
        const stat = await fs.lstat(inputPath);
        if (stat.isSymbolicLink()) {
          continue;
        }
        if (stat.isDirectory()) {
          await walkDir(inputPath, result);
          continue;
        }
        if (stat.isFile() && inputPath.endsWith(".md")) {
          result.push(inputPath);
        }
      } catch {}
    }
  }
  if (result.length <= 1) {
    return result;
  }
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const entry of result) {
    let key = entry;
    try {
      key = await fs.realpath(entry);
    } catch {}
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(entry);
  }
  return deduped;
}

export function hashText(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export async function buildFileEntry(
  absPath: string,
  workspaceDir: string,
): Promise<MemoryFileEntry> {
  const stat = await fs.stat(absPath);
  const content = await fs.readFile(absPath, "utf-8");
  const hash = hashText(content);
  return {
    path: path.relative(workspaceDir, absPath).replace(/\\/g, "/"),
    absPath,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    hash,
  };
}

export function chunkMarkdown(
  content: string,
  chunking: { tokens: number; overlap: number },
): MemoryChunk[] {
  const lines = content.split("\n");
  if (lines.length === 0) {
    return [];
  }
  const maxChars = Math.max(32, chunking.tokens * 4);
  const overlapChars = Math.max(0, chunking.overlap * 4);
  const chunks: MemoryChunk[] = [];

  let current: Array<{ line: string; lineNo: number }> = [];
  let currentChars = 0;

  const flush = () => {
    if (current.length === 0) {
      return;
    }
    const firstEntry = current[0];
    const lastEntry = current[current.length - 1];
    if (!firstEntry || !lastEntry) {
      return;
    }
    const text = current.map((entry) => entry.line).join("\n");
    const startLine = firstEntry.lineNo;
    const endLine = lastEntry.lineNo;
    chunks.push({
      startLine,
      endLine,
      text,
      hash: hashText(text),
    });
  };

  const carryOverlap = () => {
    if (overlapChars <= 0 || current.length === 0) {
      current = [];
      currentChars = 0;
      return;
    }
    let acc = 0;
    const kept: Array<{ line: string; lineNo: number }> = [];
    for (let i = current.length - 1; i >= 0; i -= 1) {
      const entry = current[i];
      if (!entry) {
        continue;
      }
      acc += entry.line.length + 1;
      kept.unshift(entry);
      if (acc >= overlapChars) {
        break;
      }
    }
    current = kept;
    currentChars = kept.reduce((sum, entry) => sum + entry.line.length + 1, 0);
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const lineNo = i + 1;
    const segments: string[] = [];
    if (line.length === 0) {
      segments.push("");
    } else {
      for (let start = 0; start < line.length; start += maxChars) {
        segments.push(line.slice(start, start + maxChars));
      }
    }
    for (const segment of segments) {
      const lineSize = segment.length + 1;
      if (currentChars + lineSize > maxChars && current.length > 0) {
        flush();
        carryOverlap();
      }
      current.push({ line: segment, lineNo });
      currentChars += lineSize;
    }
  }
  flush();
  return chunks;
}

export function parseEmbedding(raw: string): number[] {
  try {
    const parsed = JSON.parse(raw) as number[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0) {
    return 0;
  }
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < len; i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  if (normA === 0 || normB === 0) {
    return 0;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export async function runWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  limit: number,
): Promise<T[]> {
  if (tasks.length === 0) return [];
  const resolvedLimit = Math.max(1, Math.min(limit, tasks.length));
  const results: T[] = Array.from({ length: tasks.length });
  let next = 0;
  let firstError: unknown = null;

  const workers = Array.from({ length: resolvedLimit }, async () => {
    while (true) {
      if (firstError) return;
      const index = next;
      next += 1;
      if (index >= tasks.length) return;
      try {
        results[index] = await tasks[index]();
      } catch (err) {
        firstError = err;
        return;
      }
    }
  });

  await Promise.allSettled(workers);
  if (firstError) throw firstError;
  return results;
}
