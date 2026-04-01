/**
 * Security Classifier Interface - Abstract interface for AI-based security classification.
 *
 * This module provides an interface for integrating external AI security classifiers
 * (like OpenGuardrails) into the OpenClaw execution approval flow.
 *
 * Design Philosophy:
 * - Agent harnesses (like OpenClaw) should NOT implement their own AI classifiers
 * - Instead, they should provide clean interfaces to integrate external classifiers
 * - This allows organizations to use their preferred classifier systems
 * - Examples: OpenGuardrails, custom fine-tuned models, cloud-based safety APIs
 *
 * Integration Points:
 * 1. Pre-execution: Classify the command/action before execution
 * 2. Pre-approval: Add classifier decision to approval UI
 * 3. Post-denial: Explain why the classifier blocked the action
 *
 * @see https://github.com/openguardrails/openguardrails - Recommended classifier
 */

/**
 * Context provided to the classifier for decision making.
 */
export type ClassifierContext = {
  /** The action being classified (command, tool use, etc.) */
  action: ClassifierAction;

  /** Conversation/transcript context (optional but recommended) */
  transcript?: TranscriptEntry[];

  /** Agent configuration and metadata */
  agent?: AgentContext;

  /** User-provided safety rules (allow/deny descriptions) */
  userRules?: UserSecurityRules;

  /** Session information */
  session?: SessionContext;
};

export type ClassifierAction =
  | {
      type: "exec";
      command: string;
      argv?: string[];
      cwd?: string;
      env?: Record<string, string>;
    }
  | {
      type: "tool_use";
      toolName: string;
      input: unknown;
    }
  | {
      type: "file_write";
      path: string;
      content?: string;
    }
  | {
      type: "network";
      url: string;
      method?: string;
    }
  | {
      type: "custom";
      name: string;
      payload: unknown;
    };

export type TranscriptEntry = {
  role: "user" | "assistant" | "system";
  content: TranscriptContent[];
  timestamp?: number;
};

export type TranscriptContent =
  | { type: "text"; text: string }
  | { type: "tool_use"; toolName: string; input: unknown }
  | { type: "tool_result"; toolName: string; output: unknown };

export type AgentContext = {
  agentId: string;
  agentType?: string;
  securityLevel?: "deny" | "allowlist" | "full";
  capabilities?: string[];
};

export type UserSecurityRules = {
  /** Actions the user has explicitly allowed */
  allow?: string[];
  /** Actions the user has explicitly denied */
  deny?: string[];
  /** Soft denials that classifier can override with good reason */
  softDeny?: string[];
  /** Environment description for context */
  environment?: string[];
};

export type SessionContext = {
  sessionId?: string;
  sessionStart?: number;
  turnCount?: number;
  previousDenials?: number;
};

/**
 * Result from the classifier.
 */
export type ClassifierResult = {
  /** Whether the action should be blocked */
  shouldBlock: boolean;

  /** Human-readable reason for the decision */
  reason: string;

  /** Confidence level of the classification */
  confidence: "high" | "medium" | "low";

  /** Detailed thinking/reasoning (optional) */
  thinking?: string;

  /** Category of risk detected (if blocked) */
  riskCategory?: SecurityRiskCategory;

  /** Suggested mitigations (if blocked) */
  mitigations?: string[];

  /** Whether the user can override this decision */
  userOverridable?: boolean;

  /** Additional metadata from the classifier */
  metadata?: Record<string, unknown>;
};

export type SecurityRiskCategory =
  | "code_execution" // Arbitrary code execution
  | "data_exfiltration" // Sending data to external systems
  | "persistence" // Installing backdoors, modifying startup files
  | "privilege_escalation" // Gaining elevated permissions
  | "destructive_action" // rm -rf, file deletion, etc.
  | "security_weakening" // Disabling security controls
  | "cross_machine_attack" // Actions targeting other systems
  | "credential_exposure" // Exposing secrets or credentials
  | "unknown"; // Unclassified risk

/**
 * Classifier unavailability result.
 * Used when the classifier cannot be reached or fails.
 */
export type ClassifierUnavailableResult = {
  unavailable: true;
  reason: string;
  /** Whether to fail closed (block) or open (allow) */
  failMode: "closed" | "open";
};

/**
 * Combined result type for classifier calls.
 */
export type ClassifierResponse = ClassifierResult | ClassifierUnavailableResult;

/**
 * Abstract interface for security classifiers.
 * Implement this interface to integrate a classifier system.
 */
export interface ISecurityClassifier {
  /** Unique identifier for this classifier implementation */
  readonly id: string;

  /** Human-readable name */
  readonly name: string;

  /** Version of the classifier */
  readonly version: string;

  /**
   * Classify an action and return a decision.
   *
   * @param context - The context for classification
   * @param signal - Abort signal for cancellation
   * @returns Classification result
   */
  classify(context: ClassifierContext, signal?: AbortSignal): Promise<ClassifierResponse>;

  /**
   * Check if the classifier is available and healthy.
   */
  healthCheck(): Promise<{ healthy: boolean; message?: string }>;

  /**
   * Get classifier configuration/capabilities.
   */
  getCapabilities(): ClassifierCapabilities;
}

export type ClassifierCapabilities = {
  /** Supported action types */
  supportedActions: ClassifierAction["type"][];

  /** Whether transcript context is used */
  usesTranscript: boolean;

  /** Whether user rules are supported */
  supportsUserRules: boolean;

  /** Maximum transcript length supported (in entries) */
  maxTranscriptLength?: number;

  /** Typical latency range in ms */
  typicalLatencyMs?: { min: number; max: number };
};

/**
 * Configuration for the classifier integration.
 */
export type ClassifierConfig = {
  /** Enable/disable the classifier */
  enabled: boolean;

  /** Classifier endpoint (if remote) */
  endpoint?: string;

  /** Authentication token */
  authToken?: string;

  /** Timeout in milliseconds */
  timeoutMs?: number;

  /** Fail mode when classifier is unavailable */
  failMode?: "closed" | "open";

  /** Custom classifier implementation */
  customClassifier?: ISecurityClassifier;
};

/**
 * Default classifier configuration.
 */
export const DEFAULT_CLASSIFIER_CONFIG: Readonly<ClassifierConfig> = {
  enabled: false,
  timeoutMs: 10000,
  failMode: "closed", // Fail closed by default for security
};

// ============================================================================
// Classifier Registry
// ============================================================================

const registeredClassifiers = new Map<string, ISecurityClassifier>();

/**
 * Register a classifier implementation.
 */
export function registerClassifier(classifier: ISecurityClassifier): void {
  registeredClassifiers.set(classifier.id, classifier);
}

/**
 * Get a registered classifier by ID.
 */
export function getClassifier(id: string): ISecurityClassifier | undefined {
  return registeredClassifiers.get(id);
}

/**
 * List all registered classifiers.
 */
export function listClassifiers(): ISecurityClassifier[] {
  return Array.from(registeredClassifiers.values());
}

/**
 * Unregister a classifier.
 */
export function unregisterClassifier(id: string): boolean {
  return registeredClassifiers.delete(id);
}

// ============================================================================
// Built-in Stub Classifier (for testing/development)
// ============================================================================

/**
 * A stub classifier that always allows actions.
 * Useful for testing or when no real classifier is configured.
 */
export class StubAllowClassifier implements ISecurityClassifier {
  readonly id = "stub-allow";
  readonly name = "Stub Allow Classifier";
  readonly version = "1.0.0";

  async classify(_context: ClassifierContext): Promise<ClassifierResult> {
    return {
      shouldBlock: false,
      reason: "Stub classifier - always allows",
      confidence: "high",
    };
  }

  async healthCheck(): Promise<{ healthy: boolean }> {
    return { healthy: true };
  }

  getCapabilities(): ClassifierCapabilities {
    return {
      supportedActions: ["exec", "tool_use", "file_write", "network", "custom"],
      usesTranscript: false,
      supportsUserRules: false,
    };
  }
}

/**
 * A stub classifier that always blocks actions.
 * Useful for testing security-critical scenarios.
 */
export class StubDenyClassifier implements ISecurityClassifier {
  readonly id = "stub-deny";
  readonly name = "Stub Deny Classifier";
  readonly version = "1.0.0";

  async classify(_context: ClassifierContext): Promise<ClassifierResult> {
    return {
      shouldBlock: true,
      reason: "Stub classifier - always blocks",
      confidence: "high",
      userOverridable: true,
    };
  }

  async healthCheck(): Promise<{ healthy: boolean }> {
    return { healthy: true };
  }

  getCapabilities(): ClassifierCapabilities {
    return {
      supportedActions: ["exec", "tool_use", "file_write", "network", "custom"],
      usesTranscript: false,
      supportsUserRules: false,
    };
  }
}

// ============================================================================
// HTTP Classifier Client (for remote classifiers like OpenGuardrails)
// ============================================================================

/**
 * HTTP-based classifier client for remote classifier services.
 * Can be used with OpenGuardrails or any compatible API.
 */
export class HttpClassifierClient implements ISecurityClassifier {
  readonly id: string;
  readonly name: string;
  readonly version: string;

  private readonly endpoint: string;
  private readonly authToken?: string;
  private readonly timeoutMs: number;

  constructor(config: {
    id?: string;
    name?: string;
    version?: string;
    endpoint: string;
    authToken?: string;
    timeoutMs?: number;
  }) {
    this.id = config.id ?? "http-classifier";
    this.name = config.name ?? "HTTP Classifier";
    this.version = config.version ?? "1.0.0";
    this.endpoint = config.endpoint;
    this.authToken = config.authToken;
    this.timeoutMs = config.timeoutMs ?? 10000;
  }

  async classify(context: ClassifierContext, signal?: AbortSignal): Promise<ClassifierResponse> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    // Combine user signal with our timeout
    if (signal) {
      signal.addEventListener("abort", () => controller.abort());
    }

    try {
      const response = await fetch(`${this.endpoint}/classify`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.authToken && { Authorization: `Bearer ${this.authToken}` }),
        },
        body: JSON.stringify(context),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        return {
          unavailable: true,
          reason: `Classifier returned status ${response.status}`,
          failMode: "closed",
        };
      }

      const result = (await response.json()) as ClassifierResult;
      return result;
    } catch (error) {
      clearTimeout(timeoutId);

      if (error instanceof Error && error.name === "AbortError") {
        return {
          unavailable: true,
          reason: "Classifier request timed out or was cancelled",
          failMode: "closed",
        };
      }

      return {
        unavailable: true,
        reason: `Classifier request failed: ${error instanceof Error ? error.message : "Unknown error"}`,
        failMode: "closed",
      };
    }
  }

  async healthCheck(): Promise<{ healthy: boolean; message?: string }> {
    try {
      const response = await fetch(`${this.endpoint}/health`, {
        method: "GET",
        signal: AbortSignal.timeout(5000),
      });
      return {
        healthy: response.ok,
        message: response.ok ? undefined : `Status ${response.status}`,
      };
    } catch (error) {
      return {
        healthy: false,
        message: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  getCapabilities(): ClassifierCapabilities {
    return {
      supportedActions: ["exec", "tool_use", "file_write", "network", "custom"],
      usesTranscript: true,
      supportsUserRules: true,
      typicalLatencyMs: { min: 100, max: 2000 },
    };
  }
}

// ============================================================================
// Main Classification Function
// ============================================================================

let activeClassifier: ISecurityClassifier | null = null;
let classifierConfig: ClassifierConfig = { ...DEFAULT_CLASSIFIER_CONFIG };

/**
 * Configure the classifier system.
 */
export function configureClassifier(config: Partial<ClassifierConfig>): void {
  classifierConfig = { ...DEFAULT_CLASSIFIER_CONFIG, ...config };

  if (config.customClassifier) {
    activeClassifier = config.customClassifier;
  } else if (config.endpoint) {
    activeClassifier = new HttpClassifierClient({
      endpoint: config.endpoint,
      authToken: config.authToken,
      timeoutMs: config.timeoutMs,
    });
  } else {
    activeClassifier = null;
  }
}

/**
 * Get the current classifier configuration.
 */
export function getClassifierConfig(): Readonly<ClassifierConfig> {
  return classifierConfig;
}

/**
 * Check if a classifier is configured and enabled.
 */
export function isClassifierEnabled(): boolean {
  return classifierConfig.enabled && activeClassifier !== null;
}

/**
 * Classify an action using the configured classifier.
 *
 * @param context - Classification context
 * @param signal - Abort signal
 * @returns Classification result or unavailable result
 */
export async function classifyAction(
  context: ClassifierContext,
  signal?: AbortSignal,
): Promise<ClassifierResponse> {
  if (!classifierConfig.enabled) {
    return {
      shouldBlock: false,
      reason: "Classifier not enabled",
      confidence: "high",
    };
  }

  if (!activeClassifier) {
    return {
      unavailable: true,
      reason: "No classifier configured",
      failMode: classifierConfig.failMode ?? "closed",
    };
  }

  try {
    return await activeClassifier.classify(context, signal);
  } catch (error) {
    return {
      unavailable: true,
      reason: error instanceof Error ? error.message : "Unknown classifier error",
      failMode: classifierConfig.failMode ?? "closed",
    };
  }
}

/**
 * Helper to build classifier context from an exec request.
 */
export function buildExecClassifierContext(params: {
  command: string;
  argv?: string[];
  cwd?: string;
  agentId?: string;
  securityLevel?: "deny" | "allowlist" | "full";
  transcript?: TranscriptEntry[];
  userRules?: UserSecurityRules;
}): ClassifierContext {
  return {
    action: {
      type: "exec",
      command: params.command,
      argv: params.argv,
      cwd: params.cwd,
    },
    agent: params.agentId
      ? {
          agentId: params.agentId,
          securityLevel: params.securityLevel,
        }
      : undefined,
    transcript: params.transcript,
    userRules: params.userRules,
  };
}

/**
 * Helper to check classifier result and determine action.
 */
export function interpretClassifierResult(
  result: ClassifierResponse,
  failMode: "closed" | "open" = "closed",
): {
  shouldBlock: boolean;
  reason: string;
  requiresUserApproval: boolean;
} {
  // Handle unavailable classifier
  if ("unavailable" in result && result.unavailable) {
    const shouldBlock = (result.failMode ?? failMode) === "closed";
    return {
      shouldBlock,
      reason: `Classifier unavailable: ${result.reason}`,
      requiresUserApproval: shouldBlock, // Require user approval when failing closed
    };
  }

  // Handle normal classification result - cast to ClassifierResult after narrowing
  const classifierResult = result as ClassifierResult;
  return {
    shouldBlock: classifierResult.shouldBlock,
    reason: classifierResult.reason,
    requiresUserApproval:
      classifierResult.shouldBlock && (classifierResult.userOverridable ?? true),
  };
}
