/**
 * LSP Lifecycle Manager
 *
 * Manages LSP server instances: spawning, initialization, file tracking,
 * diagnostics collection, and idle shutdown.
 *
 * Design:
 * - Reactive: only starts LSP when a file operation triggers it
 * - Multi-project: keys instances by (projectRoot, serverCommand)
 * - Idle timeout: auto-shuts down after 10 minutes of inactivity
 * - Graceful cleanup on process exit
 */

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { type LspServerConfig, detectLanguage } from "./language-detection.js";
import { LspClient, type LspDiagnostic, diagnosticSeverityLabel } from "./lsp-client.js";
import { buildLspInstanceKey, findProjectRoot } from "./project-root.js";

const log = createSubsystemLogger("lsp/manager");

const IDLE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const DIAGNOSTICS_WAIT_MS = 2_000; // Wait for diagnostics after file change
const MAX_DIAGNOSTICS_PER_FILE = 50; // Cap diagnostics returned to agent

type LspInstance = {
  client: LspClient;
  projectRoot: string;
  serverConfig: LspServerConfig;
  openFiles: Set<string>;
  diagnosticsByUri: Map<string, LspDiagnostic[]>;
  lastActivity: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
  initialized: boolean;
  initPromise: Promise<void> | null;
  fileVersions: Map<string, number>;
};

export type FormattedDiagnostic = {
  file: string;
  line: number;
  character: number;
  severity: string;
  message: string;
  source?: string;
  code?: string | number;
};

/**
 * Singleton LSP manager that handles all LSP server instances.
 */
class LspManagerImpl {
  private instances = new Map<string, LspInstance>();
  private _enabled = true;
  private _disposed = false;

  /** Enable/disable LSP integration globally. */
  set enabled(value: boolean) {
    this._enabled = value;
    if (!value) {
      this.disposeAll();
    }
  }

  get enabled(): boolean {
    return this._enabled;
  }

  /**
   * Handle a file write/edit operation:
   * 1. Detect language
   * 2. Find project root
   * 3. Start LSP if needed
   * 4. Notify LSP of file change
   * 5. Collect and return diagnostics
   */
  async handleFileChange(filePath: string, content?: string): Promise<FormattedDiagnostic[]> {
    if (!this._enabled || this._disposed) {
      return [];
    }

    const resolvedPath = path.resolve(filePath);
    const serverConfig = detectLanguage(resolvedPath);
    if (!serverConfig) {
      return [];
    }

    // Find project root
    const projectRoot = await findProjectRoot(resolvedPath, serverConfig.rootConfigFiles);
    if (!projectRoot) {
      log.debug(`No project root found for ${resolvedPath}`);
      return [];
    }

    const instanceKey = buildLspInstanceKey(projectRoot, serverConfig.serverCommand);

    // Get or create LSP instance
    let instance = this.instances.get(instanceKey);
    if (!instance || !instance.client.isAlive()) {
      instance = await this.startInstance(instanceKey, projectRoot, serverConfig);
      if (!instance) {
        return [];
      }
    }

    // Reset idle timer
    this.resetIdleTimer(instance);

    // Ensure initialized
    if (instance.initPromise) {
      await instance.initPromise;
    }

    // Read file content if not provided
    if (content === undefined) {
      try {
        content = await fs.readFile(resolvedPath, "utf8");
      } catch {
        log.debug(`Cannot read file for LSP: ${resolvedPath}`);
        return [];
      }
    }

    const uri = pathToFileURL(resolvedPath).href;

    // Send didOpen or didChange
    if (instance.openFiles.has(uri)) {
      const version = (instance.fileVersions.get(uri) ?? 0) + 1;
      instance.fileVersions.set(uri, version);
      instance.client.notify("textDocument/didChange", {
        textDocument: { uri, version },
        contentChanges: [{ text: content }],
      });
    } else {
      instance.openFiles.add(uri);
      const version = 1;
      instance.fileVersions.set(uri, version);
      instance.client.notify("textDocument/didOpen", {
        textDocument: {
          uri,
          languageId: serverConfig.languageId,
          version,
          text: content,
        },
      });
    }

    // Wait for diagnostics
    return await this.waitForDiagnostics(instance, uri);
  }

  /**
   * Get current diagnostics for a file without triggering a change.
   */
  getDiagnostics(filePath: string): FormattedDiagnostic[] {
    const uri = pathToFileURL(path.resolve(filePath)).href;
    for (const instance of this.instances.values()) {
      const diags = instance.diagnosticsByUri.get(uri);
      if (diags) {
        return this.formatDiagnostics(filePath, diags);
      }
    }
    return [];
  }

  /**
   * Request hover information for a position in a file.
   */
  async hover(filePath: string, line: number, character: number): Promise<string | undefined> {
    const instance = this.findInstanceForFile(filePath);
    if (!instance) {
      return undefined;
    }
    this.resetIdleTimer(instance);

    const uri = pathToFileURL(path.resolve(filePath)).href;
    try {
      const result = await instance.client.request<{
        contents:
          | string
          | { kind: string; value: string }
          | Array<string | { kind: string; value: string }>;
      } | null>("textDocument/hover", {
        textDocument: { uri },
        position: { line, character },
      });

      if (!result?.contents) {
        return undefined;
      }

      return this.extractHoverText(result.contents);
    } catch (err) {
      log.debug(`Hover request failed: ${String(err)}`);
      return undefined;
    }
  }

  /**
   * Request go-to-definition for a position in a file.
   */
  async definition(
    filePath: string,
    line: number,
    character: number,
  ): Promise<Array<{ file: string; line: number; character: number }>> {
    const instance = this.findInstanceForFile(filePath);
    if (!instance) {
      return [];
    }
    this.resetIdleTimer(instance);

    const uri = pathToFileURL(path.resolve(filePath)).href;
    try {
      const result = await instance.client.request<
        | { uri: string; range: { start: { line: number; character: number } } }
        | Array<{ uri: string; range: { start: { line: number; character: number } } }>
        | null
      >("textDocument/definition", {
        textDocument: { uri },
        position: { line, character },
      });

      if (!result) {
        return [];
      }

      const locations = Array.isArray(result) ? result : [result];
      return locations.map((loc) => ({
        file: new URL(loc.uri).pathname,
        line: loc.range.start.line + 1,
        character: loc.range.start.character + 1,
      }));
    } catch (err) {
      log.debug(`Definition request failed: ${String(err)}`);
      return [];
    }
  }

  /**
   * Request find-references for a position in a file.
   */
  async references(
    filePath: string,
    line: number,
    character: number,
  ): Promise<Array<{ file: string; line: number; character: number }>> {
    const instance = this.findInstanceForFile(filePath);
    if (!instance) {
      return [];
    }
    this.resetIdleTimer(instance);

    const uri = pathToFileURL(path.resolve(filePath)).href;
    try {
      const result = await instance.client.request<Array<{
        uri: string;
        range: { start: { line: number; character: number } };
      }> | null>("textDocument/references", {
        textDocument: { uri },
        position: { line, character },
        context: { includeDeclaration: true },
      });

      if (!result || !Array.isArray(result)) {
        return [];
      }

      return result.map((loc) => ({
        file: new URL(loc.uri).pathname,
        line: loc.range.start.line + 1,
        character: loc.range.start.character + 1,
      }));
    } catch (err) {
      log.debug(`References request failed: ${String(err)}`);
      return [];
    }
  }

  /**
   * Get status of all running LSP instances.
   */
  getStatus(): Array<{
    projectRoot: string;
    server: string;
    openFiles: number;
    alive: boolean;
  }> {
    return Array.from(this.instances.values()).map((inst) => ({
      projectRoot: inst.projectRoot,
      server: inst.serverConfig.serverCommand,
      openFiles: inst.openFiles.size,
      alive: inst.client.isAlive(),
    }));
  }

  /**
   * Shut down all LSP instances. Called on session cleanup.
   */
  disposeAll(): void {
    this._disposed = true;
    for (const [key, instance] of this.instances) {
      this.shutdownInstance(key, instance);
    }
    this.instances.clear();
  }

  /**
   * Re-enable after dispose (e.g. new session).
   */
  reset(): void {
    this._disposed = false;
  }

  private async startInstance(
    key: string,
    projectRoot: string,
    serverConfig: LspServerConfig,
  ): Promise<LspInstance | undefined> {
    log.info(
      `Starting LSP server: ${serverConfig.displayName} (${serverConfig.serverCommand}) at ${projectRoot}`,
    );

    try {
      const childProcess = spawn(serverConfig.serverCommand, serverConfig.serverArgs, {
        cwd: projectRoot,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env },
      });

      const client = new LspClient(childProcess);
      const instance: LspInstance = {
        client,
        projectRoot,
        serverConfig,
        openFiles: new Set(),
        diagnosticsByUri: new Map(),
        lastActivity: Date.now(),
        idleTimer: null,
        initialized: false,
        initPromise: null,
        fileVersions: new Map(),
      };

      // Set up diagnostics handler
      client.onDiagnostics = (uri, diagnostics) => {
        instance.diagnosticsByUri.set(uri, diagnostics);
      };

      // Handle unexpected exit
      client.on("exit", () => {
        log.info(`LSP server exited: ${serverConfig.displayName} at ${projectRoot}`);
        if (instance.idleTimer) {
          clearTimeout(instance.idleTimer);
        }
        this.instances.delete(key);
      });

      this.instances.set(key, instance);

      // Initialize the LSP server
      instance.initPromise = this.initializeServer(instance);
      await instance.initPromise;
      instance.initPromise = null;
      instance.initialized = true;

      this.resetIdleTimer(instance);

      return instance;
    } catch (err) {
      log.warn(`Failed to start LSP server ${serverConfig.serverCommand}: ${String(err)}`);
      return undefined;
    }
  }

  private async initializeServer(instance: LspInstance): Promise<void> {
    const rootUri = pathToFileURL(instance.projectRoot).href;

    try {
      await instance.client.request("initialize", {
        processId: process.pid,
        rootUri,
        rootPath: instance.projectRoot,
        capabilities: {
          textDocument: {
            synchronization: {
              dynamicRegistration: false,
              willSave: false,
              willSaveWaitUntil: false,
              didSave: true,
            },
            completion: {
              dynamicRegistration: false,
              completionItem: {
                snippetSupport: false,
                documentationFormat: ["plaintext", "markdown"],
              },
            },
            hover: {
              dynamicRegistration: false,
              contentFormat: ["plaintext", "markdown"],
            },
            definition: { dynamicRegistration: false },
            references: { dynamicRegistration: false },
            publishDiagnostics: {
              relatedInformation: true,
              tagSupport: { valueSet: [1, 2] },
            },
          },
          workspace: {
            workspaceFolders: true,
          },
        },
        workspaceFolders: [{ uri: rootUri, name: path.basename(instance.projectRoot) }],
      });

      // Send initialized notification
      instance.client.notify("initialized", {});
      log.info(
        `LSP server initialized: ${instance.serverConfig.displayName} at ${instance.projectRoot}`,
      );
    } catch (err) {
      log.warn(`LSP initialization failed: ${String(err)}`);
      instance.client.kill();
      throw err;
    }
  }

  private async waitForDiagnostics(
    instance: LspInstance,
    uri: string,
  ): Promise<FormattedDiagnostic[]> {
    // Wait for diagnostics to arrive
    return new Promise<FormattedDiagnostic[]>((resolve) => {
      const filePath = new URL(uri).pathname;
      let resolved = false;

      const checkDiagnostics = () => {
        if (resolved) {
          return;
        }
        resolved = true;
        const diags = instance.diagnosticsByUri.get(uri) ?? [];
        resolve(this.formatDiagnostics(filePath, diags));
      };

      // Listen for diagnostics notification for the target URI
      const onNotification = (method: string, params?: unknown) => {
        if (method === "textDocument/publishDiagnostics") {
          const notifParams = params as { uri?: string } | undefined;
          if (notifParams?.uri !== uri) {
            return; // Not for our file — keep waiting
          }
          // Give a small window for batched diagnostics
          setTimeout(() => {
            instance.client.removeListener("notification", onNotification);
            checkDiagnostics();
          }, 200);
        }
      };
      instance.client.on("notification", onNotification);

      // Timeout fallback
      setTimeout(() => {
        instance.client.removeListener("notification", onNotification);
        checkDiagnostics();
      }, DIAGNOSTICS_WAIT_MS);
    });
  }

  private formatDiagnostics(filePath: string, diagnostics: LspDiagnostic[]): FormattedDiagnostic[] {
    const relativePath = filePath;

    return diagnostics.slice(0, MAX_DIAGNOSTICS_PER_FILE).map((diag) => ({
      file: relativePath,
      line: diag.range.start.line + 1, // Convert 0-based to 1-based
      character: diag.range.start.character + 1,
      severity: diagnosticSeverityLabel(diag.severity),
      message: diag.message,
      source: diag.source,
      code: diag.code,
    }));
  }

  private extractHoverText(
    contents:
      | string
      | { kind: string; value: string }
      | Array<string | { kind: string; value: string }>,
  ): string {
    if (typeof contents === "string") {
      return contents;
    }
    if (Array.isArray(contents)) {
      return contents.map((c) => (typeof c === "string" ? c : c.value)).join("\n\n");
    }
    return contents.value;
  }

  private findInstanceForFile(filePath: string): LspInstance | undefined {
    const resolvedPath = path.resolve(filePath);
    for (const instance of this.instances.values()) {
      // Add trailing separator to avoid false prefix matches
      // e.g. /repo/pkg must not match /repo/pkg2
      const rootWithSep = instance.projectRoot.endsWith(path.sep)
        ? instance.projectRoot
        : instance.projectRoot + path.sep;
      if (resolvedPath.startsWith(rootWithSep) || resolvedPath === instance.projectRoot) {
        return instance;
      }
    }
    return undefined;
  }

  private resetIdleTimer(instance: LspInstance): void {
    instance.lastActivity = Date.now();
    if (instance.idleTimer) {
      clearTimeout(instance.idleTimer);
    }
    instance.idleTimer = setTimeout(() => {
      const key = buildLspInstanceKey(instance.projectRoot, instance.serverConfig.serverCommand);
      log.info(
        `Shutting down idle LSP server: ${instance.serverConfig.displayName} at ${instance.projectRoot}`,
      );
      this.shutdownInstance(key, instance);
    }, IDLE_TIMEOUT_MS);
  }

  private shutdownInstance(key: string, instance: LspInstance): void {
    if (instance.idleTimer) {
      clearTimeout(instance.idleTimer);
      instance.idleTimer = null;
    }

    // Send shutdown request, then exit notification
    if (instance.client.isAlive()) {
      // Close all open files first
      for (const uri of instance.openFiles) {
        instance.client.notify("textDocument/didClose", {
          textDocument: { uri },
        });
      }

      instance.client.request("shutdown", null).then(
        () => {
          instance.client.notify("exit", null);
        },
        () => {
          // If shutdown request fails, just kill
          instance.client.kill();
        },
      );
    }

    this.instances.delete(key);
  }
}

// Singleton instance
let _manager: LspManagerImpl | null = null;

/**
 * Get the global LSP manager instance.
 */
export function getLspManager(): LspManagerImpl {
  if (!_manager) {
    _manager = new LspManagerImpl();
  }
  return _manager;
}

/**
 * Reset the global LSP manager (for testing).
 */
export function resetLspManager(): void {
  if (_manager) {
    _manager.disposeAll();
    _manager = null;
  }
}

export type { LspManagerImpl };
