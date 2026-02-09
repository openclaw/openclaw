export type ReadAiTransformResult = {
  message: string;
  name: string;
  sessionKey: string;
} | null;

export function transformReadAiPayload(payload: Record<string, unknown>): ReadAiTransformResult {
  const trigger = typeof payload.trigger === "string" ? payload.trigger : "";
  if (trigger !== "meeting_end") {
    return null;
  }

  const title = stringField(payload, "title") || "Untitled Meeting";
  const sessionId = stringField(payload, "session_id") || "unknown";
  const summary = stringField(payload, "summary") || "";
  const reportUrl = stringField(payload, "report_url") || "";

  const owner = payload.owner as Record<string, unknown> | undefined;
  const organizer = owner ? stringField(owner, "name") || stringField(owner, "email") || "" : "";

  const startDate = stringField(payload, "start_time") || "";
  const endDate = stringField(payload, "end_time") || "";

  const participants = Array.isArray(payload.participants) ? payload.participants : [];
  const actionItems = Array.isArray(payload.action_items) ? payload.action_items : [];
  const keyQuestions = Array.isArray(payload.key_questions) ? payload.key_questions : [];
  const topics = Array.isArray(payload.topics) ? payload.topics : [];

  const lines: string[] = [];
  lines.push(`## Meeting Notes: ${title}`);

  if (startDate || endDate) {
    const range = [startDate, endDate].filter(Boolean).join(" - ");
    lines.push(`**Date:** ${range}`);
  }
  if (organizer) {
    lines.push(`**Organizer:** ${organizer}`);
  }
  if (participants.length > 0) {
    const names = participants
      .map((p) => {
        if (typeof p === "string") {
          return p;
        }
        if (typeof p === "object" && p !== null) {
          const rec = p as Record<string, unknown>;
          return stringField(rec, "name") || stringField(rec, "email") || "";
        }
        return "";
      })
      .filter(Boolean);
    if (names.length > 0) {
      lines.push(`**Participants:** ${names.join(", ")}`);
    }
  }
  if (reportUrl) {
    lines.push(`**Report:** ${reportUrl}`);
  }

  lines.push("");

  if (summary) {
    lines.push("### Summary");
    lines.push(summary);
    lines.push("");
  }

  if (actionItems.length > 0) {
    lines.push("### Action Items");
    for (const item of actionItems) {
      const text = typeof item === "string" ? item : "";
      if (text) {
        lines.push(`- ${text}`);
      }
    }
    lines.push("");
  }

  if (keyQuestions.length > 0) {
    lines.push("### Key Questions");
    for (const q of keyQuestions) {
      const text = typeof q === "string" ? q : "";
      if (text) {
        lines.push(`- ${text}`);
      }
    }
    lines.push("");
  }

  if (topics.length > 0) {
    lines.push("### Topics Discussed");
    for (const topic of topics) {
      const text = typeof topic === "string" ? topic : "";
      if (text) {
        lines.push(`- ${text}`);
      }
    }
    lines.push("");
  }

  const message = lines.join("\n").trim();
  const sessionKey = `webhook:readai:${sessionId}`;

  return {
    message,
    name: "Read.ai",
    sessionKey,
  };
}

function stringField(obj: Record<string, unknown>, key: string): string {
  const val = obj[key];
  return typeof val === "string" ? val.trim() : "";
}
