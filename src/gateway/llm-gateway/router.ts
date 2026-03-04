/**
 * LLM Gateway Router
 *
 * Three-tier routing: Local -> Cheap -> Premium
 * Intelligent query classification and cost optimization
 */

import type {
  GatewayRequest,
  RoutingContext,
  RoutingDecision,
  QueryIntent,
  TierLevel,
  LLMGatewayConfig,
} from "./types.js";

// Intent detection patterns
const INTENT_PATTERNS: Record<QueryIntent, RegExp[]> = {
  simple: [
    /^(hi|hello|hey|thanks|please|ok|yes|no|sure)[!.]?$/i,
    /^(what is|define|explain briefly)/i,
    /^\w{1,20}$/, // Very short queries
  ],
  code_generation: [
    /write (me )?(a |the )?(function|class|module|script|program)/i,
    /implement (a |the )?\w+/i,
    /create (a |the )?(new |api |rest )?\w+/i,
    /generate (code|a function|a class)/i,
    /code (for|that|to)/i,
  ],
  code_edit: [
    /fix (the |this )?(bug|error|issue|problem)/i,
    /refactor (this|the|my) /i,
    /update (the |this )?(code|function|class)/i,
    /modify|change|edit|patch/i,
    /apply (this |the )?change/i,
  ],
  analysis: [
    /analyze|review|audit|examine/i,
    /explain (how|why|what)/i,
    /what does (this |the )?code do/i,
    /find (the |all )?(bugs|issues|problems|vulnerabilities)/i,
  ],
  research: [
    /research|investigate|explore|look up|find out/i,
    /search (for|about|the)/i,
    /what are (the |current )?(latest|recent|best)/i,
    /compare|contrast|difference between/i,
  ],
  creative: [
    /write (a |an |the )?(story|poem|article|email|letter|blog)/i,
    /create (a |an )?(creative|engaging|interesting)/i,
    /brainstorm|ideate|suggest ideas/i,
    /generate (a |an )?(creative|unique|original)/i,
  ],
  vision: [
    /look at (this |the )?(image|picture|screenshot|diagram)/i,
    /what('s| is) (in |on |this )?(the |this )?(image|picture|photo)/i,
    /describe (this |the )?(image|picture|screenshot)/i,
    /analyze (this |the )?(image|visual|diagram)/i,
    /ocr|read (the )?text (in |from )?(this|the)/i,
  ],
  tool_use: [
    /run|execute|call|invoke/i,
    /use (the )?\w+ (tool|api|service)/i,
    /fetch|download|upload|send/i,
    /read|write|delete|list/i,
  ],
};

// Complexity scoring factors
const COMPLEXITY_FACTORS = {
  messageCount: { weight: 0.1, threshold: 5 },
  tokenCount: { weight: 0.2, threshold: 2000 },
  hasImages: { weight: 0.3, threshold: 1 },
  hasTools: { weight: 0.15, threshold: 1 },
  codeBlocks: { weight: 0.1, threshold: 2 },
  technicalTerms: { weight: 0.15, threshold: 5 },
};

const TECHNICAL_TERMS = new Set([
  "algorithm",
  "async",
  "await",
  "class",
  "closure",
  "component",
  "const",
  "constructor",
  "decorator",
  "dependency",
  "destructure",
  "endpoint",
  "enum",
  "function",
  "generic",
  "hook",
  "immutable",
  "interface",
  "iterator",
  "lambda",
  "middleware",
  "module",
  "namespace",
  "null",
  "object",
  "parameter",
  "polymorphism",
  "promise",
  "prototype",
  "recursion",
  "refactor",
  "regex",
  "rest",
  "return",
  "scope",
  "singleton",
  "state",
  "static",
  "template",
  "this",
  "thread",
  "type",
  "undefined",
  "variable",
  "void",
]);

export class LLMGatewayRouter {
  private config: LLMGatewayConfig;

  constructor(config: LLMGatewayConfig) {
    this.config = config;
  }

  /**
   * Main routing decision function
   */
  route(request: GatewayRequest): RoutingDecision {
    const context = this.analyzeRequest(request);
    const tier = this.selectTier(context, request);
    const provider = this.selectProvider(tier);
    const model = this.selectModel(tier, context);

    return {
      tier,
      provider: provider.name,
      model,
      reason: this.explainRouting(context, tier),
      estimatedCost: this.estimateCost(context, tier),
      estimatedLatencyMs: this.estimateLatency(tier, context),
    };
  }

  /**
   * Analyze request to build routing context
   */
  analyzeRequest(request: GatewayRequest): RoutingContext {
    const query = this.extractQuery(request.messages);
    const messageCount = request.messages.length;
    const totalTokens = this.estimateTokens(request.messages);
    const hasTools = Boolean(request.tools?.length);
    const hasImages = this.hasImages(request.messages);
    const requiresSearch = this.detectSearchIntent(query);
    const intent = this.detectIntent(query);
    const complexityScore = this.calculateComplexity({
      messageCount,
      totalTokens,
      hasImages,
      hasTools,
      query,
    });

    return {
      query,
      messageCount,
      totalTokens,
      hasTools,
      hasImages,
      requiresSearch,
      complexityScore,
      intent,
    };
  }

  /**
   * Extract the main query from messages
   */
  private extractQuery(messages: GatewayRequest["messages"]): string {
    // Get last user message
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === "user") {
        if (typeof msg.content === "string") {
          return msg.content;
        }
        // Extract text from content blocks
        const textBlocks = msg.content.filter((b) => b.type === "text");
        return textBlocks.map((b) => b.text || "").join(" ");
      }
    }
    return "";
  }

  /**
   * Detect query intent using pattern matching
   */
  private detectIntent(query: string): QueryIntent {
    for (const [intent, patterns] of Object.entries(INTENT_PATTERNS)) {
      for (const pattern of patterns) {
        if (pattern.test(query)) {
          return intent as QueryIntent;
        }
      }
    }
    return "simple";
  }

  /**
   * Detect if query requires web search
   */
  private detectSearchIntent(query: string): boolean {
    const searchPatterns = [
      /current|latest|recent|today|now/i,
      /what('s| is) (new|happening|trending)/i,
      /news|update|status/i,
      /recherchiere|aktuell|find out about/i, // German patterns
      /search|lookup|look up/i,
    ];
    return searchPatterns.some((p) => p.test(query));
  }

  /**
   * Check if messages contain images
   */
  private hasImages(messages: GatewayRequest["messages"]): boolean {
    return messages.some((msg) => {
      if (typeof msg.content === "string") {
        return false;
      }
      return msg.content.some((block) => block.type === "image");
    });
  }

  /**
   * Estimate token count (rough approximation)
   */
  private estimateTokens(messages: GatewayRequest["messages"]): number {
    let total = 0;
    for (const msg of messages) {
      if (typeof msg.content === "string") {
        // Rough: ~4 chars per token
        total += Math.ceil(msg.content.length / 4);
      } else {
        for (const block of msg.content) {
          if (block.text) {
            total += Math.ceil(block.text.length / 4);
          }
          if (block.type === "image") {
            // Images typically use 85-1105 tokens depending on size
            total += 300;
          }
        }
      }
    }
    return total;
  }

  /**
   * Calculate complexity score (0-1)
   */
  private calculateComplexity(params: {
    messageCount: number;
    totalTokens: number;
    hasImages: boolean;
    hasTools: boolean;
    query: string;
  }): number {
    let score = 0;

    // Message count factor
    score += Math.min(
      (params.messageCount / COMPLEXITY_FACTORS.messageCount.threshold) *
        COMPLEXITY_FACTORS.messageCount.weight,
      COMPLEXITY_FACTORS.messageCount.weight,
    );

    // Token count factor
    score += Math.min(
      (params.totalTokens / COMPLEXITY_FACTORS.tokenCount.threshold) *
        COMPLEXITY_FACTORS.tokenCount.weight,
      COMPLEXITY_FACTORS.tokenCount.weight,
    );

    // Image factor
    if (params.hasImages) {
      score += COMPLEXITY_FACTORS.hasImages.weight;
    }

    // Tool factor
    if (params.hasTools) {
      score += COMPLEXITY_FACTORS.hasTools.weight;
    }

    // Code block detection
    const codeBlockMatches = params.query.match(/```/g);
    if (codeBlockMatches) {
      const codeBlockCount = codeBlockMatches.length / 2;
      score += Math.min(
        (codeBlockCount / COMPLEXITY_FACTORS.codeBlocks.threshold) *
          COMPLEXITY_FACTORS.codeBlocks.weight,
        COMPLEXITY_FACTORS.codeBlocks.weight,
      );
    }

    // Technical term detection
    const words = params.query.toLowerCase().split(/\s+/);
    const techTermCount = words.filter((w) => TECHNICAL_TERMS.has(w)).length;
    score += Math.min(
      (techTermCount / COMPLEXITY_FACTORS.technicalTerms.threshold) *
        COMPLEXITY_FACTORS.technicalTerms.weight,
      COMPLEXITY_FACTORS.technicalTerms.weight,
    );

    return Math.min(score, 1);
  }

  /**
   * Select tier based on context and config
   */
  private selectTier(context: RoutingContext, request: GatewayRequest): TierLevel {
    // Explicit tier override
    if (request.tier) {
      return request.tier;
    }

    // Strategy-based routing
    switch (this.config.routing.strategy) {
      case "cascade":
        return this.cascadeRouting(context);
      case "cost_optimized":
        return this.costOptimizedRouting(context);
      case "quality_first":
        return this.qualityFirstRouting(context);
      default:
        return "cheap";
    }
  }

  /**
   * Cascade routing: start cheap, escalate if needed
   */
  private cascadeRouting(context: RoutingContext): TierLevel {
    // Vision always needs premium (local/cheap models often lack vision)
    if (context.hasImages && context.complexityScore > 0.5) {
      return "premium";
    }

    // Research/search queries can use cheap with tool calling
    if (context.requiresSearch) {
      return "cheap";
    }

    // Complex tasks need premium
    if (context.complexityScore > 0.7) {
      return "premium";
    }

    // Code generation/editing: medium complexity uses cheap_plus
    if (
      (context.intent === "code_generation" || context.intent === "code_edit") &&
      context.complexityScore > 0.4
    ) {
      return "premium";
    }

    // Default to cheap for most queries
    return "cheap";
  }

  /**
   * Cost-optimized routing: minimize cost while maintaining quality
   */
  private costOptimizedRouting(context: RoutingContext): TierLevel {
    // Only escalate to premium for complex vision or very complex code
    if (context.hasImages && context.complexityScore > 0.8) {
      return "premium";
    }

    if (context.intent === "code_generation" && context.complexityScore > 0.8) {
      return "premium";
    }

    // Everything else uses cheap
    return "cheap";
  }

  /**
   * Quality-first routing: prioritize quality over cost
   */
  private qualityFirstRouting(context: RoutingContext): TierLevel {
    // Most tasks get premium
    if (context.complexityScore > 0.3) {
      return "premium";
    }

    // Simple queries can use cheap
    return "cheap";
  }

  /**
   * Select provider for tier
   */
  private selectProvider(tier: TierLevel) {
    switch (tier) {
      case "local":
        return this.config.providers.local || this.config.providers.cheap;
      case "cheap":
        return this.config.providers.cheap;
      case "premium":
        return this.config.providers.premium;
      default:
        return this.config.providers.cheap;
    }
  }

  /**
   * Select model based on tier and context
   */
  private selectModel(tier: TierLevel, context: RoutingContext): string {
    const provider = this.selectProvider(tier);

    // Model selection based on intent
    if (tier === "cheap") {
      if (context.intent === "code_generation" || context.intent === "code_edit") {
        // Use larger model for code tasks
        return provider.models?.[1] || provider.defaultModel;
      }
      return provider.defaultModel;
    }

    if (tier === "premium") {
      if (context.complexityScore > 0.8 || context.intent === "analysis") {
        // Use more capable model for complex tasks
        return provider.models?.[2] || provider.models?.[1] || provider.defaultModel;
      }
      return provider.defaultModel;
    }

    return provider.defaultModel;
  }

  /**
   * Explain routing decision
   */
  private explainRouting(context: RoutingContext, tier: TierLevel): string {
    const reasons: string[] = [];

    if (context.hasImages) {
      reasons.push("has images");
    }
    if (context.requiresSearch) {
      reasons.push("requires search");
    }
    if (context.complexityScore > 0.7) {
      reasons.push("high complexity");
    }
    if (context.intent !== "simple") {
      reasons.push(`intent: ${context.intent}`);
    }

    if (reasons.length === 0) {
      reasons.push("standard query");
    }

    return `Routed to ${tier} tier: ${reasons.join(", ")}`;
  }

  /**
   * Estimate cost for request
   */
  private estimateCost(context: RoutingContext, tier: TierLevel): number {
    const provider = this.selectProvider(tier);
    const tokens = context.totalTokens + (context.hasImages ? 300 : 0);
    return (tokens / 1000) * provider.costPer1kTokens;
  }

  /**
   * Estimate latency
   */
  private estimateLatency(tier: TierLevel, context: RoutingContext): number {
    const baseLatency = {
      local: 100,
      cheap: 500,
      premium: 1500,
    };

    const tokenFactor = context.totalTokens / 1000;
    const imageFactor = context.hasImages ? 500 : 0;

    return baseLatency[tier] + tokenFactor * 100 + imageFactor;
  }
}
