export type PollInput = {
  question: string;
  options: string[];
  maxSelections?: number;
  /**
   * Poll duration in seconds.
   * Channel-specific limits apply in each owning plugin.
   */
  durationSeconds?: number;
  /**
   * Poll duration in hours.
   * Used by channels that model duration in hours.
   */
  durationHours?: number;
};

export type NormalizedPollInput = {
  question: string;
  options: string[];
  maxSelections: number;
  durationSeconds?: number;
  durationHours?: number;
};

type NormalizePollOptions = {
  maxOptions?: number;
};

function normalizePollInteger(value: number | undefined, field: string): number | undefined {
  const normalized =
    typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : undefined;
  if (normalized !== undefined && normalized < 1) {
    throw new Error(`${field} must be at least 1`);
  }
  return normalized;
}

export function resolvePollMaxSelections(
  optionCount: number,
  allowMultiselect: boolean | undefined,
): number {
  return allowMultiselect ? Math.max(2, optionCount) : 1;
}

export function normalizePollInput(
  input: PollInput,
  options: NormalizePollOptions = {},
): NormalizedPollInput {
  const question = input.question.trim();
  if (!question) {
    throw new Error("Poll question is required");
  }
  const pollOptions = (input.options ?? []).map((option) => option.trim());
  const cleaned = pollOptions.filter(Boolean);
  if (cleaned.length < 2) {
    throw new Error("Poll requires at least 2 options");
  }
  if (options.maxOptions !== undefined && cleaned.length > options.maxOptions) {
    throw new Error(`Poll supports at most ${options.maxOptions} options`);
  }
  const maxSelections = normalizePollInteger(input.maxSelections, "maxSelections") ?? 1;
  if (maxSelections > cleaned.length) {
    throw new Error("maxSelections cannot exceed option count");
  }

  const durationSeconds = normalizePollInteger(input.durationSeconds, "durationSeconds");
  const durationHours = normalizePollInteger(input.durationHours, "durationHours");
  if (durationSeconds !== undefined && durationHours !== undefined) {
    throw new Error("durationSeconds and durationHours are mutually exclusive");
  }
  return {
    question,
    options: cleaned,
    maxSelections,
    durationSeconds,
    durationHours,
  };
}

export function normalizePollDurationHours(
  value: number | undefined,
  options: { defaultHours: number; maxHours: number },
): number {
  const base =
    typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : options.defaultHours;
  return Math.min(Math.max(base, 1), options.maxHours);
}
