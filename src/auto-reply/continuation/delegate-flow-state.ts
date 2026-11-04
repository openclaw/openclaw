import { z } from "zod";
import { validateSubagentAttachments } from "../../agents/subagents/spawn/subagent-attachments.js";
import { getRuntimeConfig } from "../../config/config.js";
import { ContinuationRecipientAuthorityBindingSchema } from "../../config/sessions/session-recipient-authority-types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  DIAGNOSTIC_TRACEPARENT_PATTERN,
  normalizeDiagnosticTraceparent,
} from "../../infra/diagnostic-trace-context.js";
import {
  DEFAULT_INLINE_ATTACHMENT_SNAPSHOT_LIMITS,
  normalizeInlineAttachmentBase64,
  parseInlineAttachmentMountPath,
  validateInlineAttachmentSnapshots,
  type InlineAttachment,
} from "../../shared/inline-attachments.js";
import {
  CONTINUATION_DELEGATE_FANOUT_MODES,
  normalizeContinuationTargetKey,
  normalizeContinuationTargetKeys,
} from "./targeting.js";
import type { PendingContinuationDelegate } from "./types.js";

const TraceparentStateSchema = z
  .preprocess(
    (value) => (value === null ? undefined : value),
    z
      .string()
      .regex(new RegExp(DIAGNOSTIC_TRACEPARENT_PATTERN))
      .refine((value) => normalizeDiagnosticTraceparent(value) !== undefined, {
        message: "invalid W3C traceparent",
      })
      .transform((value) => normalizeDiagnosticTraceparent(value)!)
      .optional(),
  )
  .optional();

const InlineAttachmentStateSchema = z
  .object({
    name: z.string(),
    content: z.string(),
    encoding: z.enum(["utf8", "base64"]).optional(),
    mimeType: z.string().optional(),
  })
  .strict();

function parseDelegateAttachmentMountPath(
  value: unknown,
  options: { requireCanonicalInput?: boolean } = {},
) {
  const parsed = parseInlineAttachmentMountPath(value);
  if (parsed.status !== "valid") {
    if (
      parsed.status === "absent" &&
      options.requireCanonicalInput === true &&
      value !== undefined &&
      value !== null
    ) {
      return { status: "invalid" } as const;
    }
    return parsed;
  }
  if (
    (options.requireCanonicalInput === true && value !== parsed.mountPath) ||
    parsed.mountPath.startsWith("/") ||
    parsed.mountPath.endsWith("/") ||
    parsed.mountPath.includes("//") ||
    !/^[A-Za-z0-9._\-/]+$/.test(parsed.mountPath) ||
    parsed.mountPath.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    return { status: "invalid" } as const;
  }
  return parsed;
}

const InlineAttachmentMountStateSchema = z
  .object({
    mountPath: z.string().optional(),
  })
  .strict()
  .transform((mount, ctx) => {
    const parsed = parseDelegateAttachmentMountPath(mount.mountPath, {
      requireCanonicalInput: true,
    });
    if (parsed.status === "invalid") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "attachAs.mountPath is unsafe or noncanonical",
      });
      return z.NEVER;
    }
    return parsed.status === "valid" ? { mountPath: parsed.mountPath } : undefined;
  });

const PendingDelegateStateSchema = z
  .object({
    kind: z.literal("continuation_delegate"),
    task: z.string().min(1),
    delayMs: z.number().int().nonnegative().optional(),
    silent: z.boolean().optional(),
    silentWake: z.boolean().optional(),
    postCompaction: z.boolean().optional(),
    firstArmedAt: z.number().int().nonnegative().optional(),
    attachments: z
      .array(InlineAttachmentStateSchema)
      .max(50)
      .transform((attachments) => (attachments.length > 0 ? attachments : undefined))
      .optional(),
    attachmentCount: z.number().int().positive().max(50).optional(),
    attachmentId: z.uuid().optional(),
    attachAs: InlineAttachmentMountStateSchema.optional(),
    targetSessionKey: z.string().min(1).optional(),
    targetSessionKeys: z.array(z.string().min(1)).optional(),
    fanoutMode: z.enum(CONTINUATION_DELEGATE_FANOUT_MODES).optional(),
    recipientAuthorityBinding: ContinuationRecipientAuthorityBindingSchema.optional(),
    traceparent: TraceparentStateSchema,
    traceparentProvenance: z.literal("internal").optional(),
    model: z.string().min(1).optional(),
    releasedAt: z.number().int().nonnegative().optional(),
    childSessionKey: z.string().min(1).optional(),
    chainTokensFold: z.number().int().nonnegative().optional(),
    persistedChainState: z
      .object({
        currentChainCount: z.number().int().nonnegative(),
        chainStartedAt: z.number().int().nonnegative(),
        accumulatedChainTokens: z.number().int().nonnegative(),
        chainId: z.string().min(1).optional(),
      })
      .optional(),
    persistedChainStateKind: z.enum(["advanced", "terminal"]).optional(),
    inheritedSilent: z.boolean().optional(),
    inheritedWake: z.boolean().optional(),
    originRunId: z.string().min(1).optional(),
    dispatchGrant: z
      .strictObject({
        source: z.unknown(),
        ownerSessionKey: z.string().min(1),
        expiresAt: z.number().int().nonnegative(),
      })
      .optional(),
    // Pre-cure rows may contain these overrides. Decode accepts but never projects
    // them, so restart rebinds the spawn to the authoritative custody owner.
    spawnRequesterSessionKey: z.string().min(1).optional(),
    spawnRequesterChannel: z.string().min(1).optional(),
    spawnRequesterAccountId: z.string().min(1).optional(),
    spawnRequesterTo: z.string().min(1).optional(),
    spawnRequesterThreadId: z.union([z.string().min(1), z.number()]).optional(),
    awaitingNextCompaction: z.boolean().optional(),
  })
  .strict()
  .superRefine((state, ctx) => {
    if (state.fanoutMode && (state.targetSessionKey || state.targetSessionKeys?.length)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "continuation delegate payload cannot combine explicit targets with fanoutMode",
      });
      return;
    }
    if (validateInlineAttachmentSnapshots({ attachments: state.attachments })) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["attachments"],
        message: "invalid inline attachment snapshot",
      });
      return;
    }
    if (state.attachmentId && (state.attachments || state.attachAs)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "continuation delegate payload cannot combine inline and referenced attachments",
      });
      return;
    }
    if (state.attachmentId && state.attachmentCount === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "continuation delegate attachment reference requires an attachment count",
      });
      return;
    }
    const modes = [state.silent, state.silentWake, state.postCompaction].filter(Boolean).length;
    if (modes <= 1 || (state.silent && state.silentWake && !state.postCompaction)) {
      return;
    }
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "continuation delegate payload has incompatible mode flags",
    });
  });

export type PendingDelegateState = z.infer<typeof PendingDelegateStateSchema>;

function canonicalizeDelegateAttachments(
  config: OpenClawConfig,
  attachments: InlineAttachment[] | undefined,
): InlineAttachment[] | undefined {
  if (!attachments?.length) {
    return undefined;
  }
  // The snapshot stores base64 without whitespace; its codec rejects whitespace.
  const canonical = normalizeInlineAttachmentBase64(
    attachments.map((attachment) => ({
      name: attachment.name.trim(),
      content: attachment.content,
      ...(attachment.encoding ? { encoding: attachment.encoding } : {}),
      ...(attachment.mimeType !== undefined ? { mimeType: attachment.mimeType.trim() } : {}),
    })),
    DEFAULT_INLINE_ATTACHMENT_SNAPSHOT_LIMITS.maxFileBytes,
  );
  const error = validateSubagentAttachments({
    config,
    attachments: canonical,
    continuationDelegateSnapshot: true,
  });
  if (error) {
    throw new Error(error);
  }
  return canonical;
}

export function encodeDelegateState(
  delegate: PendingContinuationDelegate,
  attachmentConfig: OpenClawConfig = getRuntimeConfig(),
): PendingDelegateState {
  const attachments = canonicalizeDelegateAttachments(attachmentConfig, delegate.attachments);
  const targetSessionKey = normalizeContinuationTargetKey(delegate.targetSessionKey);
  const targetSessionKeys = normalizeContinuationTargetKeys(delegate.targetSessionKeys);
  const traceparent = normalizeDiagnosticTraceparent(delegate.traceparent);
  const rawAttachAs = delegate.attachAs;
  if (
    rawAttachAs !== undefined &&
    (!rawAttachAs || typeof rawAttachAs !== "object" || Array.isArray(rawAttachAs))
  ) {
    throw new Error("invalid continuation delegate attachment mount path");
  }
  const parsedMountPath = parseDelegateAttachmentMountPath(rawAttachAs?.mountPath);
  if (parsedMountPath.status === "invalid") {
    throw new Error("invalid continuation delegate attachment mount path");
  }
  const attachAs =
    attachments?.length && parsedMountPath.status === "valid"
      ? { mountPath: parsedMountPath.mountPath }
      : undefined;
  return {
    kind: "continuation_delegate",
    task: delegate.task,
    ...(delegate.delayMs !== undefined ? { delayMs: delegate.delayMs } : {}),
    ...(delegate.mode === "silent" ? { silent: true } : {}),
    ...(delegate.mode === "silent-wake" ? { silentWake: true } : {}),
    ...(delegate.mode === "post-compaction" ? { postCompaction: true } : {}),
    ...(delegate.firstArmedAt !== undefined || delegate.delayMs !== undefined
      ? { firstArmedAt: delegate.firstArmedAt ?? Date.now() }
      : {}),
    ...(attachments ? { attachments, attachmentCount: attachments.length } : {}),
    ...(attachAs ? { attachAs } : {}),
    ...(targetSessionKey ? { targetSessionKey } : {}),
    ...(targetSessionKeys.length > 0 ? { targetSessionKeys } : {}),
    ...(delegate.fanoutMode ? { fanoutMode: delegate.fanoutMode } : {}),
    ...(delegate.recipientAuthorityBinding
      ? { recipientAuthorityBinding: delegate.recipientAuthorityBinding }
      : {}),
    ...(traceparent ? { traceparent, traceparentProvenance: "internal" as const } : {}),
    ...(delegate.model ? { model: delegate.model } : {}),
    ...(delegate.chainTokensFold !== undefined
      ? { chainTokensFold: delegate.chainTokensFold }
      : {}),
    ...(delegate.persistedChainState ? { persistedChainState: delegate.persistedChainState } : {}),
    ...(delegate.persistedChainStateKind
      ? { persistedChainStateKind: delegate.persistedChainStateKind }
      : {}),
    ...(delegate.inheritedSilent ? { inheritedSilent: true } : {}),
    ...(delegate.inheritedWake ? { inheritedWake: true } : {}),
    ...(delegate.originRunId ? { originRunId: delegate.originRunId } : {}),
    ...(delegate.dispatchGrant ? { dispatchGrant: delegate.dispatchGrant } : {}),
  };
}

export function decodeDelegateStateJson(value: unknown): PendingDelegateState | undefined {
  const parsed = PendingDelegateStateSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
