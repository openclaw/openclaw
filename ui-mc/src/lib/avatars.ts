// Agent avatars served from /public/agents/ (static paths)
// All 80+ agents mapped; unknown agents fall back via getAvatar()

export const avatarMap: Record<string, string> = {
  // Core OpenClaw agents
  main: "/agents/aria.png",
  "trading-bitcoin": "/agents/vance.png",
  "ops-builder": "/agents/dev.png",
  "content-creator": "/agents/echo.png",
  "content-poster": "/agents/flux.png",
  scheduler: "/agents/nova.png",
  "trading-research": "/agents/sage.png",
  "pattern-tracker": "/agents/ember.png",
  "security-1": "/agents/dev.png",
  "security-2": "/agents/sage.png",
  "security-3": "/agents/aria.png",
  // Engineering
  "frontend-dev": "/agents/echo.png",
  "backend-arch": "/agents/sage.png",
  "mobile-dev": "/agents/nova.png",
  "ai-engineer": "/agents/dev.png",
  "devops-auto": "/agents/vance.png",
  "rapid-proto": "/agents/flux.png",
  "senior-dev": "/agents/aria.png",
  "security-eng": "/agents/ember.png",
  "technical-writer": "/agents/echo.png",
  "data-engineer": "/agents/dev.png",
  "auto-opt-arch": "/agents/sage.png",
  // Design
  "brand-guard": "/agents/aria.png",
  "image-prompt": "/agents/nova.png",
  "inclusive-visuals": "/agents/flux.png",
  "ui-designer": "/agents/echo.png",
  "ux-architect": "/agents/sage.png",
  "ux-researcher": "/agents/vance.png",
  "visual-story": "/agents/nova.png",
  "whimsy-inject": "/agents/flux.png",
  // Marketing
  "app-store-opt": "/agents/dev.png",
  "growth-hacker": "/agents/ember.png",
  "instagram-cur": "/agents/aria.png",
  "reddit-builder": "/agents/vance.png",
  "social-media": "/agents/echo.png",
  "tiktok-strat": "/agents/sage.png",
  "twitter-engager": "/agents/nova.png",
  "wechat-mgr": "/agents/dev.png",
  xiaohongshu: "/agents/flux.png",
  "zhihu-strat": "/agents/ember.png",
  // Product
  "behavioral-nudge": "/agents/aria.png",
  "feedback-synth": "/agents/vance.png",
  "sprint-prior": "/agents/dev.png",
  "trend-research": "/agents/sage.png",
  // Project Management
  "experiment-track": "/agents/echo.png",
  "project-shep": "/agents/nova.png",
  "studio-ops": "/agents/flux.png",
  "studio-prod": "/agents/ember.png",
  "senior-pm": "/agents/aria.png",
  // Testing
  "accessibility-audit": "/agents/dev.png",
  "api-tester": "/agents/sage.png",
  "evidence-collect": "/agents/vance.png",
  "perf-benchmark": "/agents/nova.png",
  "reality-check": "/agents/ember.png",
  "test-analyzer": "/agents/echo.png",
  "tool-evaluator": "/agents/flux.png",
  "workflow-opt": "/agents/aria.png",
  // Support
  "analytics-rep": "/agents/dev.png",
  "exec-summary": "/agents/sage.png",
  "finance-track": "/agents/vance.png",
  "infra-maintain": "/agents/nova.png",
  "legal-compliance": "/agents/ember.png",
  "support-respond": "/agents/aria.png",
  // Spatial Computing
  "macos-spatial": "/agents/echo.png",
  "terminal-integ": "/agents/dev.png",
  "visionos-spatial": "/agents/flux.png",
  "xr-cockpit": "/agents/sage.png",
  "xr-immersive": "/agents/vance.png",
  "xr-architect": "/agents/nova.png",
  // Specialized
  "agentic-identity": "/agents/ember.png",
  "agents-orchestrator": "/agents/aria.png",
  "data-analytics": "/agents/dev.png",
  "data-consolidate": "/agents/echo.png",
  "lsp-engineer": "/agents/sage.png",
  "report-distribute": "/agents/flux.png",
  "sales-extract": "/agents/vance.png",
  "cultural-intel": "/agents/nova.png",
  "developer-advocate": "/agents/ember.png",
  // Legacy names
  aria: "/agents/aria.png",
  vance: "/agents/vance.png",
  dev: "/agents/dev.png",
  echo: "/agents/echo.png",
  flux: "/agents/flux.png",
  nova: "/agents/nova.png",
  sage: "/agents/sage.png",
  ember: "/agents/ember.png",
};

const AVATAR_FILES = ["aria", "vance", "dev", "echo", "flux", "nova", "sage", "ember"];

/** Always returns a valid avatar path — falls back by ID hash if unknown */
export function getAvatar(agentId: string, fallback?: string): string {
  return (
    avatarMap[agentId] ??
    fallback ??
    `/agents/${AVATAR_FILES[agentId.length % AVATAR_FILES.length]}.png`
  );
}
