import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import { createWriteStream } from 'fs';
import path from 'path';
import os from 'os';
import https from 'https';
import type { AgentToolResult, AgentToolUpdateCallback } from '@mariozechner/pi-agent-core';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

const MEDIA_SERVER_PORT = 18791;

const YTDLP_URLS: Record<string, string> = {
  linux: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp',
  darwin: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos',
  win32: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
};

/**
 * FIXED: Recursively follows HTTP redirects (301/302) to prevent 
 * corrupt binaries when downloading from GitHub Releases.
 */
async function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    function doGet(currentUrl: string, redirectsLeft: number): void {
      if (redirectsLeft <= 0) {
        return reject(new Error(`Too many redirects: ${url}`));
      }

      https.get(currentUrl, (response) => {
        // Handle Redirects
        if ((response.statusCode === 301 || response.statusCode === 302) && response.headers.location) {
          response.resume();
          return doGet(response.headers.location, redirectsLeft - 1);
        }

        if (response.statusCode !== 200) {
          response.resume();
          return reject(new Error(`HTTP ${response.statusCode} downloading binary`));
        }

        const file = createWriteStream(dest);
        response.pipe(file);

        file.on('error', (err) => {
          file.close();
          fs.unlink(dest).catch(() => {});
          reject(err);
        });

        file.on('close', async () => {
          if (process.platform !== 'win32') {
            await fs.chmod(dest, 0o755);
          }
          resolve();
        });
      }).on('error', (err) => {
        fs.unlink(dest).catch(() => {});
        reject(err);
      });
    }
    doGet(url, 10);
  });
}

async function getYtDlpPath(): Promise<string> {
  const baseDir = path.join(os.homedir(), '.openclaw', 'bin');
  await fs.mkdir(baseDir, { recursive: true });
  return path.join(baseDir, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
}

async function ensureYtDlp(): Promise<string> {
  const ytDlpPath = await getYtDlpPath();
  try {
    await execFileAsync(ytDlpPath, ['--version']);
    return ytDlpPath;
  } catch {
    const url = YTDLP_URLS[process.platform];
    if (!url) {
      throw new Error(`Unsupported platform: ${process.platform}`);
    }
    await downloadFile(url, ytDlpPath);
    return ytDlpPath;
  }
}

async function ensureFfmpeg(): Promise<void> {
  try {
    await execAsync('ffmpeg -version');
  } catch {
    if (process.platform === 'linux') {
      await execAsync('sudo apt-get update -qq && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ffmpeg');
    } else {
      throw new Error(`ffmpeg required for merging video/audio.`);
    }
  }
}

async function findWorkspaceFolder(): Promise<string> {
  let currentPath = path.resolve(process.cwd());
  const root = path.parse(currentPath).root;
  while (currentPath !== root) {
    if (path.basename(currentPath) === 'workspace') {
      return currentPath;
    }
    const sub = path.join(currentPath, 'workspace');
    try { 
      if ((await fs.stat(sub)).isDirectory()) {
        return sub;
      }
    } catch {}
    currentPath = path.dirname(currentPath);
  }
  const fallback = path.join(os.homedir(), '.openclaw', 'workspace');
  await fs.mkdir(fallback, { recursive: true });
  return fallback;
}

export const downloadVideoTool = {
  name: "download_video",
  label: "Download Video",
  description: "Downloads video to workspace using absolute paths for the URL.",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "URL to download" },
      quality: { 
        type: "string", 
        description: "Examples: '1080', '720', 'best', 'worst'",
        default: "1080" 
      }
    },
    required: ["url"]
  },
  execute: async (toolCallId: string, params: unknown, signal?: AbortSignal, onUpdate?: AgentToolUpdateCallback<unknown>): Promise<AgentToolResult<unknown>> => {
    try {
      await ensureFfmpeg();
      const ytDlpPath = await ensureYtDlp();
      const workspaceRoot = await findWorkspaceFolder();

      const typedParams = params as Record<string, unknown>;
      let formatSelector = "best[height<=1080]";
      if (typedParams.quality === "720") {
        formatSelector = "best[height<=720]";
      } else if (typedParams.quality === "best") {
        formatSelector = "best";
      } else if (typedParams.quality === "worst") {
        formatSelector = "worst";
      } else if (typedParams.quality && typeof typedParams.quality === "string" && typedParams.quality.includes("[")) {
        formatSelector = typedParams.quality;
      }

      // FIXED: Pass signal to abort title fetch on cancellation
      const { stdout: rawTitle } = await execFileAsync(
        ytDlpPath, 
        ['--get-title', typedParams.url as string],
        { signal }
      );
      
      const sanitized = rawTitle.trim().replace(/[^a-zA-Z0-9]/g, '_').substring(0, 50);
      const outputTemplate = `${sanitized}.%(ext)s`;

      if (onUpdate) {
          const qualityStr = typeof typedParams.quality === 'string' ? typedParams.quality : '1080';
          onUpdate({
            content: [{ type: "text", text: `Downloading in ${qualityStr}p...` }],
            details: { status: "downloading", quality: qualityStr }
          });
      }

      // FIXED: 
      // 1. Added --quiet --no-progress to suppress verbose output and prevent buffer exhaustion
      // 2. Added --print filename to capture exact output path for deterministic resolution
      // 3. Added maxBuffer: 100MB as safety margin for edge cases
      // 4. Added signal to abort download on cancellation
      const { stdout: ytDlpOutput } = await execFileAsync(ytDlpPath, [
        '-f', formatSelector,
        '--no-playlist',
        '--restrict-filenames',
        '--force-overwrites',
        '--quiet',
        '--no-progress',
        '-o', outputTemplate,
        '--print', 'filename',
        typedParams.url as string
      ], { 
        cwd: workspaceRoot, 
        timeout: 300000,
        maxBuffer: 100 * 1024 * 1024,  // 100MB buffer to prevent exhaustion
        signal  // FIXED: Pass the abort signal to terminate the subprocess on cancellation
      });

      // FIXED: Use exact filename from yt-dlp instead of ambiguous prefix matching
      let downloadedFile = ytDlpOutput?.trim();

      // Fallback: only if --print failed, scan directory with mtime-based preference
      if (!downloadedFile) {
        const files = await fs.readdir(workspaceRoot);
        const fileStats = await Promise.all(
          files
            .filter(f => f.startsWith(sanitized) && !f.endsWith('.part'))
            .map(async f => ({ name: f, stat: await fs.stat(path.join(workspaceRoot, f)) }))
        );
        fileStats.sort((a, b) => b.stat.mtime.getTime() - a.stat.mtime.getTime());
        downloadedFile = fileStats[0]?.name;
      }

      if (!downloadedFile) {
        throw new Error("Verification failed: could not determine downloaded filename.");
      }

      const finalPath = path.join(workspaceRoot, downloadedFile);
      const stats = await fs.stat(finalPath);
      
      // Fixed: Removes leading slash to avoid http://localhost:18791//home/...
      const cleanPath = finalPath.startsWith('/') ? finalPath.substring(1) : finalPath;
      const fileUrl = `http://localhost:${MEDIA_SERVER_PORT}/${cleanPath}`;

      return {
        content: [{
          type: "text",
          text: `✅ **Download Success**\nURL: ${fileUrl}\nFile: ${downloadedFile}\nSize: ${(stats.size / 1e6).toFixed(2)} MB`
        }],
        details: { 
          status: "complete",
          filename: downloadedFile, 
          mediaUrl: fileUrl, 
          fullPath: finalPath,
          sizeMB: (stats.size / 1e6).toFixed(2) 
        }
      };
    } catch (err: unknown) {
      const error = err as Error;
      
      // FIXED: Handle abort signal cancellation gracefully
      if (error.name === 'AbortError') {
        return {
          content: [{ type: "text", text: `⚠️ Download cancelled` }],
          details: { error: 'Download cancelled by user', status: "cancelled" }
        };
      }
      
      return {
        content: [{ type: "text", text: `❌ Error: ${error.message}` }],
        details: { error: error.message, status: "failed" }
      };
    }
  }
};