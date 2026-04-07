export type ArgsRecord = Record<string, unknown>;

export function asRecord(args: unknown): ArgsRecord | undefined {
  return args && typeof args === "object" ? (args as ArgsRecord) : undefined;
}
