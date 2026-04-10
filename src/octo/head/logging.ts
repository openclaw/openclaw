// Octopus Orchestrator — Logging integration (M2-16)
//
// Defines a provider-agnostic LoggerProvider interface and an OctoLogger
// class that delegates log calls to the injected provider.  The provider
// is injected at construction time so that the head package never imports
// OpenClaw internals (OCTO-DEC-033).

// ---------------------------------------------------------------------------
// Provider interface
// ---------------------------------------------------------------------------

/** Minimal logging contract injected by the downstream wiring layer. */
export interface LoggerProvider {
  info(component: string, message: string, data?: Record<string, unknown>): void;
  warn(component: string, message: string, data?: Record<string, unknown>): void;
  error(component: string, message: string, data?: Record<string, unknown>): void;
  debug(component: string, message: string, data?: Record<string, unknown>): void;
}

// ---------------------------------------------------------------------------
// Built-in providers
// ---------------------------------------------------------------------------

/** Default provider that delegates to the global console object. */
export const consoleLoggerProvider: LoggerProvider = {
  info(component: string, message: string, data?: Record<string, unknown>): void {
    console.info(`[${component}] ${message}`, ...(data !== undefined ? [data] : []));
  },
  warn(component: string, message: string, data?: Record<string, unknown>): void {
    console.warn(`[${component}] ${message}`, ...(data !== undefined ? [data] : []));
  },
  error(component: string, message: string, data?: Record<string, unknown>): void {
    console.error(`[${component}] ${message}`, ...(data !== undefined ? [data] : []));
  },
  debug(component: string, message: string, data?: Record<string, unknown>): void {
    console.debug(`[${component}] ${message}`, ...(data !== undefined ? [data] : []));
  },
};

/** Silent provider that discards all log output. */
export const noopLoggerProvider: LoggerProvider = {
  info(): void {},
  warn(): void {},
  error(): void {},
  debug(): void {},
};

// ---------------------------------------------------------------------------
// OctoLogger
// ---------------------------------------------------------------------------

/** Scoped logger that prepends a fixed component name to every log call. */
export class OctoLogger {
  private readonly component: string;
  private readonly provider: LoggerProvider;

  constructor(component: string, provider: LoggerProvider) {
    this.component = component;
    this.provider = provider;
  }

  info(message: string, data?: Record<string, unknown>): void {
    this.provider.info(this.component, message, data);
  }

  warn(message: string, data?: Record<string, unknown>): void {
    this.provider.warn(this.component, message, data);
  }

  error(message: string, data?: Record<string, unknown>): void {
    this.provider.error(this.component, message, data);
  }

  debug(message: string, data?: Record<string, unknown>): void {
    this.provider.debug(this.component, message, data);
  }
}
