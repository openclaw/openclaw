import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

export type DownloadOpts = {
  expectedSha256?: string;
  onProgress?: (bytesDownloaded: number, totalBytes: number | null) => void;
  signal?: AbortSignal;
};

export type DownloadResult = {
  sha256: string;
  bytesWritten: number;
};

export async function downloadFile(
  url: string,
  dest: string,
  opts?: DownloadOpts,
): Promise<DownloadResult> {
  await fs.mkdir(path.dirname(dest), { recursive: true });

  const response = await fetch(url, {
    signal: opts?.signal,
    redirect: "follow",
  });
  if (!response.ok) {
    throw new Error(`Download failed: HTTP ${response.status} for ${url}`);
  }
  if (!response.body) {
    throw new Error(`No response body for ${url}`);
  }

  const totalBytes = response.headers.get("content-length");
  const total = totalBytes ? Number.parseInt(totalBytes, 10) : null;

  const tempDest = `${dest}.download`;
  const hash = createHash("sha256");
  const writeStream = createWriteStream(tempDest);
  let bytesWritten = 0;

  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      hash.update(value);
      writeStream.write(value);
      bytesWritten += value.byteLength;
      opts?.onProgress?.(bytesWritten, total);
    }
    writeStream.end();
    await new Promise<void>((resolve, reject) => {
      writeStream.on("finish", resolve);
      writeStream.on("error", reject);
    });
  } catch (err) {
    writeStream.destroy();
    await fs.unlink(tempDest).catch(() => {});
    throw err;
  }

  const sha256 = hash.digest("hex");
  if (opts?.expectedSha256 && sha256 !== opts.expectedSha256) {
    await fs.unlink(tempDest).catch(() => {});
    throw new Error(`SHA256 mismatch for ${url}: expected ${opts.expectedSha256}, got ${sha256}`);
  }

  await fs.rename(tempDest, dest);
  return { sha256, bytesWritten };
}

export async function extractTarGz(archive: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  await execCommand("tar", ["xzf", archive, "-C", dest]);
}

export async function extractZip(archive: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  await execCommand("unzip", ["-o", "-q", archive, "-d", dest]);
}

export type ExecResult = {
  code: number;
  stdout: string;
  stderr: string;
};

export async function execCommand(
  cmd: string,
  args: string[],
  opts?: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeout?: number;
    stdin?: string;
  },
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts?.cwd,
      env: { ...process.env, ...opts?.env },
      stdio: ["pipe", "pipe", "pipe"],
      timeout: opts?.timeout,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });
    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    if (opts?.stdin !== undefined) {
      child.stdin.write(opts.stdin);
      child.stdin.end();
    } else {
      child.stdin.end();
    }

    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

export async function waitForHealthy(
  url: string,
  opts?: { timeoutMs?: number; intervalMs?: number },
): Promise<boolean> {
  const timeout = opts?.timeoutMs ?? 30_000;
  const interval = opts?.intervalMs ?? 500;
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) {
        return true;
      }
    } catch {
      // Not ready yet.
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  return false;
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function whichBinary(name: string): Promise<string | undefined> {
  try {
    const result = await execCommand("which", [name]);
    if (result.code === 0 && result.stdout.trim()) {
      return result.stdout.trim();
    }
  } catch {
    // Not found.
  }
  return undefined;
}
