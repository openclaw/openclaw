/**
 * Task Router - Classifies user requests into appropriate categories
 *
 * This is the core of Phase 1: Architecture Core
 *
 * Task categories:
 * - CODE: Coding, file editing, repo operations
 * - DESKTOP: App control, clipboard, window management
 * - BROWSER: Web navigation, form filling, search
 * - KNOWLEDGE: RAG, lookup, summarization
 * - AUTOMATION: Multi-step workflows, triggers
 */

export type TaskCategory =
  | 'code'
  | 'desktop'
  | 'browser'
  | 'knowledge'
  | 'automation'
  | 'unknown';

export interface TaskClassification {
  category: TaskCategory;
  confidence: number;
  intent: string;
  keywords: string[];
  suggestedCapabilities: string[];
}

export interface TaskRouterConfig {
  // Keywords for each category
  codeKeywords: string[];
  desktopKeywords: string[];
  browserKeywords: string[];
  knowledgeKeywords: string[];
  automationKeywords: string[];

  // Minimum confidence threshold
  minConfidence: number;
}

const DEFAULT_CONFIG: TaskRouterConfig = {
  codeKeywords: [
    'code', 'file', 'function', 'class', 'debug', 'test', 'build', 'run',
    'edit', 'create', 'modify', 'refactor', 'lint', 'compile', 'deploy',
    'git', 'commit', 'branch', 'merge', 'pr', 'patch', 'diff', 'repo',
    'javascript', 'typescript', 'python', 'java', 'rust', 'go', 'c++',
    'npm', 'pnpm', 'yarn', 'pip', 'cargo', 'make', 'cmake',
    'error', 'bug', 'fix', 'implement', 'feature', 'api', 'endpoint'
  ],
  desktopKeywords: [
    'open', 'close', 'launch', 'start', 'quit', 'app', 'application',
    'window', 'focus', 'minimize', 'maximize', 'resize', 'move',
    'clipboard', 'copy', 'paste', 'cut', 'screenshot', 'screen capture',
    'file', 'folder', 'directory', 'delete', 'rename', 'move', 'copy',
    'terminal', 'cmd', 'powershell', 'bash', 'process', 'task', 'kill',
    'notification', 'alert', 'sound', 'volume', 'print', 'dialog'
  ],
  browserKeywords: [
    'browse', 'search', 'google', 'navigate', 'url', 'website', 'web',
    'click', 'fill', 'form', 'login', 'logout', 'submit', 'download',
    'scroll', 'screenshot', 'tab', 'bookmark', 'history', 'password',
    'youtube', 'facebook', 'twitter', 'instagram', 'reddit', 'news',
    'shop', 'buy', 'cart', 'checkout', 'amazon', 'ebay', 'shopee',
    'mail', 'email', 'gmail', 'inbox', 'send', 'compose'
  ],
  knowledgeKeywords: [
    'what is', 'who is', 'how does', 'explain', 'describe', 'define',
    'search', 'find', 'lookup', 'query', 'find information', 'research',
    'summarize', 'summary', 'extract', 'analyze', 'compare', 'contrast',
    'document', 'documentation', 'read', 'article', 'paper', 'book',
    'question', 'answer', 'faq', 'help', 'tutorial', 'guide'
  ],
  automationKeywords: [
    'schedule', 'cron', 'repeat', 'loop', 'automate', 'workflow',
    'trigger', 'event', 'when', 'if', 'then', 'else', 'condition',
    'daily', 'weekly', 'monthly', 'hourly', 'periodic', 'recurring',
    'backup', 'sync', 'export', 'import', 'batch', 'bulk',
    'notify', 'alert', 'remind', 'timer', 'countdown'
  ],
  minConfidence: 0.5
};

export class TaskRouter {
  private config: TaskRouterConfig;

  constructor(config: Partial<TaskRouterConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Classify a user request into a task category
   */
  classify(userMessage: string): TaskClassification {
    const message = userMessage.toLowerCase();
    const words = message.split(/\s+/);

    // Score each category
    const scores = {
      code: this.calculateScore(message, words, this.config.codeKeywords),
      desktop: this.calculateScore(message, words, this.config.desktopKeywords),
      browser: this.calculateScore(message, words, this.config.browserKeywords),
      knowledge: this.calculateScore(message, words, this.config.knowledgeKeywords),
      automation: this.calculateScore(message, words, this.config.automationKeywords),
    };

    // Find highest scoring category
    let maxCategory: TaskCategory = 'unknown';
    let maxScore = 0;

    for (const [category, score] of Object.entries(scores)) {
      if (score > maxScore) {
        maxScore = score;
        maxCategory = category as TaskCategory;
      }
    }

    // If max score is below threshold, return unknown
    if (maxScore < this.config.minConfidence) {
      return {
        category: 'unknown',
        confidence: maxScore,
        intent: this.extractIntent(message),
        keywords: this.extractKeywords(message),
        suggestedCapabilities: []
      };
    }

    return {
      category: maxCategory,
      confidence: maxScore,
      intent: this.extractIntent(message),
      keywords: this.extractKeywords(message),
      suggestedCapabilities: this.getSuggestedCapabilities(maxCategory)
    };
  }

  /**
   * Calculate keyword match score
   */
  private calculateScore(message: string, words: string[], keywords: string[]): number {
    let score = 0;
    let matches = 0;

    for (const keyword of keywords) {
      if (message.includes(keyword)) {
        matches++;
        // Weight based on position (earlier = more important)
        const position = message.indexOf(keyword);
        const positionWeight = 1 - (position / message.length) * 0.5;
        score += positionWeight;
      }
    }

    // Normalize score
    const maxPossibleScore = keywords.length;
    return Math.min(score / maxPossibleScore * 10, 1);
  }

  /**
   * Extract the main intent from the message
   */
  private extractIntent(message: string): string {
    // Simple intent extraction based on action verbs
    const actionPatterns = [
      { pattern: /^(open|launch|start|create)/, intent: 'create' },
      { pattern: /^(edit|modify|update|change)/, intent: 'modify' },
      { pattern: /^(delete|remove|kill)/, intent: 'delete' },
      { pattern: /^(get|fetch|read|find|search|lookup)/, intent: 'read' },
      { pattern: /^(run|execute|build|test)/, intent: 'execute' },
      { pattern: /^(help|explain|describe)/, intent: 'help' },
      { pattern: /^(list|show|display)/, intent: 'list' },
    ];

    for (const { pattern, intent } of actionPatterns) {
      if (pattern.test(message)) {
        return intent;
      }
    }

    return 'general';
  }

  /**
   * Extract keywords from the message
   */
  private extractKeywords(message: string): string[] {
    const allKeywords = [
      ...this.config.codeKeywords,
      ...this.config.desktopKeywords,
      ...this.config.browserKeywords,
      ...this.config.knowledgeKeywords,
      ...this.config.automationKeywords,
    ];

    return allKeywords.filter(keyword => message.includes(keyword));
  }

  /**
   * Get suggested capabilities based on category
   */
  private getSuggestedCapabilities(category: TaskCategory): string[] {
    const capabilityMap: Record<TaskCategory, string[]> = {
      code: [
        'read_file',
        'write_file',
        'edit_file',
        'bash',
        'glob',
        'grep',
        'apply_patch',
        'run_tests'
      ],
      desktop: [
        'launch_app',
        'close_app',
        'focus_window',
        'clipboard_read',
        'clipboard_write',
        'screenshot',
        'process_kill'
      ],
      browser: [
        'browser_open',
        'browser_click',
        'browser_fill',
        'browser_navigate',
        'browser_screenshot'
      ],
      knowledge: [
        'memory_search',
        'semantic_lookup',
        'document_read',
        'web_search'
      ],
      automation: [
        'workflow_execute',
        'schedule_create',
        'trigger_register',
        'notification_send'
      ],
      unknown: []
    };

    return capabilityMap[category] || [];
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<TaskRouterConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Add custom keywords to a category
   */
  addKeywords(category: keyof TaskRouterConfig, keywords: string[]): void {
    const key = `${category}Keywords` as keyof TaskRouterConfig;
    if (Array.isArray(this.config[key])) {
      this.config[key] = [...(this.config[key] as string[]), ...keywords];
    }
  }
}

export const taskRouter = new TaskRouter();

export default TaskRouter;
