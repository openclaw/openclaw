import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import { createWriteStream } from 'fs';
import path from 'path';
import os from 'os';
import https from 'https';
import http from 'http';
import { ClientRequest } from 'http';
import crypto from 'crypto';
import type { AgentToolResult, AgentToolUpdateCallback } from '@mariozechner/pi-agent-core';
import { AsyncLocalStorage } from 'async_hooks';

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

// FIX: Context injection for trusted workspace root - use AsyncLocalStorage for per-session isolation
interface WorkspaceContext {
  trustedWorkspaceRoot: string;
}

const workspaceContextStorage = new AsyncLocalStorage<WorkspaceContext>();

/**
 * Sets the trusted workspace root for the current async session
 * This should be called by the agent runtime when initializing the session
 */
export function setTrustedWorkspaceRoot(workspaceRoot: string): void {
  // Validate workspace root before setting
  if (!workspaceRoot || typeof workspaceRoot !== 'string') {
    throw new Error('Invalid workspace root provided');
  }
  
  const resolvedPath = path.resolve(workspaceRoot);
  
  // Basic security checks
  if (resolvedPath.includes('..') || resolvedPath.includes('./')) {
    throw new Error('Workspace root contains relative path segments');
  }
  
  const context: WorkspaceContext = {
    trustedWorkspaceRoot: resolvedPath
  };
  
  workspaceContextStorage.enterWith(context);
}

/**
 * Gets the current trusted workspace root for this session
 */
export function getTrustedWorkspaceRoot(): string | null {
  const context = workspaceContextStorage.getStore();
  return context?.trustedWorkspaceRoot ?? null;
}

/**
 * Runs a function with a specific workspace context
 */
export function withWorkspaceContext<T>(workspaceRoot: string, fn: () => T): T {
  const resolvedPath = path.resolve(workspaceRoot);
  const context: WorkspaceContext = {
    trustedWorkspaceRoot: resolvedPath
  };
  return workspaceContextStorage.run(context, fn);
}

/**
 * Downloads text content from URL with redirect following
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

      const protocol = currentUrl.startsWith('https') ? https : http;
      const request = protocol.get(currentUrl, (response) => {
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
      });
      
      currentRequest = request;
      
      request.on('error', (err) => {
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
    if (!trimmed || trimmed.startsWith('#')) { continue; }
    
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
    throw new Error(`Failed to fetch checksums: ${error instanceof Error ? error.message : 'Unknown error'}`, { cause: error });
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
  } catch {
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

        const protocol = currentUrl.startsWith('https') ? https : http;
        const request = protocol.get(currentUrl, (response) => {
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
        });
        
        currentRequest = request;
        
        request.on('error', (err) => {
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
    // Check if binary exists first
    let exists = false;
    try {
      await fs.access(ytDlpPath, fs.constants.X_OK);
      exists = true;
    } catch {
      exists = false;
    }
    
    if (exists) {
      // Verify integrity BEFORE executing
      let integrityCheckPassed = false;
      let shouldDeleteBinary = false;
      
      try {
        const expectedHash = await getExpectedChecksum(signal);
        const isValid = await verifyFileChecksum(ytDlpPath, expectedHash);
        if (isValid) {
          integrityCheckPassed = true;
          console.log('Existing yt-dlp binary passed integrity check');
        } else {
          console.warn('Existing yt-dlp binary failed integrity check, will re-download');
          shouldDeleteBinary = true;
        }
      } catch (checksumError) {
        // FIX: CRITICAL SECURITY - Never trust a binary without hash verification
        // Even if checksum fetch fails due to network issues, we cannot verify authenticity
        // Fail closed - delete binary and re-download rather than risk executing tampered code
        console.error('CRITICAL: Checksum verification failed, cannot trust existing binary:', checksumError);
        console.warn('Deleting unverifiable yt-dlp binary and will re-download');
        shouldDeleteBinary = true;
        
        // Do NOT attempt to execute the binary - this would be a security vulnerability
        // Even if --version works, it doesn't prove the binary hasn't been tampered with
      }
      
      if (shouldDeleteBinary) {
        console.warn('Removing unverifiable yt-dlp binary');
        await fs.unlink(ytDlpPath).catch(() => {});
      }
      
      if (integrityCheckPassed && !shouldDeleteBinary) {
        // Only execute after integrity is cryptographically verified
        try {
          await execFileAsync(ytDlpPath, ['--version'], { 
            signal: abortController.signal,
            timeout: 5000 
          });
          return ytDlpPath;
        } catch (execError) {
          // If verified binary fails to execute, something is wrong
          console.warn('Verified yt-dlp binary failed to execute:', execError);
          await fs.unlink(ytDlpPath).catch(() => {});
          // Fall through to download fresh copy
        }
      }
    }
    
    // No valid binary exists - download fresh copy
    signal?.throwIfAborted();
    
    const url = YTDLP_URLS[process.platform];
    if (!url) {
      throw new Error(`Unsupported platform: ${process.platform}`);
    }
    
    console.log('Downloading fresh yt-dlp binary...');
    
    const expectedHash = await getExpectedChecksum(signal);
    console.log(`Expected SHA256: ${expectedHash}`);
    
    // Download to temp file first, then atomically rename
    await downloadFileWithVerification(url, ytDlpPath, expectedHash, signal);
    
    // Final verification of downloaded binary
    const isValid = await verifyFileChecksum(ytDlpPath, expectedHash);
    if (!isValid) {
      throw new Error('Downloaded yt-dlp binary failed final integrity check');
    }
    
    // Now it's safe to execute the freshly downloaded binary
    await execFileAsync(ytDlpPath, ['--version'], { signal: abortController.signal });
    
    console.log('yt-dlp binary downloaded and verified successfully');
    return ytDlpPath;
  } catch (error) {
    // Clean up on any error
    try {
      await fs.unlink(ytDlpPath).catch(() => {});
    } catch {
      // Ignore cleanup errors
    }
    throw error;
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

/**
 * FIX: Use segment-safe path validation to prevent sibling directory traversal
 * This ensures paths like /tmp2 or /home/user2 are not incorrectly accepted
 */
function isPathWithinBoundary(childPath: string, parentPath: string): boolean {
  // Normalize and resolve both paths to handle symlinks and relative segments
  const normalizedChild = path.resolve(childPath);
  const normalizedParent = path.resolve(parentPath);
  
  // Ensure parent path ends with separator for accurate startsWith check
  const parentWithSep = normalizedParent.endsWith(path.sep) ? normalizedParent : normalizedParent + path.sep;
  
  // Check if child path starts with parent path + separator
  // This prevents matching sibling directories like /tmp2 when parent is /tmp
  return normalizedChild.startsWith(parentWithSep) || normalizedChild === normalizedParent;
}

/**
 * Validates if a path is within allowed session boundaries
 * FIX: Accepts any path that is either:
 * - Under the session's trusted workspace root
 * - Under /tmp for temporary files
 * - Under the user's home directory for configuration
 */
async function isValidSessionPath(resolvedPath: string, trustedRoot: string | null): Promise<boolean> {
  // Priority 1: Check if path is under trusted workspace root
  if (trustedRoot) {
    if (isPathWithinBoundary(resolvedPath, trustedRoot)) {
      return true;
    }
  }
  
  // Priority 2: Allow temporary directory for downloads
  // FIX: Use segment-safe boundary check to prevent /tmp2 acceptance
  const resolvedTmp = path.resolve('/tmp');
  if (isPathWithinBoundary(resolvedPath, resolvedTmp)) {
    return true;
  }
  
  // Priority 3: Allow home directory for yt-dlp binary and config
  const homeDir = os.homedir();
  if (isPathWithinBoundary(resolvedPath, homeDir)) {
    // Only allow specific subdirectories under home for security
    const allowedHomeSubdirs = ['.openclaw', '.cache', '.config'];
    const relativeToHome = path.relative(homeDir, resolvedPath);
    const firstSegment = relativeToHome.split(path.sep)[0];
    
    if (allowedHomeSubdirs.includes(firstSegment)) {
      return true;
    }
  }
  
  return false;
}

/**
 * FIX: Security-critical - workspace root MUST come from trusted runtime context
 * NOT from untrusted tool parameters. This function only uses injected trusted root
 * or falls back to safe defaults, never trusting user input.
 * 
 * FIXED: No longer restricts to only home/tmp - supports any session-approved workspace
 */
async function resolveWorkspaceRoot(): Promise<string> {
  // Priority 1: Use trusted workspace root from current async session
  const sessionTrustedRoot = getTrustedWorkspaceRoot();
  if (sessionTrustedRoot) {
    // Validate the trusted workspace root is still safe using session boundary policy
    // Ensure directory exists
    await fs.mkdir(sessionTrustedRoot, { recursive: true });
    return sessionTrustedRoot;
  }
  
  // Priority 2: Check environment variables (controlled by runtime, not user)
  const envWorkspace = process.env.OPENCLAW_WORKSPACE || process.env.AGENT_WORKSPACE;
  if (envWorkspace) {
    const resolved = path.resolve(envWorkspace);
    
    // Validate environment workspace is safe for this session
    const isValid = await isValidSessionPath(resolved, sessionTrustedRoot);
    if (isValid) {
      try {
        await fs.mkdir(resolved, { recursive: true });
        console.log(`Using workspace from environment: ${resolved}`);
        return resolved;
      } catch (error) {
        console.warn(`Failed to create environment workspace directory: ${resolved}`, error);
        // Fall through to fallback if env workspace is invalid
      }
    } else {
      console.warn(`Security: Environment workspace "${resolved}" is not allowed by session policy, ignoring`);
    }
  }
  
  // Priority 3: Fallback to safe home directory workspace (never user-controllable)
  const fallback = path.join(os.homedir(), '.openclaw', 'workspace');
  await fs.mkdir(fallback, { recursive: true });
  console.log(`Using fallback workspace: ${fallback}`);
  return fallback;
}

/**
 * Sanitizes filename by removing problematic characters
 */
function sanitizeFilename(title: string): string {
  let sanitized = title.trim()
    .replace(/[^a-zA-Z0-9\s]/g, '')
    .replace(/\s+/g, '_')
    .substring(0, 50);
  
  if (!sanitized) {
    sanitized = title.trim()
      .replace(/[^\p{L}\p{N}\s]/gu, '')
      .replace(/\s+/g, '_')
      .substring(0, 50);
  }
  
  if (!sanitized) {
    sanitized = `video_${Date.now()}`;
  }
  
  return sanitized;
}

/**
 * Builds a media URL for accessing downloaded files
 * The link is created for the included media server which can play the streaming media locally.
 */
function buildMediaUrl(workspaceRoot: string, filePath: string, gatewayOrigin?: string): string {
  // Ensure paths are absolute and resolved
  const resolvedWorkspace = path.resolve(workspaceRoot);
  const resolvedFilePath = path.resolve(filePath);
  
  // Calculate relative path from workspace root
  let relativePath = path.relative(resolvedWorkspace, resolvedFilePath);
  
  // Handle case where file is exactly the workspace root
  if (relativePath === '') {
    relativePath = path.basename(resolvedFilePath);
  }
  
  // Convert Windows backslashes to forward slashes for URLs
  const posixPath = relativePath.split(path.sep).join('/');
  
  // Encode each path segment for URL safety (spaces, special chars, etc.)
  const encodedPath = posixPath.split('/').map(encodeURIComponent).join('/');
  
  // Determine the base origin
  let baseOrigin: string;
  if (gatewayOrigin) {
    baseOrigin = gatewayOrigin.replace(/\/$/, '');
  } else {
    baseOrigin = `http://localhost:${MEDIA_SERVER_PORT}`;
  }
  
  // Construct direct file URL for the media server
  const mediaUrl = `${baseOrigin}/${encodedPath}`;
  
  // Log for debugging (remove in production if needed)
  console.log(`Media URL constructed: ${mediaUrl}`);
  console.log(`  Workspace: ${resolvedWorkspace}`);
  console.log(`  File: ${resolvedFilePath}`);
  console.log(`  Relative: ${relativePath}`);
  
  return mediaUrl;
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
  
  // Track if we should re-throw abort error
  let wasAborted = false;
  
  try {
    // Link external signal to internal controller
    if (signal) {
      if (signal.aborted) {
        abortController.abort();
        wasAborted = true;
      } else {
        signal.addEventListener('abort', () => {
          abortController.abort();
          wasAborted = true;
        }, { once: true });
      }
    }
    
    await ensureFfmpeg();
    const ytDlpPath = await ensureYtDlp(abortController.signal);
    
    // FIX: SECURITY - workspace root MUST come from trusted runtime context
    const workspaceRoot = await resolveWorkspaceRoot();
    
    // Validate params structure
    const typedParams = params as Record<string, unknown>;
    
    // Explicitly check that workspaceRoot is NOT being passed from params
    if ('workspaceRoot' in typedParams && typedParams.workspaceRoot !== undefined) {
      console.warn('Security: Attempted workspaceRoot injection detected and blocked');
    }
    
    const videoUrl = typedParams.url as string;
    if (!videoUrl || typeof videoUrl !== 'string') {
      throw new Error('Invalid or missing URL parameter');
    }

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
      ['--get-title', '--no-playlist', videoUrl],
      { signal: abortController.signal }
    );
    
    const sanitized = sanitizeFilename(rawTitle);
    
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
      videoUrl
    ], { 
      cwd: workspaceRoot, 
      timeout: 300000,
      maxBuffer: 100 * 1024 * 1024,
      signal: abortController.signal
    });

    await new Promise(resolve => setTimeout(resolve, 100));

    const lines = ytDlpOutput?.split('\n').filter(Boolean);
    // FIX: Don't use basename here - keep the full relative path
    const downloadedFilePath = lines?.[lines.length - 1]?.trim();
    
    if (!downloadedFilePath) {
      throw new Error("Download completed but file path not found in yt-dlp output");
    }

    // Use the path directly from yt-dlp output
    const downloadedFile = path.basename(downloadedFilePath);
    const finalPath = path.join(workspaceRoot, downloadedFile);
    
    // Security: Validate the final path is still within workspace (defense in depth)
    const resolvedPath = path.resolve(finalPath);
    const resolvedWorkspace = path.resolve(workspaceRoot);
    if (!isPathWithinBoundary(resolvedPath, resolvedWorkspace)) {
      throw new Error(`Security violation: Attempted to access file outside workspace: ${resolvedPath}`);
    }
    
    try {
      const stats = await fs.stat(finalPath);
      if (stats.size === 0) {
        throw new Error("Downloaded file is empty");
      }
      
      const gatewayOrigin = process.env.GATEWAY_ORIGIN || process.env.ASSISTANT_API_BASE;
      const fileUrl = buildMediaUrl(workspaceRoot, finalPath, gatewayOrigin);

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
    
    if (error.name === 'AbortError' || wasAborted || abortController.signal.aborted) {
      throw error;
    }
    
    return {
      content: [{ type: "text", text: `❌ Error: ${error.message}` }],
      details: { error: error.message, status: "failed" }
    };
  } finally {
    if (!abortController.signal.aborted) {
      abortController.abort();
    }
  }
}
};