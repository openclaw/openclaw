import type { ReplyPayload } from "../types.js";

type PersonaKind = "finance" | "research" | "builder" | "analyst" | "default";

const PERSONA_ICONS: Record<PersonaKind, string> = {
  finance: "🤖💵",
  research: "🤖🌐",
  builder: "🤖🛠️",
  analyst: "🤖📊",
  default: "🤖💬",
};

const ICON_PREFIX_RE = /^(?:🤖💵|🤖🌐|🤖🛠️|🤖📊|🤖💬)\s+/u;

const RESEARCH_TOOLS = new Set(["web_search", "web_fetch", "browser"]);
const BUILDER_TOOLS = new Set([
  "read",
  "write",
  "edit",
  "exec",
  "process",
  "gateway",
  "nodes",
  "sessions_send",
  "sessions_spawn",
  "subagents",
]);

const FINANCE_KEYWORDS = [
  "hyperliquid",
  "hl_trader",
  "trade",
  "trading",
  "position",
  "pnl",
  "leverage",
  "liquidation",
  "funding",
  "btc",
  "eth",
  "sol",
  "xrp",
  "doge",
  "usdc",
  "usdt",
  "perp",
  "futures",
];

const RESEARCH_KEYWORDS = [
  "search",
  "browse",
  "look up",
  "lookup",
  "web",
  "latest",
  "news",
  "docs",
  "documentation",
];

const BUILDER_KEYWORDS = [
  "code",
  "bug",
  "deploy",
  "server",
  "docker",
  "config",
  "ssh",
  "script",
  "build",
  "debug",
  "gateway",
];

const ANALYST_KEYWORDS = [
  "analyze",
  "analysis",
  "compare",
  "plan",
  "estimate",
  "forecast",
  "summary",
  "report",
  "breakdown",
];

function hasKeyword(text: string, keywords: string[]): boolean {
  const haystack = text.toLowerCase();
  return keywords.some((keyword) => haystack.includes(keyword));
}

function choosePersonaFromText(text: string): PersonaKind {
  if (hasKeyword(text, FINANCE_KEYWORDS)) {
    return "finance";
  }
  if (hasKeyword(text, RESEARCH_KEYWORDS)) {
    return "research";
  }
  if (hasKeyword(text, BUILDER_KEYWORDS)) {
    return "builder";
  }
  if (hasKeyword(text, ANALYST_KEYWORDS)) {
    return "analyst";
  }
  return "default";
}

export function resolvePersonaIcon(params: {
  toolMetas?: Array<{ toolName?: string; meta?: string }>;
  summaryLine?: string;
  commandBody?: string;
  payloads?: ReplyPayload[];
}): string {
  const toolMetas = params.toolMetas ?? [];
  const toolNames = toolMetas
    .map((entry) => entry.toolName?.trim().toLowerCase())
    .filter((name): name is string => Boolean(name));
  const metaBlob = toolMetas
    .map((entry) => `${entry.toolName ?? ""} ${entry.meta ?? ""}`.toLowerCase())
    .join("\n");

  if (
    toolNames.some((name) => name.includes("hyperliquid")) ||
    hasKeyword(metaBlob, FINANCE_KEYWORDS)
  ) {
    return PERSONA_ICONS.finance;
  }
  if (toolNames.some((name) => RESEARCH_TOOLS.has(name))) {
    return PERSONA_ICONS.research;
  }
  if (toolNames.some((name) => BUILDER_TOOLS.has(name))) {
    return PERSONA_ICONS.builder;
  }

  const summary = params.summaryLine?.trim() ?? "";
  const commandBody = params.commandBody?.trim() ?? "";
  const payloadText = (params.payloads ?? [])
    .map((payload) => (typeof payload.text === "string" ? payload.text : ""))
    .join("\n");
  const combinedText = [summary, commandBody, payloadText].filter(Boolean).join("\n");
  const persona = choosePersonaFromText(combinedText);
  return PERSONA_ICONS[persona];
}

export function applyPersonaPrefix(payloads: ReplyPayload[], icon: string): ReplyPayload[] {
  return payloads.map((payload) => {
    if (typeof payload.text !== "string") {
      return payload;
    }
    const trimmed = payload.text.trimStart();
    if (!trimmed) {
      return payload;
    }
    const withoutExistingIcon = trimmed.replace(ICON_PREFIX_RE, "");
    return {
      ...payload,
      text: `${icon} ${withoutExistingIcon}`,
    };
  });
}
