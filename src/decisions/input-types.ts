/** Evidence and shared question shapes used by both Decision contracts. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type DecisionEntry =
  | string
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type DecisionQuestion =
  | {
      readonly type: "choice";
      readonly instructions?: DecisionEntry;
      readonly criteria: Readonly<Record<string, DecisionEntry>>;
    }
  | {
      readonly type: "score";
      readonly instructions?: DecisionEntry;
      readonly criteria: readonly DecisionEntry[];
    }
  | {
      readonly type: "boolean";
      readonly instructions?: DecisionEntry;
      readonly criteria?: {
        readonly true?: DecisionEntry;
        readonly false?: DecisionEntry;
      } | null;
    };

/** Provider-declared execution mode; omission leaves the provider default unchanged. */
export type DecisionReasoning = "auto" | "off" | "on";
