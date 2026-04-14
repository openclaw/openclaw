import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import { createWriteStream } from 'fs';
import path from 'path';
import os from 'os';
import https from 'https';
import crypto from 'crypto';
import type { AgentToolResult, AgentToolUpdateCallback } from '@mariozechner/pi-agent-core';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

const MEDIA_SERVER_PORT = 18791;

const YTDLP_URLS: Record<string, string> = {
  linux: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp',
  darwin: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos',
  win32: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
};

const YTDLP_CHECKSUM_FILES: Record<string, string> = {
  linux: 'yt-dlp',
  darwin: 'yt-dlp_macos',
  win32: 'yt-dlp.exe'
};

const CHECKSUMS_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/SHA2-256SUMS';

/**
 * Downloads text content from URL with redirect following
 */
async function downloadTextContent(url: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    
    const abortHandler = () => {
      reject(new DOMException('The operation was aborted', 'AbortError'));
    };
    
    signal?.addEventListener('abort', abortHandler);
    
    function doGet(currentUrl: string, redirectsLeft: number): void {
      if (signal?.aborted) {
        return reject(new DOMException('The operation was aborted', 'AbortError'));
      }
      
      if (redirectsLeft <= 0) {
        signal?.removeEventListener('abort', abortHandler);
        return reject(new Error(`Too many redirects: ${url}`));
      }

      https.get(currentUrl, (response) => {
        if ((response.statusCode === 301 || response.statusCode === 302) && response.headers.location) {
          response.resume();
          return doGet(response.headers.location, redirectsLeft - 1);
        }

        if (response.statusCode !== 200) {
          response.resume();
          signal?.removeEventListener('abort', abortHandler);
          return reject(new Error(`HTTP ${response.statusCode} downloading checksums`));
        }

        const chunks: Buffer[] = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          signal?.removeEventListener('abort', abortHandler);
          resolve(Buffer.concat(chunks).toString('utf-8'));
        });
        response.on('error', (err) => {
          signal?.removeEventListener('abort', abortHandler);
          reject(err);
        });
      }).on('error', (err) => {
        signal?.removeEventListener('abort', abortHandler);
        reject(err);
      });
    }
    doGet(url, 10);
  });
}

/**
 * Parses SHA256SUMS file and extracts hash for specific platform
 */
function parseChecksumFromContent(content: string, platformFile: string): string | null {
  const lines = content.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    
    const parts = trimmed.split(/\s+/);
    if (parts.length >= 2) {
      const [hash, ...filenameParts] = parts;
      const filename = filenameParts.join(' ');
      if (filename === platformFile) {
        return hash;
      }
    }
  }
  return null;
}

/**
 * Fetches and returns the expected checksum for current platform
 */
async function getExpectedChecksum(signal?: AbortSignal): Promise<string> {
  try {
    const checksumsContent = await downloadTextContent(CHECKSUMS_URL, signal);
    const platformFile = YTDLP_CHECKSUM_FILES[process.platform];
    
    if (!platformFile) {
      throw new Error(`Unsupported platform: ${process.platform}`);
    }
    
    const expectedHash = parseChecksumFromContent(checksumsContent, platformFile);
    if (!expectedHash) {
      throw new Error(`Could not find checksum for ${platformFile} in SHA2-256SUMS`);
    }
    
    return expectedHash;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw error;
    }
    throw new Error(`Failed to fetch checksums: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Verifies file integrity using SHA256
 */
async function verifyFileChecksum(filePath: string, expectedHash: string): Promise<boolean> {
  try {
    const fileBuffer = await fs.readFile(filePath);
    const hash = crypto.createHash('sha256');
    hash.update(fileBuffer);
    const actualHash = hash.digest('hex');
    return actualHash === expectedHash;
  } catch (error) {
    return false;
  }
}

/**
 * Downloads binary file with redirect following and checksum verification
 */
async function downloadFileWithVerification(
  url: string, 
  dest: string, 
  expectedHash: string, 
  signal?: AbortSignal
): Promise<void> {
  const tempDest = `${dest}.tmp`;
  
  signal?.throwIfAborted();
  
  try {
    await new Promise((resolve, reject) => {
      const abortHandler = () => {
        reject(new DOMException('The operation was aborted', 'AbortError'));
      };
      
      signal?.addEventListener('abort', abortHandler);
      
      function doGet(currentUrl: string, redirectsLeft: number): void {
        if (signal?.aborted) {
          return reject(new DOMException('The operation was aborted', 'AbortError'));
        }
        
        if (redirectsLeft <= 0) {
          signal?.removeEventListener('abort', abortHandler);
          return reject(new Error(`Too many redirects: ${url}`));
        }

        https.get(currentUrl, (response) => {
          if ((response.statusCode === 301 || response.statusCode === 302) && response.headers.location) {
            response.resume();
            return doGet(response.headers.location, redirectsLeft - 1);
          }

          if (response.statusCode !== 200) {
            response.resume();
            signal?.removeEventListener('abort', abortHandler);
            return reject(new Error(`HTTP ${response.statusCode} downloading binary`));
          }

          const file = createWriteStream(tempDest);
          const hash = crypto.createHash('sha256');
          
          response.on('data', (chunk) => hash.update(chunk));
          response.pipe(file);

          file.on('error', (err) => {
            file.close();
            signal?.removeEventListener('abort', abortHandler);
            reject(err);
          });

          file.on('close', async () => {
            signal?.removeEventListener('abort', abortHandler);
            
            const actualHash = hash.digest('hex');
            if (actualHash !== expectedHash) {
              await fs.unlink(tempDest).catch(() => {});
              reject(new Error(`Checksum verification failed.\nExpected: ${expectedHash}\nGot: ${actualHash}`));
              return;
            }
            
            // Move temp file to final destination
            await fs.rename(tempDest, dest);
            
            if (process.platform !== 'win32') {
              await fs.chmod(dest, 0o755);
            }
            resolve(undefined);
          });
        }).on('error', (err) => {
          signal?.removeEventListener('abort', abortHandler);
          reject(err);
        });
      }
      doGet(url, 10);
    });
  } catch (error) {
    // Clean up temp file on error
    await fs.unlink(tempDest).catch(() => {});
    throw error;
  }
}

async function getYtDlpPath(): Promise<string> {
  const baseDir = path.join(os.homedir(), '.openclaw', 'bin');
  await fs.mkdir(baseDir, { recursive: true });
  return path.join(baseDir, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
}

async function ensureYtDlp(signal?: AbortSignal): Promise<string> {
  const ytDlpPath = await getYtDlpPath();
  
  // Check for cancellation before starting
  signal?.throwIfAborted();
  
  try {
    // First, try to use existing binary
    await execFileAsync(ytDlpPath, ['--version'], { signal });
    
    // Verify integrity of existing binary
    try {
      const expectedHash = await getExpectedChecksum(signal);
      const isValid = await verifyFileChecksum(ytDlpPath, expectedHash);
      if (!isValid) {
        console.warn('Existing yt-dlp binary failed integrity check, will re-download');
        throw new Error('Integrity check failed');
      }
    } catch (checksumError) {
      // If we can't verify (network issue, etc), assume existing binary is fine
      // but log warning
      console.warn('Could not verify existing yt-dlp binary:', checksumError);
    }
    
    return ytDlpPath;
  } catch (error) {
    // Check if we were cancelled
    signal?.throwIfAborted();
    
    // Binary missing, corrupted, or failed verification - download fresh copy
    const url = YTDLP_URLS[process.platform];
    if (!url) {
      throw new Error(`Unsupported platform: ${process.platform}`);
    }
    
    console.log('Downloading fresh yt-dlp binary...');
    
    // Fetch expected checksum from official source
    const expectedHash = await getExpectedChecksum(signal);
    console.log(`Expected SHA256: ${expectedHash}`);
    
    // Download and verify with cancellation support
    await downloadFileWithVerification(url, ytDlpPath, expectedHash, signal);
    
    // Final verification
    const isValid = await verifyFileChecksum(ytDlpPath, expectedHash);
    if (!isValid) {
      throw new Error('Downloaded yt-dlp binary failed final integrity check');
    }
    
    console.log('yt-dlp binary downloaded and verified successfully');
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
      const ytDlpPath = await ensureYtDlp(signal);
      const workspaceRoot = await findWorkspaceFolder();

      const typedParams = params as Record<string, unknown>;
      let formatSelector = "bestvideo[height<=1080]+bestaudio/best[height<=1080]";
      if (typedParams.quality === "720") {
          formatSelector = "bestvideo[height<=720]+bestaudio/best[height<=720]";
      } else if (typedParams.quality === "best") {
          formatSelector = "bestvideo+bestaudio/best";
      } else if (typedParams.quality === "worst") {
          formatSelector = "worstvideo+worstaudio/worst";
      } else if (typedParams.quality && typeof typedParams.quality === "string" && typedParams.quality.includes("[")) {
          // If it's a custom format string, assume the user knows what they're doing
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
        const matchingFiles = files.filter(f => {
          // Skip temp files
          if (f.endsWith('.part') || f.endsWith('.ytdl')) return false;
          
          // Try the original sanitized match
          if (f.includes(sanitized)) return true;
          
          // When --restrict-filenames is used, non-ASCII chars are normalized to ASCII
          // e.g., "café" becomes "cafe", "こんにちは" becomes something like "konnitiha"
          const asciiNormalized = f.normalize('NFKD')
            .replace(/[\u0300-\u036f]/g, '') // Remove diacritics
            .replace(/[^\x00-\x7F]/g, '');    // Remove remaining non-ASCII
          
          // Check if the normalized filename matches or contains timestamp-like patterns
          return asciiNormalized.length > 0 && 
                 (f.includes(asciiNormalized) || 
                  /video_.*\d{13}/.test(f));   // Fallback for our generated names
        });
        
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