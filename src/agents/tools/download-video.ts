import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import https from 'https';
import { createWriteStream } from 'fs';
import type { AgentToolResult, AgentToolUpdateCallback } from '@mariozechner/pi-agent-core';

const execAsync = promisify(exec);

// Platform-specific yt-dlp binary URLs
const YTDLP_URLS = {
  linux: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp',
  macos: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos',
  win32: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
};

async function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(dest);
    https.get(url, (response) => {
      response.pipe(file);
      file.on('finish', () => {
        file.close();
        if (process.platform !== 'win32') {
          fs.chmod(dest, 0o755);
        }
        resolve();
      });
    }).on('error', reject);
  });
}

async function getYtDlpPath(): Promise<string> {
  const baseDir = path.join(os.homedir(), '.openclaw', 'bin');
  await fs.mkdir(baseDir, { recursive: true });
  return path.join(baseDir, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
}

async function checkYtDlpVersion(ytDlpPath: string): Promise<string | null> {
  try {
    const { stdout } = await execAsync(`"${ytDlpPath}" --version`);
    return stdout.trim();
  } catch {
    return null;
  }
}

async function installYtDlp(): Promise<void> {
  const ytDlpPath = await getYtDlpPath();
  const platform = process.platform as keyof typeof YTDLP_URLS;
  const url = YTDLP_URLS[platform];
  
  if (!url) {
    throw new Error(`Unsupported platform: ${platform}`);
  }
  
  console.log(`📥 Installing yt-dlp to ${ytDlpPath}...`);
  await downloadFile(url, ytDlpPath);
  console.log('✅ yt-dlp installed successfully');
}

async function ensureYtDlp(): Promise<string> {
  const ytDlpPath = await getYtDlpPath();
  const version = await checkYtDlpVersion(ytDlpPath);
  
  if (!version) {
    await installYtDlp();
  } else {
    console.log(`📦 yt-dlp version ${version} found`);
  }
  
  return ytDlpPath;
}

async function checkFfmpeg(): Promise<boolean> {
  try {
    await execAsync('ffmpeg -version');
    return true;
  } catch {
    return false;
  }
}

async function installFfmpegLinux(): Promise<void> {
  console.log('📥 Installing ffmpeg via apt...');
  
  try {
    await execAsync('sudo apt-get update -qq');
    await execAsync('sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ffmpeg');
    console.log('✅ ffmpeg installed successfully');
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error('❌ Failed to install ffmpeg automatically:', errorMessage);
    throw new Error(
      'ffmpeg is required but could not be installed automatically.\n' +
      'Please run manually: sudo apt-get install ffmpeg', { cause: err }
    );
  }
}

async function ensureFfmpeg(): Promise<void> {
  const hasFfmpeg = await checkFfmpeg();
  
  if (!hasFfmpeg) {
    if (process.platform === 'linux') {
      console.log('⚠️ ffmpeg not found, attempting automatic installation...');
      await installFfmpegLinux();
    } else if (process.platform === 'darwin') {
      throw new Error(
        'ffmpeg is required but not installed.\n' +
        'Please run: brew install ffmpeg'
      );
    } else if (process.platform === 'win32') {
      throw new Error(
        'ffmpeg is required but not installed.\n' +
        'Please install from: https://ffmpeg.org/download.html\n' +
        'Or using chocolatey: choco install ffmpeg'
      );
    }
  } else {
    console.log('✅ ffmpeg is installed');
  }
}

// Get video title from URL without downloading the whole video
async function getVideoTitle(url: string, ytDlpPath: string): Promise<string> {
  try {
    const { stdout } = await execAsync(`"${ytDlpPath}" --get-title "${url}"`);
    const title = stdout.trim();
    // Sanitize filename (remove invalid characters)
    let sanitized = title
      .replace(/[<>:"/\\|?*]/g, '')  // Remove invalid filename chars
      .replace(/\s+/g, '_')           // Replace spaces with underscores
      .substring(0, 100);             // Limit length
    
    // Remove common suffixes that make filenames too long
    sanitized = sanitized.replace(/_-_YouTube$|_-_YouTube_Music$|_-_YouTube_$/, '');
    
    return sanitized || `video_${Date.now()}`;
  } catch {
    return `video_${Date.now()}`;
  }
}

async function downloadVideo(url: string, outputPath: string, ytDlpPath: string, quality: string): Promise<void> {
  // Ensure the directory exists
  const outputDir = path.dirname(outputPath);
  await fs.mkdir(outputDir, { recursive: true });
  
  // Check if file already exists
  try {
    await fs.access(outputPath);
    console.log(`📁 File already exists: ${outputPath}`);
    return;
  } catch {
    // File doesn't exist, proceed
  }
  
  console.log(`📥 Downloading video from ${url}...`);
  console.log(`📁 Output path: ${outputPath}`);
  
  try {
    // Use absolute path and force the output location
    const absoluteOutputPath = path.resolve(outputPath);
    await execAsync(`"${ytDlpPath}" -f "${quality}" -o "${absoluteOutputPath}" "${url}"`, {
      timeout: 300000,
      cwd: path.dirname(absoluteOutputPath)  // Force working directory to target folder
    });
    console.log(`✅ Video downloaded to ${absoluteOutputPath}`);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error('❌ Download failed:', errorMessage);
    throw new Error(`Failed to download video: ${errorMessage}`, { cause: err });
  }
}

export const downloadVideoTool = {
  name: "download_video",
  label: "Download Video",
  description: "Download a video from YouTube, Vimeo, Twitch, etc. to the workspace. Automatically installs yt-dlp and ffmpeg if missing (Linux only).",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "The video URL to download" },
      quality: { 
        type: "string", 
        description: "Quality: 'best', 'best[height<=720]', 'worst'",
        default: "best[height<=720]"
      }
    },
    required: ["url"]
  },
  execute: async (toolCallId: string, params: any, signal?: AbortSignal, onUpdate?: AgentToolUpdateCallback<unknown>): Promise<AgentToolResult<unknown>> => {
    try {
      await ensureFfmpeg();
      const ytDlpPath = await ensureYtDlp();
      
      const quality = params.quality || "best[height<=720]";
      
      // Get the video title for a readable filename
      let videoTitle = await getVideoTitle(params.url, ytDlpPath);
      
      // FORCE the correct workspace path
      const workspaceRoot = '/home/jeffc/.openclaw/workspace';
      let finalPath = path.join(workspaceRoot, `${videoTitle}.mp4`);
      
      // Handle duplicate filenames by adding a number suffix
      let counter = 1;
      while (true) {
        try {
          await fs.access(finalPath);
          finalPath = path.join(workspaceRoot, `${videoTitle}_${counter}.mp4`);
          counter++;
        } catch {
          break;
        }
      }
      
      // Ensure the workspace directory exists
      await fs.mkdir(workspaceRoot, { recursive: true });
      
      // Download the video
      await downloadVideo(params.url, finalPath, ytDlpPath, quality);
      
      const stats = await fs.stat(finalPath);
      const filename = path.basename(finalPath);
      const fileUrl = `http://localhost:18791/${encodeURIComponent(filename)}`;
      
      return {
        content: [{
          type: "text",
          text: `<video controls src="${fileUrl}" width="854" height="480" style="max-width: 100%;"></video>`
        }],
        details: {
          originalUrl: params.url,
          downloadedTo: finalPath,
          filename: filename,
          quality: quality,
          size: stats.size
        }
      };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      return {
        content: [{
          type: "text",
          text: `❌ Failed to download video: ${errorMessage}`
        }],
        details: null
      };
    }
  }
};
