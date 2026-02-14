import { theme } from "./theme/theme.js";

export interface FooterState {
  model: string;
  tokPerSec?: number;
  totalTokens?: number;
  contextTokens?: number;
  connectivityStatus: string;
  ollamaHealthy: boolean;
}

function formatCompact(n: number): string {
  if (n >= 1000) {
    return `${(n / 1000).toFixed(1)}k`;
  }
  return String(n);
}

function tokenPct(total: number, context: number): number {
  return Math.round((total / context) * 100);
}

export function formatFooter(state: FooterState): string {
  const parts: string[] = [];

  // Model name with green accent
  parts.push(theme.accent(`🌿 ${state.model}`));

  // Tokens per second
  const tps = state.tokPerSec != null ? `${state.tokPerSec.toFixed(1)} t/s` : "— t/s";
  parts.push(tps);

  // Token usage
  if (state.totalTokens != null && state.contextTokens != null && state.contextTokens > 0) {
    const pct = tokenPct(state.totalTokens, state.contextTokens);
    parts.push(
      `tokens ${formatCompact(state.totalTokens)}/${formatCompact(state.contextTokens)} (${pct}%)`,
    );
  } else if (state.totalTokens != null) {
    parts.push(`tokens ${formatCompact(state.totalTokens)}`);
  }

  // Connectivity / health
  if (!state.ollamaHealthy) {
    parts.push(theme.error("⚠ no-ollama"));
  } else {
    parts.push(state.connectivityStatus);
  }

  return parts.join(theme.dim(" • "));
}
