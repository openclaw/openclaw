/**
 * A cloud-hosted execution environment that plugins provide.
 *
 * The interface mirrors the semantics of the existing exec/browser runtime paths:
 *   - exec: spawn a command, capture stdout/stderr/exitCode
 *   - browser: expose a CDP endpoint for BrowserBridge
 *
 * Lifecycle:
 *   Plugin registers the provider via registerService("cloud-sandbox:<id>", { ... }).
 *   Core calls ensureReady() lazily on first exec/browser invocation.
 *   Core calls dispose() on gateway_stop or session end.
 */

// ---------------------------------------------------------------------------
// Provider interface
// ---------------------------------------------------------------------------

export interface CloudSandboxProvider {
  /** Unique provider id (e.g. "ags", "e2b", "modal"). */
  readonly id: string;

  // ===========================================================================
  // Exec
  // ===========================================================================

  /**
   * Run a command synchronously. Return when the command exits or times out.
   *
   * Semantics must match the contract of `runExecProcess()`:
   *   - command is a shell command string (will be passed to `/bin/sh -lc`)
   *   - stdout and stderr are captured and returned as strings
   *   - timedOut is true if the command was killed by the timeout
   */
  exec(params: CloudExecParams): Promise<CloudExecResult>;

  /**
   * Run a command in the background. Return immediately with a session handle.
   * The caller may later call readSessionLog() or killSession().
   */
  execBackground(params: CloudExecBackgroundParams): Promise<CloudExecSession>;

  /**
   * Read accumulated output from a background session.
   */
  readSessionLog(sessionId: string): Promise<CloudExecSessionLog>;

  /**
   * Kill a background session.
   */
  killSession(sessionId: string): Promise<void>;

  // ===========================================================================
  // Browser (optional — provider may not support browser)
  // ===========================================================================

  /**
   * Return a CDP WebSocket URL for the cloud browser.
   *
   * BrowserBridge will call `playwright.chromium.connectOverCDP(url)`.
   * Returns null if the provider does not support browser.
   *
   * The URL must be directly connectable from the gateway host.
   * If the provider requires tunneling or authentication, it must handle
   * that internally and return a ready-to-use URL.
   */
  getBrowserCdpUrl?(): Promise<string | null>;

  /**
   * Return a VNC/noVNC observation URL (optional, for user observation).
   */
  getBrowserVncUrl?(): Promise<string | null>;

  // ===========================================================================
  // Lifecycle
  // ===========================================================================

  /**
   * Lazily initialize the cloud sandbox (create VM, start services, etc.).
   * Core guarantees this is called before any exec/browser call.
   * Must be idempotent.
   */
  ensureReady(): Promise<void>;

  /**
   * Clean up resources (destroy VM, close connections).
   * Called on gateway_stop or when the session ends.
   */
  dispose(): Promise<void>;

  /**
   * Health check. Returns true if the sandbox is alive and accepting commands.
   */
  isReady(): boolean;
}

// ---------------------------------------------------------------------------
// Parameter / result types
// ---------------------------------------------------------------------------

export type CloudExecParams = {
  /** Shell command string (will be passed to /bin/sh -lc). */
  command: string;
  /** Working directory inside the sandbox. */
  cwd?: string;
  /** Environment variables to set. */
  env?: Record<string, string>;
  /** Timeout in milliseconds. */
  timeoutMs?: number;
};

export type CloudExecResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

export type CloudExecBackgroundParams = {
  command: string;
  cwd?: string;
  env?: Record<string, string>;
};

export type CloudExecSession = {
  sessionId: string;
  /** Initial output captured during the first ~100ms of startup (optional). */
  initialOutput?: string;
};

export type CloudExecSessionLog = {
  output: string;
  done: boolean;
  exitCode?: number;
};
