import { z } from "zod";

export type BridgeContext = {
  /** The channel that initiated the command (e.g., 'telegram', 'cli'). */
  channel: string;
  /** The user ID of the caller (if available). */
  userId?: string;
  /** Whether the user has admin privileges. */
  isAdmin: boolean;
  /** Extra metadata from the channel adapter. */
  metadata?: Record<string, unknown>;
};

export type BridgeResult<T = unknown> = {
  success: boolean;
  data?: T;
  error?: string;
  /** Optional structured view hint for adapters (e.g. 'table', 'list'). */
  view?: "table" | "list" | "text" | "json";
  /** Optional interaction elements (buttons). */
  interaction?: BridgeInteraction;
};

export type BridgeInteraction = {
  /** Text to display above the buttons (optional). */
  text?: string;
  buttons: Array<
    Array<{
      text: string;
      callbackData: string;
      url?: string;
    }>
  >;
};

export type BridgeHandler<TArgs = unknown, TResult = unknown> = (
  args: TArgs,
  context: BridgeContext,
) => Promise<BridgeResult<TResult>>;

export type BridgeCommand<TArgs = unknown> = {
  name: string;
  description: string;
  /** Zod schema for validation. */
  schema?: z.ZodType<TArgs>;
  /** Default arguments if none provided. */
  defaultArgs?: Partial<TArgs>;
  handler: BridgeHandler<TArgs>;
  /** Permissions/Metadata */
  meta?: {
    adminOnly?: boolean;
    hidden?: boolean;
  };
};
