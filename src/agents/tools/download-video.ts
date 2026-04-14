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
    throw new Error(`ffmpeg is required for merging video/audio but was not found in the system PATH. Please install ffmpeg and ensure it's available in your PATH.`);
  }
}

async function findWorkspaceFolder(): Promise<string> {
  let currentPath = path.resolve(process.cwd());
  const root = path.parse(currentPath).root;
  
  // First, check if we're already in a workspace subdirectory
  while (currentPath !== root) {
    const parent = path.dirname(currentPath);
    
    // Check if parent is a workspace directory
    if (path.basename(parent) === 'workspace') {
      return currentPath; // Return the actual working directory under workspace
    }
    
    // Check for workspace directory in current path
    const workspaceDir = path.join(currentPath, 'workspace');
    try {
      if ((await fs.stat(workspaceDir)).isDirectory()) {
        return workspaceDir;
      }
    } catch {}
    
    currentPath = parent;
  }
  
  // Fallback to a workspace-relative path
  const fallback = path.join(os.homedir(), '.openclaw', 'workspace', 'default');
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

      // Get title first (without creating file)
      const { stdout: rawTitle } = await execFileAsync(
        ytDlpPath, 
        ['--get-title', '--no-playlist', typedParams.url as string],
        { signal }
      );
      
      // Create sanitized filename with fallback for non-ASCII titles
      let sanitized = rawTitle.trim()
        .replace(/[^a-zA-Z0-9\s]/g, '')
        .replace(/\s+/g, '_')
        .substring(0, 50);
      
      if (!sanitized) {
        sanitized = rawTitle.trim()
          .replace(/[^\p{L}\p{N}\s]/gu, '')
          .replace(/\s+/g, '_')
          .substring(0, 50);
      }
      
      if (!sanitized) {
        sanitized = `video_${Date.now()}`;
      }
      
      const outputTemplate = `${sanitized}.%(ext)s`;

      if (onUpdate) {
          const qualityStr = typeof typedParams.quality === 'string' ? typedParams.quality : '1080';
          onUpdate({
            content: [{ type: "text", text: `Starting download in ${qualityStr}p...` }],
            details: { status: "downloading", quality: qualityStr }
          });
      }

      // Download and capture the actual filename
      const { stdout: ytDlpOutput } = await execFileAsync(ytDlpPath, [
        '-f', formatSelector,
        '--no-playlist',
        '--restrict-filenames',
        '--force-overwrites',
        '--quiet',
        '--no-progress',
        '-o', outputTemplate,
        '--print', 'after_move:filepath',
        typedParams.url as string
      ], { 
        cwd: workspaceRoot, 
        timeout: 300000,
        maxBuffer: 100 * 1024 * 1024,
        signal
      });

      // Wait a moment for file system to sync
      await new Promise(resolve => setTimeout(resolve, 100));

      // Get the actual filename from output or scan directory
      const lines = ytDlpOutput?.split('\n').filter(Boolean);
      let downloadedFile = lines?.[lines.length - 1]?.trim();
      
      if (!downloadedFile || !downloadedFile.includes(sanitized)) {
        // Fallback: scan directory for the most recent matching file
        const files = await fs.readdir(workspaceRoot);
        const matchingFiles = files.filter(f => 
          f.includes(sanitized) && 
          !f.endsWith('.part') && 
          !f.endsWith('.ytdl')
        );
        
        if (matchingFiles.length > 0) {
          const fileStats = await Promise.all(
            matchingFiles.map(async f => ({
              name: f,
              stat: await fs.stat(path.join(workspaceRoot, f))
            }))
          );
          
          fileStats.sort((a, b) => b.stat.mtime.getTime() - a.stat.mtime.getTime());
          downloadedFile = fileStats[0]?.name;
        }
      } else {
        // Extract just the filename from the full path if needed
        downloadedFile = path.basename(downloadedFile);
      }

      if (!downloadedFile) {
        throw new Error("Download completed but file not found in workspace");
      }

      const finalPath = path.join(workspaceRoot, downloadedFile);
      
      // Verify file exists and has size > 0
      try {
        const stats = await fs.stat(finalPath);
        if (stats.size === 0) {
          throw new Error("Downloaded file is empty");
        }
        
        // Clean path for URL
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
      } catch (statError) {
        throw new Error(`File verification failed: ${finalPath} does not exist or is inaccessible`, {
          cause: statError
        });
      }
      
    } catch (err: unknown) {
      const error = err as Error;
      
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