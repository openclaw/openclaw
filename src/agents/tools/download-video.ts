import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import { createWriteStream } from 'fs';
import path from 'path';
import os from 'os';
import https from 'https';
import http from 'http'; // Added missing import
import { ClientRequest } from 'http';
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
 * FIX: Proper abort handling with AbortController
 */
async function downloadTextContent(url: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    
    let currentRequest: ClientRequest | null = null;
    let currentResponse: http.IncomingMessage | null = null;
    
    const cleanup = () => {
      if (currentResponse) {
        currentResponse.destroy();
        currentResponse = null;
      }
      if (currentRequest) {
        currentRequest.destroy();
        currentRequest = null;
      }
    };
    
    const abortHandler = () => {
      cleanup();
      reject(new DOMException('The operation was aborted', 'AbortError'));
    };
    
    signal?.addEventListener('abort', abortHandler, { once: true });
    
    function doGet(currentUrl: string, redirectsLeft: number): void {
      if (signal?.aborted) {
        cleanup();
        return reject(new DOMException('The operation was aborted', 'AbortError'));
      }
      
      if (redirectsLeft <= 0) {
        signal?.removeEventListener('abort', abortHandler);
        return reject(new Error(`Too many redirects: ${url}`));
      }

      currentRequest = https.get(currentUrl, (response) => {
        currentResponse = response;
        
        if ((response.statusCode === 301 || response.statusCode === 302) && response.headers.location) {
          const redirectUrl = response.headers.location;
          response.resume();
          response.destroy();
          return doGet(redirectUrl, redirectsLeft - 1);
        }

        if (response.statusCode !== 200) {
          response.resume();
          response.destroy();
          signal?.removeEventListener('abort', abortHandler);
          return reject(new Error(`HTTP ${response.statusCode} downloading checksums`));
        }

        const chunks: Buffer[] = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          signal?.removeEventListener('abort', abortHandler);
          currentRequest = null;
          currentResponse = null;
          resolve(Buffer.concat(chunks).toString('utf-8'));
        });
        response.on('error', (err) => {
          cleanup();
          signal?.removeEventListener('abort', abortHandler);
          reject(err);
        });
      }).on('error', (err) => {
        cleanup();
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
 * FIX: Robust abort handling that properly terminates all resources
 */
async function downloadFileWithVerification(
  url: string, 
  dest: string, 
  expectedHash: string, 
  signal?: AbortSignal
): Promise<void> {
  const tempDest = `${dest}.tmp`;
  
  signal?.throwIfAborted();
  
  // Create internal AbortController that can be triggered by external signal
  const abortController = new AbortController();
  
  // Link external signal to internal controller
  if (signal) {
    if (signal.aborted) {
      abortController.abort();
    } else {
      signal.addEventListener('abort', () => abortController.abort(), { once: true });
    }
  }
  
  const combinedSignal = abortController.signal;
  
  try {
    await new Promise<void>((resolve, reject) => {
      let currentRequest: ClientRequest | null = null;
      let currentResponse: http.IncomingMessage | null = null;
      let currentFileStream: ReturnType<typeof createWriteStream> | null = null;
      
      const cleanup = () => {
        // Clean up file stream
        if (currentFileStream) {
          currentFileStream.destroy();
          currentFileStream = null;
        }
        // Clean up response
        if (currentResponse) {
          currentResponse.destroy();
          currentResponse = null;
        }
        // Clean up request
        if (currentRequest) {
          currentRequest.destroy();
          currentRequest = null;
        }
      };
      
      const abortHandler = () => {
        cleanup();
        reject(new DOMException('The operation was aborted', 'AbortError'));
      };
      
      combinedSignal.addEventListener('abort', abortHandler, { once: true });
      
      function doGet(currentUrl: string, redirectsLeft: number): void {
        if (combinedSignal.aborted) {
          cleanup();
          return reject(new DOMException('The operation was aborted', 'AbortError'));
        }
        
        if (redirectsLeft <= 0) {
          combinedSignal.removeEventListener('abort', abortHandler);
          return reject(new Error(`Too many redirects: ${url}`));
        }

        currentRequest = https.get(currentUrl, (response) => {
          currentResponse = response;
          
          if ((response.statusCode === 301 || response.statusCode === 302) && response.headers.location) {
            const redirectUrl = response.headers.location;
            response.resume();
            response.destroy();
            currentResponse = null;
            return doGet(redirectUrl, redirectsLeft - 1);
          }

          if (response.statusCode !== 200) {
            response.resume();
            response.destroy();
            combinedSignal.removeEventListener('abort', abortHandler);
            return reject(new Error(`HTTP ${response.statusCode} downloading binary`));
          }

          const file = createWriteStream(tempDest);
          currentFileStream = file;
          const hash = crypto.createHash('sha256');
          
          response.on('data', (chunk) => hash.update(chunk));
          response.pipe(file);

          file.on('error', (err) => {
            cleanup();
            combinedSignal.removeEventListener('abort', abortHandler);
            reject(err);
          });

          file.on('close', async () => {
            combinedSignal.removeEventListener('abort', abortHandler);
            
            // Check if we were aborted during file writing
            if (combinedSignal.aborted) {
              await fs.unlink(tempDest).catch(() => {});
              return;
            }
            
            try {
              const actualHash = hash.digest('hex');
              if (actualHash !== expectedHash) {
                await fs.unlink(tempDest).catch(() => {});
                reject(new Error(`Checksum verification failed.\nExpected: ${expectedHash}\nGot: ${actualHash}`));
                return;
              }
              
              try {
                await fs.rename(tempDest, dest);
              } catch (renameError) {
                await fs.unlink(tempDest).catch(() => {});
                reject(new Error(`Failed to rename temp file: ${renameError instanceof Error ? renameError.message : 'Unknown error'}`));
                return;
              }
              
              if (process.platform !== 'win32') {
                try {
                  await fs.chmod(dest, 0o755);
                } catch (chmodError) {
                  console.warn(`Warning: Could not set executable permissions on ${dest}:`, chmodError);
                }
              }
              
              currentRequest = null;
              currentResponse = null;
              currentFileStream = null;
              resolve(undefined);
            } catch (error) {
              await fs.unlink(tempDest).catch(() => {});
              reject(error);
            }
          });
        }).on('error', (err) => {
          cleanup();
          combinedSignal.removeEventListener('abort', abortHandler);
          reject(err);
        });
      }
      doGet(url, 10);
    });
  } catch (error) {
    // Always clean up temp file on error or abort
    await fs.unlink(tempDest).catch(() => {});
    throw error;
  } finally {
    // Clean up the abort controller
    if (!abortController.signal.aborted) {
      abortController.abort();
    }
  }
}

async function getYtDlpPath(): Promise<string> {
  const baseDir = path.join(os.homedir(), '.openclaw', 'bin');
  await fs.mkdir(baseDir, { recursive: true });
  return path.join(baseDir, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
}

async function ensureYtDlp(signal?: AbortSignal): Promise<string> {
  const ytDlpPath = await getYtDlpPath();
  
  signal?.throwIfAborted();
  
  // Create a child process that can be killed on abort
  const abortController = new AbortController();
  if (signal) {
    if (signal.aborted) {
      abortController.abort();
    } else {
      signal.addEventListener('abort', () => abortController.abort(), { once: true });
    }
  }
  
  try {
    await execFileAsync(ytDlpPath, ['--version'], { signal: abortController.signal });
    
    let integrityCheckPassed = false;
    try {
      const expectedHash = await getExpectedChecksum(signal);
      const isValid = await verifyFileChecksum(ytDlpPath, expectedHash);
      if (!isValid) {
        console.warn('Existing yt-dlp binary failed integrity check, will re-download');
        integrityCheckPassed = false;
      } else {
        integrityCheckPassed = true;
      }
    } catch (checksumError) {
      console.warn('Could not verify existing yt-dlp binary (network/parsing issue):', checksumError);
      // FIX #2: Fail closed - don't trust unverified binary
      integrityCheckPassed = false;
    }
    
    if (!integrityCheckPassed) {
      throw new Error('Integrity check failed or unverifiable - need fresh download');
    }
    
    return ytDlpPath;
  } catch (error) {
    signal?.throwIfAborted();
    
    const url = YTDLP_URLS[process.platform];
    if (!url) {
      throw new Error(`Unsupported platform: ${process.platform}`);
    }
    
    console.log('Downloading fresh yt-dlp binary...');
    
    const expectedHash = await getExpectedChecksum(signal);
    console.log(`Expected SHA256: ${expectedHash}`);
    
    await downloadFileWithVerification(url, ytDlpPath, expectedHash, signal);
    
    const isValid = await verifyFileChecksum(ytDlpPath, expectedHash);
    if (!isValid) {
      throw new Error('Downloaded yt-dlp binary failed final integrity check');
    }
    
    console.log('yt-dlp binary downloaded and verified successfully');
    return ytDlpPath;
  } finally {
    if (!abortController.signal.aborted) {
      abortController.abort();
    }
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
  
  while (currentPath !== root) {
    const parent = path.dirname(currentPath);
    
    if (path.basename(parent) === 'workspace') {
      return currentPath;
    }
    
    const workspaceDir = path.join(currentPath, 'workspace');
    try {
      if ((await fs.stat(workspaceDir)).isDirectory()) {
        return workspaceDir;
      }
    } catch {}
    
    currentPath = parent;
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
    // Create a child process controller that can properly kill yt-dlp
    const abortController = new AbortController();
    
    try {
      // Link external signal to internal controller
      if (signal) {
        if (signal.aborted) {
          abortController.abort();
        } else {
          signal.addEventListener('abort', () => {
            abortController.abort();
          }, { once: true });
        }
      }
      
      await ensureFfmpeg();
      const ytDlpPath = await ensureYtDlp(abortController.signal);
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
          formatSelector = typedParams.quality;
      }

      const { stdout: rawTitle } = await execFileAsync(
        ytDlpPath, 
        ['--get-title', '--no-playlist', typedParams.url as string],
        { signal: abortController.signal }
      );
      
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
        signal: abortController.signal
      });

      await new Promise(resolve => setTimeout(resolve, 100));

      const lines = ytDlpOutput?.split('\n').filter(Boolean);
      let downloadedFile = lines?.[lines.length - 1]?.trim();
      
      if (!downloadedFile || !downloadedFile.includes(sanitized)) {
        const files = await fs.readdir(workspaceRoot);
        
        const asciiNormalizedTitle = sanitized.normalize('NFKD')
          .replace(/[\u0300-\u036f]/g, '')
          .replace(/[^\x00-\x7F]/g, '');
        
        const matchingFiles = files.filter(f => {
          if (f.endsWith('.part') || f.endsWith('.ytdl')) return false;
          if (f.includes(sanitized)) return true;
          
          const normalizedFilename = f.normalize('NFKD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/[^\x00-\x7F]/g, '');
          
          return asciiNormalizedTitle.length > 0 && 
                 (normalizedFilename.includes(asciiNormalizedTitle) || 
                  /video_.*\d{13}/.test(f));
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
        downloadedFile = path.basename(downloadedFile);
      }

      if (!downloadedFile) {
        throw new Error("Download completed but file not found in workspace");
      }

      const finalPath = path.join(workspaceRoot, downloadedFile);
      
      try {
        const stats = await fs.stat(finalPath);
        if (stats.size === 0) {
          throw new Error("Downloaded file is empty");
        }
        
        // FIX #3: Properly encode path for URL
        const relativePath = path.relative(workspaceRoot, finalPath);
        const posixPath = relativePath.split(path.sep).join('/');
        const encodedPath = posixPath.split('/').map(encodeURIComponent).join('/');
        const fileUrl = `http://localhost:${MEDIA_SERVER_PORT}/${encodedPath}`;

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
    } finally {
      // Always clean up the abort controller
      if (!abortController.signal.aborted) {
        abortController.abort();
      }
    }
  }
};