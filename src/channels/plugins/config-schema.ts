import { z, type ZodRawShape, type ZodTypeAny } from "zod";
import { ToolPolicySchema } from "../../config/zod-schema.agent-runtime.js";
import {
  DmPolicySchema,
  evaluateDmPolicyAllowFromDependency,
} from "../../config/zod-schema.core.js";
import type { ChannelConfigSchema } from "./types.config.js";

export {
  buildChannelConfigSchema,
  buildJsonChannelConfigSchema,
} from "./config-schema-projection.js";

export const AllowFromListSchema = z.array(z.union([z.string(), z.number()])).optional();

type ChannelDmPolicyFields = {
  dmPolicy?: string;
  allowFrom?: Array<string | number>;
};

/** Validate one policy scope; the channel owns account selection and refinement ordering. */
export function refineChannelDmPolicy(params: {
  channelId: string;
  value: ChannelDmPolicyFields & {
    accounts?: Record<string, ChannelDmPolicyFields | undefined>;
  };
  accountId?: string;
  ctx: z.RefinementCtx;
}): void {
  const { channelId, value, accountId, ctx } = params;
  const account = accountId === undefined ? value : value.accounts?.[accountId];
  if (!account) {
    return;
  }
  const policy = account.dmPolicy ?? value.dmPolicy;
  const violation = evaluateDmPolicyAllowFromDependency({
    policy,
    allowFrom: account.allowFrom ?? value.allowFrom,
  });
  if (!violation) {
    return;
  }
  const root = `channels.${channelId}`;
  const owner = accountId === undefined ? root : `${root}.accounts.*`;
  const inherited = accountId === undefined ? "" : ` (or ${root}.allowFrom)`;
  const requirement =
    violation === "open_requires_wildcard" ? 'include "*"' : "contain at least one sender ID";
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: accountId === undefined ? ["allowFrom"] : ["accounts", accountId, "allowFrom"],
    message: `${owner}.dmPolicy="${policy}" requires ${owner}.allowFrom${inherited} to ${requirement}`,
  });
}

/** Canonical per-group/room channel policy shape. */
export const ChannelGroupEntrySchema = z
  .object({
    requireMention: z.boolean().optional(),
    tools: ToolPolicySchema,
    toolsBySender: z.record(z.string(), ToolPolicySchema).optional(),
    skills: z.array(z.string()).optional(),
    enabled: z.boolean().optional(),
    allowFrom: AllowFromListSchema,
    systemPrompt: z.string().optional(),
  })
  .strict();

type ChannelGroupEntryField = keyof typeof ChannelGroupEntrySchema.shape;

/** Extend the canonical group/room policy shape with channel-owned fields. */
export function buildGroupEntrySchema<
  // oxlint-disable-next-line typescript/no-generated-empty-object-type -- A keyless Zod shape preserves named fields without a string index signature.
  T extends ZodRawShape = Record<never, never>,
  const TOmit extends readonly ChannelGroupEntryField[] = [],
>(extraShape?: T, options?: { omit?: TOmit }) {
  const omitted = new Set<ChannelGroupEntryField>(options?.omit ?? []);
  const baseShape = Object.fromEntries(
    Object.entries(ChannelGroupEntrySchema.shape).filter(
      ([key]) => !omitted.has(key as ChannelGroupEntryField),
    ),
  ) as Omit<typeof ChannelGroupEntrySchema.shape, TOmit[number]>;
  return z.object({ ...baseShape, ...(extraShape ?? ({} as T)) }).strict();
}

/** Build the common nested DM config block used by channel account schemas. */
export function buildNestedDmConfigSchema(extraShape?: ZodRawShape) {
  const baseShape = {
    enabled: z.boolean().optional(),
    policy: DmPolicySchema.optional(),
    allowFrom: AllowFromListSchema,
  };
  return z.object(extraShape ? { ...baseShape, ...extraShape } : baseShape).optional();
}

/** Add `accounts` catchall and `defaultAccount` fields to a channel account schema. */
export function buildCatchallMultiAccountChannelSchema<T extends z.ZodObject>(
  accountSchema: T,
): MultiAccountChannelSchema<T, T, false> {
  return buildMultiAccountChannelSchema(accountSchema, {
    accountsMode: "catchall",
  });
}

type MultiAccountSchemaBaseOptions<TAccount extends ZodTypeAny, TOptional extends boolean> = {
  accountSchema?: TAccount;
  accountsMode?: "record" | "catchall";
  optionalAccount?: TOptional;
};

type MultiAccountRefinement<T extends z.ZodObject> = (
  value: z.output<T>,
  ctx: z.RefinementCtx,
) => void | Promise<void>;

type MultiAccountSchemaOptions<
  T extends z.ZodObject,
  TAccount extends ZodTypeAny,
  TOptional extends boolean,
> =
  | (MultiAccountSchemaBaseOptions<TAccount, TOptional> & { refine?: undefined })
  | (MultiAccountSchemaBaseOptions<T, TOptional> & { refine: MultiAccountRefinement<T> });

type OptionalAccountValue<T, TOptional extends boolean> = TOptional extends true
  ? T | undefined
  : T;

type MultiAccountEnvelopeShape<TAccount extends ZodTypeAny, TOptional extends boolean> = {
  accounts: z.ZodOptional<
    z.ZodType<
      Record<string, OptionalAccountValue<z.output<TAccount>, TOptional>>,
      Record<string, OptionalAccountValue<z.input<TAccount>, TOptional>>
    >
  >;
  defaultAccount: z.ZodOptional<z.ZodString>;
};

type MultiAccountChannelSchema<
  T extends z.ZodObject,
  TAccount extends ZodTypeAny,
  TOptional extends boolean,
> = z.ZodObject<
  z.util.Extend<T["shape"], MultiAccountEnvelopeShape<TAccount, TOptional>>,
  T["_zod"]["config"]
>;

/** Add the standard accounts/defaultAccount envelope and optional shared account/root refinement. */
export function buildMultiAccountChannelSchema<
  T extends z.ZodObject,
  TAccount extends ZodTypeAny = T,
  TOptional extends boolean = false,
>(
  baseSchema: T,
  options: MultiAccountSchemaOptions<T, TAccount, TOptional> = {},
): MultiAccountChannelSchema<T, TAccount, TOptional> {
  const refine = options.refine;
  const rawAccountSchema = options.accountSchema ?? baseSchema;
  const accountSchema = refine
    ? (rawAccountSchema as T).superRefine((value, ctx) => {
        return refine(value, ctx as z.RefinementCtx);
      })
    : rawAccountSchema;
  const accountValueSchema = options.optionalAccount ? accountSchema.optional() : accountSchema;
  const accountsSchema =
    options.accountsMode === "catchall"
      ? z.object({}).catchall(accountValueSchema).optional()
      : z.record(z.string(), accountValueSchema).optional();
  const channelSchema = baseSchema.extend({
    accounts: accountsSchema,
    defaultAccount: z.string().optional(),
  });
  return (refine
    ? channelSchema.superRefine((value, ctx) => {
        // Generic Zod extension widens the callback value; the runtime value and context stay intact.
        return refine(value as z.output<T>, ctx as z.RefinementCtx);
      })
    : channelSchema) as unknown as MultiAccountChannelSchema<T, TAccount, TOptional>;
}

/** Return a channel config schema for channels that intentionally accept no config keys. */
export function emptyChannelConfigSchema(): ChannelConfigSchema {
  return {
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
    runtime: {
      safeParse(value) {
        if (value === undefined) {
          return { success: true, data: undefined };
        }
        const message =
          !value || typeof value !== "object" || Array.isArray(value)
            ? "expected config object"
            : Object.keys(value).length > 0
              ? "config must be empty"
              : undefined;
        return message
          ? { success: false, issues: [{ path: [], message }] }
          : { success: true, data: value };
      },
    },
  };
}
