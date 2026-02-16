/**
 * Plugin Sandbox using isolated-vm
 *
 * Provides secure execution environment for untrusted plugins by:
 * - Running code in isolated V8 context
 * - Enforcing memory and CPU limits
 * - Blocking access to Node.js built-ins by default
 * - Validating all resource access against permissions
 */

import ivm from "isolated-vm";
import fs from "node:fs";
import path from "node:path";
import type { PluginLogger } from "./types.js";
import {
  normalizePluginPermissions,
  isPathAllowed,
  isDomainAllowed,
  isModuleAllowed,
  isEnvVarAllowed,
  type PluginPermissions,
} from "./plugin-permissions.js";

export type SandboxOptions = {
  permissions?: Partial<PluginPermissions>;
  logger?: PluginLogger;
  pluginId: string;
  pluginSource: string;
};

export type SandboxExecutionResult = {
  success: boolean;
  exports?: unknown;
  error?: string;
};

/**
 * Creates a sandboxed execution context for plugin code
 */
export class PluginSandbox {
  private isolate: ivm.Isolate;
  private context: ivm.Context;
  private permissions: Required<PluginPermissions>;
  private logger: PluginLogger;
  private pluginId: string;
  private pluginSource: string;

  constructor(options: SandboxOptions) {
    this.pluginId = options.pluginId;
    this.pluginSource = options.pluginSource;
    this.permissions = normalizePluginPermissions(options.permissions);
    this.logger = options.logger ?? this.createDefaultLogger();

    // Create isolated V8 context with memory limit
    this.isolate = new ivm.Isolate({
      memoryLimit: this.permissions.memory,
    });

    // Create context within the isolate
    this.context = this.isolate.createContextSync();

    // Setup sandbox environment
    this.setupSandboxEnvironment();
  }

  private createDefaultLogger(): PluginLogger {
    return {
      info: (msg: string) => console.log(`[plugin-sandbox] ${msg}`),
      warn: (msg: string) => console.warn(`[plugin-sandbox] ${msg}`),
      error: (msg: string) => console.error(`[plugin-sandbox] ${msg}`),
    };
  }

  /**
   * Setup the sandbox environment with restricted APIs
   */
  private setupSandboxEnvironment(): void {
    const jail = this.context.global;

    // Set global context properties
    jail.setSync("global", jail.derefInto());

    // Provide safe console implementation
    const consoleLog = (...args: unknown[]) => {
      this.logger.info(`[${this.pluginId}] ${args.join(" ")}`);
    };
    const consoleWarn = (...args: unknown[]) => {
      this.logger.warn(`[${this.pluginId}] ${args.join(" ")}`);
    };
    const consoleError = (...args: unknown[]) => {
      this.logger.error(`[${this.pluginId}] ${args.join(" ")}`);
    };

    jail.setSync(
      "console",
      new ivm.Reference({
        log: new ivm.Reference(consoleLog),
        warn: new ivm.Reference(consoleWarn),
        error: new ivm.Reference(consoleError),
        info: new ivm.Reference(consoleLog),
        debug: new ivm.Reference(consoleLog),
      }),
    );

    // Block access to dangerous globals
    jail.setSync("eval", undefined);
    jail.setSync("Function", undefined);

    // Provide restricted require implementation
    if (this.permissions.nativeModules || this.permissions.allowedModules.length > 0) {
      jail.setSync("require", new ivm.Reference(this.createRestrictedRequire()));
    }

    // Provide restricted process if env vars allowed
    if (this.permissions.env) {
      jail.setSync(
        "process",
        new ivm.Reference({
          env: new ivm.Reference(this.createRestrictedEnv()),
        }),
      );
    }
  }

  /**
   * Creates a restricted require function that only allows permitted modules
   */
  private createRestrictedRequire(): (moduleName: string) => unknown {
    return (moduleName: string) => {
      if (!isModuleAllowed(moduleName, this.permissions)) {
        throw new Error(`Module "${moduleName}" is not allowed by plugin permissions`);
      }

      // For now, we block all require() calls by default
      // In production, you would implement module allowlisting here
      throw new Error(
        `Dynamic require() is not supported in sandboxed plugins. Module: ${moduleName}`,
      );
    };
  }

  /**
   * Creates a restricted process.env proxy that only exposes allowed variables
   */
  private createRestrictedEnv(): Record<string, string | undefined> {
    const env: Record<string, string | undefined> = {};

    if (this.permissions.env) {
      for (const key of Object.keys(process.env)) {
        if (isEnvVarAllowed(key, this.permissions)) {
          env[key] = process.env[key];
        }
      }
    }

    return env;
  }

  /**
   * Execute plugin code in the sandbox with timeout
   */
  async execute(code: string): Promise<SandboxExecutionResult> {
    try {
      // Compile the script
      const script = await this.isolate.compileScript(code, {
        filename: this.pluginSource,
      });

      // Run with CPU timeout
      const result = await script.run(this.context, {
        timeout: this.permissions.cpu,
        release: false,
      });

      // Extract exports
      const exports = await this.extractExports();

      return {
        success: true,
        exports,
      };
    } catch (err) {
      const errorMessage = String(err);
      this.logger.error(`Plugin ${this.pluginId} execution failed: ${errorMessage}`);

      // Detect timeout errors
      if (errorMessage.includes("timeout") || errorMessage.includes("CPU")) {
        return {
          success: false,
          error: `Plugin exceeded CPU time limit (${this.permissions.cpu}ms)`,
        };
      }

      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Extract module exports from the sandbox context
   */
  private async extractExports(): Promise<unknown> {
    try {
      // Try to get module.exports
      const moduleRef = await this.context.global.get("module");
      if (moduleRef) {
        const exportsRef = await moduleRef.get("exports");
        if (exportsRef) {
          // Copy the exports to host context
          return await exportsRef.copy();
        }
      }

      // Try to get exports directly
      const exportsRef = await this.context.global.get("exports");
      if (exportsRef) {
        return await exportsRef.copy();
      }

      return undefined;
    } catch (err) {
      this.logger.warn(`Failed to extract exports from plugin ${this.pluginId}: ${String(err)}`);
      return undefined;
    }
  }

  /**
   * Load and execute a plugin file in the sandbox
   */
  async loadFile(filePath: string): Promise<SandboxExecutionResult> {
    try {
      // Check file read permissions
      if (!isPathAllowed(filePath, "read", this.permissions)) {
        return {
          success: false,
          error: `Plugin does not have permission to read file: ${filePath}`,
        };
      }

      // Read the plugin code
      const code = fs.readFileSync(filePath, "utf-8");

      // Wrap in module pattern
      const wrappedCode = this.wrapInModulePattern(code);

      return await this.execute(wrappedCode);
    } catch (err) {
      return {
        success: false,
        error: `Failed to load plugin file: ${String(err)}`,
      };
    }
  }

  /**
   * Wraps code in CommonJS module pattern
   */
  private wrapInModulePattern(code: string): string {
    return `
      (function(exports, module, __filename, __dirname) {
        ${code}
      })(
        typeof exports !== 'undefined' ? exports : {},
        typeof module !== 'undefined' ? module : { exports: {} },
        '${this.pluginSource}',
        '${path.dirname(this.pluginSource)}'
      );
    `;
  }

  /**
   * Cleanup sandbox resources
   */
  async dispose(): Promise<void> {
    try {
      if (this.context) {
        this.context.release();
      }
      if (this.isolate) {
        this.isolate.dispose();
      }
    } catch (err) {
      this.logger.error(`Failed to dispose sandbox: ${String(err)}`);
    }
  }
}

/**
 * Helper to create and execute a sandboxed plugin
 */
export async function executeSandboxedPlugin(
  options: SandboxOptions & { code?: string; filePath?: string },
): Promise<SandboxExecutionResult> {
  const sandbox = new PluginSandbox(options);

  try {
    if (options.filePath) {
      return await sandbox.loadFile(options.filePath);
    }
    if (options.code) {
      return await sandbox.execute(options.code);
    }
    return {
      success: false,
      error: "No code or filePath provided",
    };
  } finally {
    await sandbox.dispose();
  }
}

/**
 * Load plugin permissions from manifest
 */
export function loadPermissionsFromManifest(
  manifestPath: string,
): Partial<PluginPermissions> | null {
  try {
    if (!fs.existsSync(manifestPath)) {
      return null;
    }

    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    return manifest.permissions ?? null;
  } catch {
    return null;
  }
}
