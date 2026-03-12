/**
 * Device Control - Phase 2
 *
 * Capabilities:
 * - File operations: read, write, move, copy, rename, delete
 * - App operations: launch, close, focus window
 * - Clipboard: read, write
 * - Shell: execute commands
 * - Process: list, kill
 */

import * as fs from 'fs';
import * as path from 'path';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// ============== FILE OPERATIONS ==============

export interface FileOperationResult {
  success: boolean;
  path?: string;
  content?: string;
  error?: string;
}

export class FileControl {
  /**
   * Read file content
   */
  async read(filePath: string, encoding: BufferEncoding = 'utf-8'): Promise<FileOperationResult> {
    try {
      if (!fs.existsSync(filePath)) {
        return { success: false, error: 'File does not exist' };
      }
      const content = fs.readFileSync(filePath, encoding);
      return { success: true, path: filePath, content };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  }

  /**
   * Write content to file
   */
  async write(filePath: string, content: string): Promise<FileOperationResult> {
    try {
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(filePath, content, 'utf-8');
      return { success: true, path: filePath };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  }

  /**
   * Append content to file
   */
  async append(filePath: string, content: string): Promise<FileOperationResult> {
    try {
      fs.appendFileSync(filePath, content, 'utf-8');
      return { success: true, path: filePath };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  }

  /**
   * Delete file
   */
  async delete(filePath: string): Promise<FileOperationResult> {
    try {
      if (!fs.existsSync(filePath)) {
        return { success: false, error: 'File does not exist' };
      }
      fs.unlinkSync(filePath);
      return { success: true, path: filePath };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  }

  /**
   * Move/rename file
   */
  async move(sourcePath: string, destPath: string): Promise<FileOperationResult> {
    try {
      if (!fs.existsSync(sourcePath)) {
        return { success: false, error: 'Source file does not exist' };
      }
      const destDir = path.dirname(destPath);
      if (!fs.existsSync(destDir)) {
        fs.mkdirSync(destDir, { recursive: true });
      }
      fs.renameSync(sourcePath, destPath);
      return { success: true, path: destPath };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  }

  /**
   * Copy file
   */
  async copy(sourcePath: string, destPath: string): Promise<FileOperationResult> {
    try {
      if (!fs.existsSync(sourcePath)) {
        return { success: false, error: 'Source file does not exist' };
      }
      const destDir = path.dirname(destPath);
      if (!fs.existsSync(destDir)) {
        fs.mkdirSync(destDir, { recursive: true });
      }
      fs.copyFileSync(sourcePath, destPath);
      return { success: true, path: destPath };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  }

  /**
   * Check if file exists
   */
  exists(filePath: string): boolean {
    return fs.existsSync(filePath);
  }

  /**
   * Get file stats
   */
  async stat(filePath: string): Promise<FileOperationResult> {
    try {
      if (!fs.existsSync(filePath)) {
        return { success: false, error: 'File does not exist' };
      }
      const stats = fs.statSync(filePath);
      return {
        success: true,
        path: filePath,
        content: JSON.stringify({
          size: stats.size,
          isFile: stats.isFile(),
          isDirectory: stats.isDirectory(),
          created: stats.birthtime,
          modified: stats.mtime
        })
      };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  }

  /**
   * List directory contents
   */
  async listDir(dirPath: string): Promise<FileOperationResult> {
    try {
      if (!fs.existsSync(dirPath)) {
        return { success: false, error: 'Directory does not exist' };
      }
      const items = fs.readdirSync(dirPath);
      return {
        success: true,
        path: dirPath,
        content: JSON.stringify(items)
      };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  }
}

// ============== APP OPERATIONS ==============

export interface AppInfo {
  name: string;
  pid?: number;
  path?: string;
}

export class AppControl {
  /**
   * Launch an application
   */
  async launch(appPath: string, args: string[] = []): Promise<{ success: boolean; pid?: number; error?: string }> {
    try {
      const isWindows = process.platform === 'win32';
      const proc = spawn(appPath, args, {
        detached: !isWindows,
        stdio: 'ignore',
        shell: isWindows
      });

      proc.unref();

      return { success: true, pid: proc.pid };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  }

  /**
   * Close an application by name or PID
   */
  async close(target: string | number, force: boolean = false): Promise<{ success: boolean; error?: string }> {
    try {
      const isWindows = process.platform === 'win32';

      if (typeof target === 'number') {
        process.kill(target, force ? 'SIGKILL' : 'SIGTERM');
        return { success: true };
      }

      // Kill by name
      if (isWindows) {
        await execAsync(`taskkill /F /IM ${target}`);
      } else {
        await execAsync(`pkill -f ${target}`);
      }

      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  }

  /**
   * Get running applications
   */
  async list(): Promise<{ success: boolean; apps?: AppInfo[]; error?: string }> {
    try {
      const isWindows = process.platform === 'win32';

      if (isWindows) {
        const { stdout } = await execAsync('tasklist /FO CSV /NH');
        const apps = stdout.split('\n')
          .filter(line => line.trim())
          .slice(0, 20)
          .map(line => {
            const parts = line.split('","');
            return {
              name: parts[0]?.replace(/"/g, '') || '',
              pid: parseInt(parts[1]?.replace(/"/g, '') || '0')
            };
          });
        return { success: true, apps };
      } else {
        const { stdout } = await execAsync('ps aux | head -20');
        const lines = stdout.split('\n').slice(1);
        const apps = lines.map(line => {
          const parts = line.trim().split(/\s+/);
          return {
            name: parts[10] || '',
            pid: parseInt(parts[1] || '0')
          };
        }).filter(a => a.pid && a.name);
        return { success: true, apps };
      }
    } catch (error) {
      return { success: false, error: String(error) };
    }
  }
}

// ============== CLIPBOARD OPERATIONS ==============

export class ClipboardControl {
  /**
   * Read clipboard content
   */
  async read(): Promise<{ success: boolean; content?: string; error?: string }> {
    try {
      const isWindows = process.platform === 'win32';
      let content: string;

      if (isWindows) {
        const { stdout } = await execAsync('powershell -Command "Get-Clipboard"');
        content = stdout.trim();
      } else {
        const { stdout } = await execAsync('pbpaste');
        content = stdout.trim();
      }

      return { success: true, content };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  }

  /**
   * Write to clipboard
   */
  async write(content: string): Promise<{ success: boolean; error?: string }> {
    try {
      const isWindows = process.platform === 'win32';

      if (isWindows) {
        await execAsync(`powershell -Command "Set-Clipboard -Value '${content.replace(/'/g, "''")}'"`);
      } else {
        await execAsync(`echo '${content.replace(/'/g, "'")}' | pbcopy`);
      }

      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  }
}

// ============== PROCESS OPERATIONS ==============

export class ProcessControl {
  /**
   * Kill process by PID
   */
  async kill(pid: number, force: boolean = false): Promise<{ success: boolean; error?: string }> {
    try {
      process.kill(pid, force ? 'SIGKILL' : 'SIGTERM');
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  }

  /**
   * Get current process info
   */
  getCurrent(): { pid: number; platform: string; arch: string; cwd: string } {
    return {
      pid: process.pid,
      platform: process.platform,
      arch: process.arch,
      cwd: process.cwd()
    };
  }
}

// ============== SHELL OPERATIONS ==============

export class ShellControl {
  /**
   * Execute shell command
   */
  async execute(command: string, cwd?: string): Promise<{ success: boolean; stdout?: string; stderr?: string; exitCode?: number; error?: string }> {
    try {
      const options: any = {
        maxBuffer: 10 * 1024 * 1024,
        shell: true
      };

      if (cwd) {
        options.cwd = cwd;
      }

      const { stdout, stderr } = await execAsync(command, options);
      return {
        success: true,
        stdout,
        stderr,
        exitCode: 0
      };
    } catch (error: any) {
      return {
        success: false,
        stdout: error.stdout || '',
        stderr: error.stderr || '',
        exitCode: error.code || 1,
        error: String(error)
      };
    }
  }

  /**
   * Execute command with streaming output
   */
  executeStreaming(command: string, onData: (data: string) => void, onError?: (data: string) => void): void {
    const isWindows = process.platform === 'win32';
    const shell = isWindows ? 'cmd.exe' : '/bin/bash';
    const shellArgs = isWindows ? ['/c', command] : ['-c', command];

    const proc = spawn(shell, shellArgs, {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    proc.stdout?.on('data', (data) => onData(data.toString()));
    proc.stderr?.on('data', (data) => onError?.(data.toString()));
  }
}

// ============== WINDOW OPERATIONS ==============

export class WindowControl {
  /**
   * Focus window by title
   */
  async focus(windowTitle: string): Promise<{ success: boolean; error?: string }> {
    try {
      const isWindows = process.platform === 'win32';

      if (isWindows) {
        const ps = `
          Add-Type @"
            using System;
            using System.Runtime.InteropServices;
            public class Win32 {
              [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
              [DllImport("user32.dll")] public static extern IntPtr FindWindow(string lpClassName, string lpWindowName);
            }
"@
          $hwnd = [Win32]::FindWindow([NullString]::Value, "${windowTitle}")
          if ($hwnd -ne [IntPtr]::Zero) { [Win32]::SetForegroundWindow($hwnd) }
        `;
        await execAsync(`powershell -Command "${ps.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`);
      }

      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  }

  /**
   * Minimize window
   */
  async minimize(windowTitle: string): Promise<{ success: boolean; error?: string }> {
    try {
      const isWindows = process.platform === 'win32';

      if (isWindows) {
        await execAsync(`powershell -Command "(New-Object -ComObject Shell.Application).Windows() | Where-Object { $_.Name -like '*${windowTitle}*' } | ForEach-Object { $_.Visible = $false }"`);
      }

      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  }

  /**
   * Maximize window
   */
  async maximize(windowTitle: string): Promise<{ success: boolean; error?: string }> {
    try {
      const isWindows = process.platform === 'win32';

      if (isWindows) {
        await execAsync(`powershell -Command "(New-Object -ComObject Shell.Application).Windows() | Where-Object { $_.Name -like '*${windowTitle}*' } | ForEach-Object { $_.FullScreen = $true }"`);
      }

      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  }
}

// ============== EXPORTS ==============

export const fileControl = new FileControl();
export const appControl = new AppControl();
export const clipboardControl = new ClipboardControl();
export const processControl = new ProcessControl();
export const shellControl = new ShellControl();
export const windowControl = new WindowControl();

export default {
  file: fileControl,
  app: appControl,
  clipboard: clipboardControl,
  process: processControl,
  shell: shellControl,
  window: windowControl
};
