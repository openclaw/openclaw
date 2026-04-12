import path from "node:path";

const CHIEF_REPLY_STYLE_GUARD_HEADING = "## Chief Reply Style Guard";

type ChiefReplyStyleGuardParams = {
  agentId?: string;
  workspaceDir?: string;
  isHeartbeat?: boolean;
  userText?: string;
};

function isSimpleGreeting(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return [
    "hi",
    "hello",
    "hey",
    "yo",
    "sup",
    "what's up",
    "whats up",
    "morning",
    "good morning",
    "evening",
    "good evening",
  ].includes(normalized);
}

export function isChiefReplyStyleGuardTarget(params: {
  agentId?: string;
  workspaceDir?: string;
}): boolean {
  if (params.agentId?.trim().toLowerCase() === "chief") {
    return true;
  }
  const base = params.workspaceDir ? path.basename(params.workspaceDir).toLowerCase() : "";
  return base === "workspace-chief";
}

export function buildChiefReplyStyleGuard(params: ChiefReplyStyleGuardParams): string | undefined {
  if (params.isHeartbeat || !isChiefReplyStyleGuardTarget(params)) {
    return undefined;
  }

  const lines = [
    CHIEF_REPLY_STYLE_GUARD_HEADING,
    "- Default to clean, concise, directly useful replies.",
    "- Answer the user's actual question or request first.",
    "- Keep ordinary replies short unless the user explicitly asks for depth, planning, strategy, or coaching.",
    "- Do not add unsolicited pep talk, emotional framing, or Dec 2027 / career framing unless the user asks for that lane.",
    "- Do not narrate internal delegation, scouting, waiting, or planned subagent use unless the user asked for delegation or needs a status update.",
    "- Do not present multiple options unless the user asked for options or the decision is genuinely ambiguous.",
    "- Offer at most one follow-up question or one next-step offer when helpful.",
    "- Do not restate the same recommendation in multiple framings.",
  ];

  if (params.userText && isSimpleGreeting(params.userText)) {
    lines.push(
      "- For greetings or simple check-ins, reply in one short sentence plus one short question.",
    );
  }

  return lines.join("\n");
}

export function appendChiefReplyStyleGuard(
  existingPrompt: string | undefined,
  guard: string | undefined,
): string | undefined {
  if (!guard) {
    return existingPrompt;
  }
  if (existingPrompt?.includes(CHIEF_REPLY_STYLE_GUARD_HEADING)) {
    return existingPrompt;
  }
  return [existingPrompt, guard].filter(Boolean).join("\n\n");
}
