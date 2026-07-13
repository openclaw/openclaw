import { z } from "zod";

type GatewayAccess = {
  methods: ReadonlySet<string>;
  scopes: ReadonlySet<string>;
};

export type SessionToolsGateway = {
  request: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  access: () => GatewayAccess;
  ready?: () => Promise<void>;
};

export type SessionCapabilities = {
  list: boolean;
  read: boolean;
  create: boolean;
  send: boolean;
  abort: boolean;
  update: boolean;
};

export type SessionStatus = "idle" | "working" | "waiting" | "error";

export type SessionItem = {
  id: string;
  agentId: string;
  title: string;
  preview?: string;
  updatedAt?: string;
  status: SessionStatus;
  unread: boolean;
  pinned: boolean;
  archived: boolean;
  icons?: Array<{ src: string }>;
  toolArguments: {
    session_id: string;
    chrome: "detail";
  };
};

export type SessionAgent = {
  id: string;
  title: string;
  icon?: { src: string; fallback: string };
};

export type StoredSession = {
  key: string;
  agentId: string;
  item: SessionItem;
};

export type AgentSummary = {
  id: string;
  name?: string;
  identity?: {
    name?: string;
    emoji?: string;
    avatarUrl?: string;
  };
};

export type SessionToolErrorCode =
  | "gateway_unavailable"
  | "invalid_response"
  | "rejected"
  | "refresh_required"
  | "unsupported";

export const READ_SCOPE = "operator.read";
export const WRITE_SCOPE = "operator.write";
export const ADMIN_SCOPE = "operator.admin";
export const DEFAULT_LIST_LIMIT = 50;
export const DEFAULT_HISTORY_LIMIT = 50;
export const MAX_HISTORY_CHARS = 200_000;
export const MAX_TITLE_CHARS = 160;
export const MAX_PREVIEW_CHARS = 500;
export const MAX_AGENT_EMOJI_CHARS = 16;
export const MAX_SESSION_MAPPINGS = 1_000;
export const MAX_DATE_MS = 8_640_000_000_000_000;
export const MAX_DATA_ICON_CHARS = 256 * 1024;
export const MAX_LIST_ICON_CHARS = 4 * 1024 * 1024;
export const SAFE_RASTER_DATA_ICON_PATTERN = /^data:image\/(?:avif|gif|jpe?g|png|webp);base64,/i;

const MAX_LIST_LIMIT = 100;
const MAX_HISTORY_LIMIT = 200;
export const MAX_MESSAGE_CHARS = 20_000;
const OPAQUE_SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const opaqueSessionIdSchema = z.string().regex(OPAQUE_SESSION_ID_PATTERN);
const operationIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);

export const sessionRowSchema = z.object({
  key: z.string().min(1),
  label: z.string().optional(),
  displayName: z.string().optional(),
  derivedTitle: z.string().optional(),
  lastMessagePreview: z.string().optional(),
  updatedAt: z.number().nullable().optional(),
  status: z.enum(["running", "done", "failed", "killed", "timeout"]).optional(),
  hasActiveRun: z.boolean().optional(),
  unread: z.boolean().optional(),
  pinned: z.boolean().optional(),
  archived: z.boolean().optional(),
});

export const sessionsListResultSchema = z.object({
  sessions: z.array(sessionRowSchema),
});

export const agentsListResultSchema = z.object({
  defaultId: z.string().min(1).optional(),
  agents: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string().optional(),
      identity: z
        .object({
          name: z.string().optional(),
          emoji: z.string().optional(),
          avatarUrl: z.string().optional(),
        })
        .optional(),
    }),
  ),
});

export const historyResultSchema = z.object({
  messages: z.array(z.unknown()),
});

export const createResultSchema = z.object({
  key: z.string().min(1),
  runStarted: z.boolean().optional(),
  runId: z.string().optional(),
  entry: z.record(z.string(), z.unknown()).optional(),
});

export const sendResultSchema = z.object({
  runId: z.string().optional(),
});

export const abortResultSchema = z.object({
  abortedRunId: z.string().nullable().optional(),
  aborted: z.boolean().optional(),
  status: z.string().optional(),
});

export const patchResultSchema = z.object({
  entry: z.record(z.string(), z.unknown()),
});

export const listInputSchema = z
  .object({
    limit: z.number().int().min(1).max(MAX_LIST_LIMIT).optional(),
    search: z.string().trim().max(200).optional(),
    archived: z.boolean().optional(),
  })
  .strict();

export const detailInputSchema = z
  .object({
    session_id: opaqueSessionIdSchema.optional(),
    mode: z.literal("new").optional(),
    limit: z.number().int().min(1).max(MAX_HISTORY_LIMIT).optional(),
    chrome: z.literal("detail").optional(),
  })
  .strict()
  .refine(
    ({ session_id, mode }) => (session_id !== undefined) !== (mode !== undefined),
    { message: "exactly one of session_id or mode is required" },
  )
  .refine(({ mode, limit }) => mode !== "new" || limit === undefined, {
    message: "limit is only valid when reading a session",
    path: ["limit"],
  });

export const createInputSchema = z
  .object({
    agent_id: z.string().trim().min(1).max(100).optional(),
    label: z.string().trim().min(1).max(MAX_TITLE_CHARS).optional(),
    message: z.string().trim().min(1).max(MAX_MESSAGE_CHARS).optional(),
    operation_id: operationIdSchema.optional(),
  })
  .strict();

export const sendInputSchema = z
  .object({
    session_id: opaqueSessionIdSchema,
    text: z.string().trim().min(1).max(MAX_MESSAGE_CHARS),
    operation_id: operationIdSchema.optional(),
  })
  .strict();

export const abortInputSchema = z
  .object({
    session_id: opaqueSessionIdSchema,
    run_id: z.string().min(1).max(200).optional(),
  })
  .strict();

export const updateInputSchema = z
  .object({
    session_id: opaqueSessionIdSchema,
    label: z.string().trim().min(1).max(MAX_TITLE_CHARS).optional(),
    archived: z.boolean().optional(),
    pinned: z.boolean().optional(),
    unread: z.boolean().optional(),
  })
  .strict()
  .refine(
    ({ label, archived, pinned, unread }) =>
      label !== undefined || archived !== undefined || pinned !== undefined || unread !== undefined,
    { message: "one update field is required" },
  );

export type SessionRow = z.output<typeof sessionRowSchema>;
export type AgentsListResult = z.output<typeof agentsListResultSchema>;
export type SessionListInput = z.output<typeof listInputSchema>;
export type SessionDetailInput = z.output<typeof detailInputSchema>;
export type SessionCreateInput = z.output<typeof createInputSchema>;
export type SessionSendInput = z.output<typeof sendInputSchema>;
export type SessionAbortInput = z.output<typeof abortInputSchema>;
export type SessionUpdateInput = z.output<typeof updateInputSchema>;

export class SessionToolError extends Error {
  constructor(readonly code: SessionToolErrorCode) {
    super(code);
    this.name = "SessionToolError";
  }
}

export function parseGatewayResult<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new SessionToolError("invalid_response");
  }
  return parsed.data;
}
