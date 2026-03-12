/**
 * Capability Registry - Standardized tool schema definitions
 *
 * This is the core of Phase 1: Architecture Core
 *
 * Each capability has:
 * - name: unique identifier
 * - description: what it does
 * - inputSchema: parameters required
 * - outputSchema: what it returns
 * - riskLevel: 1-4 (read-only to high-risk)
 * - preconditions: what must be true before execution
 * - postconditions: what should be true after
 * - verificationStrategy: how to verify success
 * - allowedEnvironments: where it can run
 */

export type RiskLevel = 1 | 2 | 3 | 4;
export type Environment = 'local' | 'remote' | 'sandbox' | 'any';

export interface CapabilityParameter {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  description: string;
  required: boolean;
  default?: unknown;
  schema?: Record<string, unknown>;
}

export interface CapabilitySchema {
  input: CapabilityParameter[];
  output: CapabilityParameter[];
}

export interface Capability {
  name: string;
  description: string;
  category: 'code' | 'desktop' | 'browser' | 'knowledge' | 'automation' | 'system';
  inputSchema: CapabilitySchema['input'];
  outputSchema: CapabilitySchema['output'];
  riskLevel: RiskLevel;
  preconditions: string[];
  postconditions: string[];
  verificationStrategy: string;
  allowedEnvironments: Environment[];
  timeout?: number;
  retryable?: boolean;
}

// File Capabilities (Risk Level 1-3)
export const FILE_CAPABILITIES: Capability[] = [
  {
    name: 'read_file',
    description: 'Read contents of a file',
    category: 'code',
    inputSchema: [
      { name: 'path', type: 'string', description: 'Absolute or relative file path', required: true },
      { name: 'offset', type: 'number', description: 'Line offset to start reading', required: false, default: 0 },
      { name: 'limit', type: 'number', description: 'Number of lines to read', required: false }
    ],
    outputSchema: [
      { name: 'content', type: 'string', description: 'File contents' },
      { name: 'exists', type: 'boolean', description: 'Whether file exists' }
    ],
    riskLevel: 1,
    preconditions: ['file exists', 'read permission'],
    postconditions: ['content returned'],
    verificationStrategy: 'Check file exists and read succeeds',
    allowedEnvironments: ['local', 'sandbox']
  },
  {
    name: 'write_file',
    description: 'Create or overwrite a file',
    category: 'code',
    inputSchema: [
      { name: 'path', type: 'string', description: 'File path to write', required: true },
      { name: 'content', type: 'string', description: 'Content to write', required: true },
      { name: 'append', type: 'boolean', description: 'Append instead of overwrite', required: false, default: false }
    ],
    outputSchema: [
      { name: 'success', type: 'boolean', description: 'Whether write succeeded' },
      { name: 'path', type: 'string', description: 'Path of written file' }
    ],
    riskLevel: 3,
    preconditions: ['write permission', 'parent directory exists'],
    postconditions: ['file created or modified'],
    verificationStrategy: 'Verify file exists with correct content',
    allowedEnvironments: ['local', 'sandbox'],
    retryable: true
  },
  {
    name: 'edit_file',
    description: 'Edit specific parts of a file using patch',
    category: 'code',
    inputSchema: [
      { name: 'path', type: 'string', description: 'File path to edit', required: true },
      { name: 'patch', type: 'string', description: 'Unified diff patch', required: true },
      { name: 'strict', type: 'boolean', description: 'Fail if patch cannot be applied', required: false, default: true }
    ],
    outputSchema: [
      { name: 'success', type: 'boolean', description: 'Whether edit succeeded' },
      { name: 'diff', type: 'string', description: 'Applied diff' }
    ],
    riskLevel: 3,
    preconditions: ['file exists', 'write permission'],
    postconditions: ['changes applied correctly'],
    verificationStrategy: 'Apply patch and verify syntax',
    allowedEnvironments: ['local', 'sandbox']
  },
  {
    name: 'glob',
    description: 'Find files matching pattern',
    category: 'code',
    inputSchema: [
      { name: 'pattern', type: 'string', description: 'Glob pattern (e.g., **/*.ts)', required: true },
      { name: 'cwd', type: 'string', description: 'Working directory', required: false }
    ],
    outputSchema: [
      { name: 'files', type: 'array', description: 'List of matching file paths' }
    ],
    riskLevel: 1,
    preconditions: [],
    postconditions: [],
    verificationStrategy: 'Check pattern is valid',
    allowedEnvironments: ['any']
  },
  {
    name: 'grep',
    description: 'Search for text in files',
    category: 'code',
    inputSchema: [
      { name: 'pattern', type: 'string', description: 'Regex or text pattern', required: true },
      { name: 'path', type: 'string', description: 'Directory or file to search', required: true },
      { name: 'glob', type: 'string', description: 'File filter pattern', required: false }
    ],
    outputSchema: [
      { name: 'matches', type: 'array', description: 'Array of match objects with file, line, content' }
    ],
    riskLevel: 1,
    preconditions: [],
    postconditions: [],
    verificationStrategy: 'Valid pattern returns results',
    allowedEnvironments: ['any']
  }
];

// Desktop Capabilities (Risk Level 2-3)
export const DESKTOP_CAPABILITIES: Capability[] = [
  {
    name: 'launch_app',
    description: 'Launch an application',
    category: 'desktop',
    inputSchema: [
      { name: 'name', type: 'string', description: 'Application name or path', required: true },
      { name: 'args', type: 'array', description: 'Command line arguments', required: false }
    ],
    outputSchema: [
      { name: 'success', type: 'boolean', description: 'Whether launch succeeded' },
      { name: 'pid', type: 'number', description: 'Process ID' }
    ],
    riskLevel: 2,
    preconditions: ['app installed'],
    postconditions: ['process running'],
    verificationStrategy: 'Check process is running',
    allowedEnvironments: ['local']
  },
  {
    name: 'close_app',
    description: 'Close an application',
    category: 'desktop',
    inputSchema: [
      { name: 'name', type: 'string', description: 'Application name', required: true },
      { name: 'force', type: 'boolean', description: 'Force close', required: false, default: false }
    ],
    outputSchema: [
      { name: 'success', type: 'boolean', description: 'Whether close succeeded' }
    ],
    riskLevel: 3,
    preconditions: ['app running'],
    postconditions: ['process terminated'],
    verificationStrategy: 'Verify process not running',
    allowedEnvironments: ['local']
  },
  {
    name: 'focus_window',
    description: 'Bring window to foreground',
    category: 'desktop',
    inputSchema: [
      { name: 'title', type: 'string', description: 'Window title or app name', required: true }
    ],
    outputSchema: [
      { name: 'success', type: 'boolean', description: 'Whether focus succeeded' }
    ],
    riskLevel: 2,
    preconditions: ['window exists'],
    postconditions: ['window in foreground'],
    verificationStrategy: 'Check window is focused',
    allowedEnvironments: ['local']
  },
  {
    name: 'clipboard_read',
    description: 'Read clipboard contents',
    category: 'desktop',
    inputSchema: [],
    outputSchema: [
      { name: 'content', type: 'string', description: 'Clipboard text content' }
    ],
    riskLevel: 1,
    preconditions: [],
    postconditions: [],
    verificationStrategy: 'Return clipboard content',
    allowedEnvironments: ['local']
  },
  {
    name: 'clipboard_write',
    description: 'Write to clipboard',
    category: 'desktop',
    inputSchema: [
      { name: 'content', type: 'string', description: 'Text to copy', required: true }
    ],
    outputSchema: [
      { name: 'success', type: 'boolean', description: 'Whether copy succeeded' }
    ],
    riskLevel: 2,
    preconditions: [],
    postconditions: ['content in clipboard'],
    verificationStrategy: 'Verify clipboard contains content',
    allowedEnvironments: ['local']
  },
  {
    name: 'screenshot',
    description: 'Take a screenshot',
    category: 'desktop',
    inputSchema: [
      { name: 'region', type: 'object', description: 'Region to capture {x, y, width, height}', required: false }
    ],
    outputSchema: [
      { name: 'path', type: 'string', description: 'Path to saved screenshot' }
    ],
    riskLevel: 1,
    preconditions: ['screen capture permission'],
    postconditions: ['screenshot file created'],
    verificationStrategy: 'Check file exists',
    allowedEnvironments: ['local']
  },
  {
    name: 'process_kill',
    description: 'Kill a process by ID or name',
    category: 'desktop',
    inputSchema: [
      { name: 'pid', type: 'number', description: 'Process ID', required: false },
      { name: 'name', type: 'string', description: 'Process name', required: false }
    ],
    outputSchema: [
      { name: 'success', type: 'boolean', description: 'Whether kill succeeded' }
    ],
    riskLevel: 3,
    preconditions: ['process exists'],
    postconditions: ['process terminated'],
    verificationStrategy: 'Verify process not running',
    allowedEnvironments: ['local']
  }
];

// Browser Capabilities (Risk Level 2-3)
export const BROWSER_CAPABILITIES: Capability[] = [
  {
    name: 'browser_open',
    description: 'Open a URL in browser',
    category: 'browser',
    inputSchema: [
      { name: 'url', type: 'string', description: 'URL to open', required: true },
      { name: 'newTab', type: 'boolean', description: 'Open in new tab', required: false, default: false }
    ],
    outputSchema: [
      { name: 'success', type: 'boolean', description: 'Whether open succeeded' },
      { name: 'tabId', type: 'string', description: 'Tab ID' }
    ],
    riskLevel: 2,
    preconditions: ['browser running'],
    postconditions: ['page loaded'],
    verificationStrategy: 'Check URL matches',
    allowedEnvironments: ['local']
  },
  {
    name: 'browser_click',
    description: 'Click an element on the page',
    category: 'browser',
    inputSchema: [
      { name: 'selector', type: 'string', description: 'CSS or XPath selector', required: true },
      { name: 'intent', type: 'string', description: 'Human-readable intent (for recovery)', required: false }
    ],
    outputSchema: [
      { name: 'success', type: 'boolean', description: 'Whether click succeeded' }
    ],
    riskLevel: 2,
    preconditions: ['page loaded', 'element exists'],
    postconditions: ['element clicked'],
    verificationStrategy: 'Check element state changed or URL changed',
    allowedEnvironments: ['local']
  },
  {
    name: 'browser_fill',
    description: 'Fill a form input',
    category: 'browser',
    inputSchema: [
      { name: 'selector', type: 'string', description: 'Input selector', required: true },
      { name: 'value', type: 'string', description: 'Value to fill', required: true }
    ],
    outputSchema: [
      { name: 'success', type: 'boolean', description: 'Whether fill succeeded' }
    ],
    riskLevel: 2,
    preconditions: ['input element exists'],
    postconditions: ['value entered'],
    verificationStrategy: 'Read back value matches input',
    allowedEnvironments: ['local']
  },
  {
    name: 'browser_navigate',
    description: 'Navigate to URL or go back/forward',
    category: 'browser',
    inputSchema: [
      { name: 'url', type: 'string', description: 'URL or direction (back/forward)', required: true }
    ],
    outputSchema: [
      { name: 'success', type: 'boolean', description: 'Whether navigation succeeded' }
    ],
    riskLevel: 2,
    preconditions: [],
    postconditions: ['page loaded'],
    verificationStrategy: 'Check URL changed',
    allowedEnvironments: ['local']
  },
  {
    name: 'browser_screenshot',
    description: 'Take a screenshot of current page',
    category: 'browser',
    inputSchema: [],
    outputSchema: [
      { name: 'path', type: 'string', description: 'Path to saved screenshot' }
    ],
    riskLevel: 1,
    preconditions: ['page loaded'],
    postconditions: ['screenshot saved'],
    verificationStrategy: 'Check file exists',
    allowedEnvironments: ['local']
  }
];

// Knowledge Capabilities (Risk Level 1)
export const KNOWLEDGE_CAPABILITIES: Capability[] = [
  {
    name: 'memory_search',
    description: 'Search episodic memory',
    category: 'knowledge',
    inputSchema: [
      { name: 'query', type: 'string', description: 'Search query', required: true },
      { name: 'limit', type: 'number', description: 'Max results', required: false, default: 5 }
    ],
    outputSchema: [
      { name: 'results', type: 'array', description: 'Search results' }
    ],
    riskLevel: 1,
    preconditions: [],
    postconditions: [],
    verificationStrategy: 'Return relevant results',
    allowedEnvironments: ['local']
  },
  {
    name: 'semantic_lookup',
    description: 'Semantic search across documents',
    category: 'knowledge',
    inputSchema: [
      { name: 'query', type: 'string', description: 'Natural language query', required: true },
      { name: 'sources', type: 'array', description: 'Source types to search', required: false }
    ],
    outputSchema: [
      { name: 'results', type: 'array', description: 'Ranked results with scores' }
    ],
    riskLevel: 1,
    preconditions: [],
    postconditions: [],
    verificationStrategy: 'Return relevant results with scores',
    allowedEnvironments: ['local']
  },
  {
    name: 'web_search',
    description: 'Search the web',
    category: 'knowledge',
    inputSchema: [
      { name: 'query', type: 'string', description: 'Search query', required: true },
      { name: 'limit', type: 'number', description: 'Max results', required: false, default: 10 }
    ],
    outputSchema: [
      { name: 'results', type: 'array', description: 'Search results with title, url, snippet' }
    ],
    riskLevel: 1,
    preconditions: ['network available'],
    postconditions: [],
    verificationStrategy: 'Return search results',
    allowedEnvironments: ['local', 'remote']
  }
];

// Automation Capabilities (Risk Level 2-4)
export const AUTOMATION_CAPABILITIES: Capability[] = [
  {
    name: 'workflow_execute',
    description: 'Execute a multi-step workflow',
    category: 'automation',
    inputSchema: [
      { name: 'workflowId', type: 'string', description: 'Workflow to execute', required: true },
      { name: 'params', type: 'object', description: 'Workflow parameters', required: false }
    ],
    outputSchema: [
      { name: 'success', type: 'boolean', description: 'Whether workflow completed' },
      { name: 'results', type: 'object', description: 'Step results' }
    ],
    riskLevel: 3,
    preconditions: ['workflow defined', 'permissions granted'],
    postconditions: ['all steps completed or failed'],
    verificationStrategy: 'Check all steps succeeded or proper error handling',
    allowedEnvironments: ['local']
  },
  {
    name: 'schedule_create',
    description: 'Create a scheduled task',
    category: 'automation',
    inputSchema: [
      { name: 'name', type: 'string', description: 'Schedule name', required: true },
      { name: 'cron', type: 'string', description: 'Cron expression', required: true },
      { name: 'action', type: 'object', description: 'Action to perform', required: true }
    ],
    outputSchema: [
      { name: 'success', type: 'boolean', description: 'Whether schedule created' }
    ],
    riskLevel: 2,
    preconditions: [],
    postconditions: ['schedule registered'],
    verificationStrategy: 'Check schedule exists',
    allowedEnvironments: ['local']
  },
  {
    name: 'notification_send',
    description: 'Send a notification',
    category: 'automation',
    inputSchema: [
      { name: 'title', type: 'string', description: 'Notification title', required: true },
      { name: 'body', type: 'string', description: 'Notification body', required: true },
      { name: 'urgency', type: 'string', description: 'low/normal/critical', required: false, default: 'normal' }
    ],
    outputSchema: [
      { name: 'success', type: 'boolean', description: 'Whether notification sent' }
    ],
    riskLevel: 2,
    preconditions: ['notification permission'],
    postconditions: ['notification displayed'],
    verificationStrategy: 'Check notification delivered',
    allowedEnvironments: ['local']
  }
];

// All capabilities combined
export const ALL_CAPABILITIES: Capability[] = [
  ...FILE_CAPABILITIES,
  ...DESKTOP_CAPABILITIES,
  ...BROWSER_CAPABILITIES,
  ...KNOWLEDGE_CAPABILITIES,
  ...AUTOMATION_CAPABILITIES
];

export class CapabilityRegistry {
  private capabilities: Map<string, Capability>;

  constructor() {
    this.capabilities = new Map();
    // Register all default capabilities
    for (const cap of ALL_CAPABILITIES) {
      this.capabilities.set(cap.name, cap);
    }
  }

  /**
   * Get a capability by name
   */
  get(name: string): Capability | undefined {
    return this.capabilities.get(name);
  }

  /**
   * Get all capabilities in a category
   */
  getByCategory(category: Capability['category']): Capability[] {
    return ALL_CAPABILITIES.filter(cap => cap.category === category);
  }

  /**
   * Get capabilities by risk level
   */
  getByRiskLevel(level: RiskLevel): Capability[] {
    return ALL_CAPABILITIES.filter(cap => cap.riskLevel === level);
  }

  /**
   * Get capabilities allowed in an environment
   */
  getByEnvironment(env: Environment): Capability[] {
    return ALL_CAPABILITIES.filter(cap =>
      cap.allowedEnvironments.includes(env) || cap.allowedEnvironments.includes('any')
    );
  }

  /**
   * Register a new capability
   */
  register(capability: Capability): void {
    this.capabilities.set(capability.name, capability);
  }

  /**
   * Get all capability names
   */
  list(): string[] {
    return Array.from(this.capabilities.keys());
  }

  /**
   * Check if a capability exists
   */
  has(name: string): boolean {
    return this.capabilities.has(name);
  }

  /**
   * Get capability schema for a tool call
   */
  validateCapability(name: string, params: Record<string, unknown>): {
    valid: boolean;
    errors: string[];
  } {
    const capability = this.capabilities.get(name);
    if (!capability) {
      return { valid: false, errors: [`Capability '${name}' not found`] };
    }

    const errors: string[] = [];

    // Check required parameters
    for (const param of capability.inputSchema) {
      if (param.required && !(param.name in params)) {
        errors.push(`Missing required parameter: ${param.name}`);
      }
    }

    // Check parameter types
    for (const [key, value] of Object.entries(params)) {
      const paramDef = capability.inputSchema.find(p => p.name === key);
      if (paramDef) {
        if (typeof value !== paramDef.type) {
          errors.push(`Parameter '${key}' should be type '${paramDef.type}', got '${typeof value}'`);
        }
      }
    }

    return { valid: errors.length === 0, errors };
  }
}

export const capabilityRegistry = new CapabilityRegistry();

export default CapabilityRegistry;
