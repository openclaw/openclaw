const CUSTODIAN_QUESTION_MARKER = "openclaw-user-input";

export type CustodianStructuredQuestion = {
  id: string;
  header: string;
  question: string;
  options: Array<{ label: string; description?: string; recommended?: boolean }>;
  isOther: boolean;
};

type ParsedCustodianReply = {
  text: string;
  question: CustodianStructuredQuestion | null;
};

const MARKER_PATTERN = new RegExp(
  `<!--\\s*${CUSTODIAN_QUESTION_MARKER}\\s*([\\s\\S]*?)\\s*-->`,
  "u",
);

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parseQuestion(value: unknown): CustodianStructuredQuestion | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  const id = nonEmptyString(candidate.id);
  const header = nonEmptyString(candidate.header);
  const question = nonEmptyString(candidate.question);
  if (!id || !header || !question || !Array.isArray(candidate.options)) {
    return null;
  }
  if (candidate.options.length < 2 || candidate.options.length > 4) {
    return null;
  }
  const options: CustodianStructuredQuestion["options"] = [];
  for (const optionValue of candidate.options) {
    if (!optionValue || typeof optionValue !== "object" || Array.isArray(optionValue)) {
      return null;
    }
    const option = optionValue as Record<string, unknown>;
    const label = nonEmptyString(option.label);
    if (!label) {
      return null;
    }
    if (option.description !== undefined && typeof option.description !== "string") {
      return null;
    }
    if (option.recommended !== undefined && typeof option.recommended !== "boolean") {
      return null;
    }
    options.push({
      label,
      ...(typeof option.description === "string" && option.description.trim()
        ? { description: option.description.trim() }
        : {}),
      ...(option.recommended === true ? { recommended: true } : {}),
    });
  }
  if (new Set(options.map((option) => option.label.toLocaleLowerCase())).size !== options.length) {
    return null;
  }
  if (options.filter((option) => option.recommended).length > 1) {
    return null;
  }
  return {
    id,
    header,
    question,
    options,
    isOther: candidate.isOther === true,
  };
}

/**
 * `openclaw.chat` currently returns text only. Cards therefore require one
 * explicit hidden JSON marker; ordinary numbered prose must stay ordinary prose.
 */
export function parseCustodianReply(reply: string): ParsedCustodianReply {
  const marker = MARKER_PATTERN.exec(reply);
  if (!marker) {
    return { text: reply, question: null };
  }
  try {
    const question = parseQuestion(JSON.parse(marker[1] ?? ""));
    if (!question) {
      return { text: reply, question: null };
    }
    return {
      text: `${reply.slice(0, marker.index)}${reply.slice(marker.index + marker[0].length)}`.trim(),
      question,
    };
  } catch {
    return { text: reply, question: null };
  }
}
