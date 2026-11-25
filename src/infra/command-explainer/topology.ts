import type { CommandContext, CommandOperator, CommandOperatorKind, CommandStep } from "./types.js";

export type RecordedCommandStep = CommandStep & { id: string };

export type CommandOperatorSource = {
  context: CommandContext;
  parentCommandId?: string;
  source: string;
};

type CommandTopologyBucket = [RecordedCommandStep, ...RecordedCommandStep[]];

function commandTopologyBuckets(commands: RecordedCommandStep[]): CommandTopologyBucket[] {
  const buckets = new Map<string, CommandTopologyBucket>();
  for (const command of commands) {
    const key = `${command.context}\0${command.parentCommandId ?? ""}`;
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.push(command);
    } else {
      buckets.set(key, [command]);
    }
  }

  for (const bucket of buckets.values()) {
    bucket.sort((left, right) => left.span.startIndex - right.span.startIndex);
  }
  return Array.from(buckets.values());
}

type CommandSourceRange = {
  startIndex: number;
  endIndex: number;
};

function commandSourceRanges(
  source: string,
  commands: readonly RecordedCommandStep[],
): Map<string, CommandSourceRange> | null {
  const ranges = new Map<string, CommandSourceRange>();
  let cursor = 0;
  for (const command of commands) {
    const startIndex = source.indexOf(command.text, cursor);
    if (startIndex < 0) {
      return null;
    }
    const endIndex = startIndex + command.text.length;
    ranges.set(command.id, { startIndex, endIndex });
    cursor = endIndex;
  }
  return ranges;
}

function topologyOperatorFromSeparator(separator: string): CommandOperatorKind | null {
  const candidates: Array<{ kind: CommandOperatorKind; text: string }> = [
    { kind: "and", text: "&&" },
    { kind: "or", text: "||" },
    { kind: "stderr-pipe", text: "|&" },
    { kind: "pipe", text: "|" },
    { kind: "sequence", text: ";" },
    { kind: "background", text: "&" },
    { kind: "newline-sequence", text: "\r\n" },
    { kind: "newline-sequence", text: "\n" },
    { kind: "newline-sequence", text: "\r" },
  ];
  let best: { kind: CommandOperatorKind; offset: number } | null = null;
  for (const candidate of candidates) {
    const offset = separator.indexOf(candidate.text);
    if (offset < 0) {
      continue;
    }
    if (!best || offset < best.offset) {
      best = { kind: candidate.kind, offset };
    }
  }
  return best?.kind ?? null;
}

export function resolveCommandOperators(
  source: string,
  commands: RecordedCommandStep[],
  operatorSources: readonly CommandOperatorSource[],
): CommandOperator[] {
  const operators: CommandOperator[] = [];

  for (const bucket of commandTopologyBuckets(commands)) {
    const context = bucket[0].context;
    const parentCommandId = bucket[0].parentCommandId || undefined;
    const bucketCommandOperatorSource = operatorSources.find(
      (entry) => entry.context === context && entry.parentCommandId === parentCommandId,
    );
    const bucketRanges = bucketCommandOperatorSource
      ? commandSourceRanges(bucketCommandOperatorSource.source, bucket)
      : null;
    for (const [index, fromCommand] of bucket.entries()) {
      const toCommand = bucket[index + 1];
      if (!toCommand) {
        break;
      }
      let separatorSource = source;
      let separatorStart = fromCommand.span.endIndex;
      let separatorEnd = toCommand.span.startIndex;
      const fromRange = bucketRanges?.get(fromCommand.id);
      const toRange = bucketRanges?.get(toCommand.id);
      if (bucketCommandOperatorSource && fromRange && toRange) {
        separatorSource = bucketCommandOperatorSource.source;
        separatorStart = fromRange.endIndex;
        separatorEnd = toRange.startIndex;
      }
      if (separatorEnd < separatorStart) {
        continue;
      }
      const separator = separatorSource.slice(separatorStart, separatorEnd);
      const operator = topologyOperatorFromSeparator(separator);
      if (!operator) {
        continue;
      }
      const topologyOperator: CommandOperator = {
        kind: operator,
        fromCommandId: fromCommand.id,
      };
      if (parentCommandId) {
        topologyOperator.parentCommandId = parentCommandId;
      }
      operators.push(topologyOperator);
    }
  }

  return operators;
}
