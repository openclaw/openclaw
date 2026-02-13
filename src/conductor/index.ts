/**
 * Aether Conductor — Integration Layer
 *
 * Re-exports the core conductor from @aether/conductor package,
 * plus OpenClaw-specific adapters (browser executor, gateway forwarder).
 */

// Re-export everything from the package
export {
  Conductor,
  type ConductorOptions,
  TerminalInterceptor,
  generateRequestId,
  createAnalyzer,
  createConductorForwarder,
  formatInjectionPayload,
  injectResults,
  injectDenial,
  injectTimeout,
  type ExternalAccessKind,
  type ExternalAccessRequest,
  type ConductorDecision,
  type ConductorAuthorization,
  type BrowserAction,
  type BrowserActionResult,
  type ConductorInjection,
  type ConductorSessionState,
  type ConductorHistoryEntry,
  type AnalyzerResult,
  type ConductorAnalyzer,
  type ConductorForwarder,
  type ConductorExecutor,
  type ConductorEvent,
  type ConductorEventListener,
  type ConductorConfig,
  type ConductorAnalyzerConfig,
  type ConductorAnalyzerProvider,
  type ConductorAuthConfig,
  type ConductorBrowserConfig,
  type ConductorForwardTarget,
} from "@aether/conductor";

// OpenClaw-specific adapters
export { createBrowserExecutor } from "./browser-executor.js";
export { createGatewayForwarder } from "./gateway-forwarder.js";
