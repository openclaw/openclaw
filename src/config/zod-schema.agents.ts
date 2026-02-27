import { z } from "zod";
import { AgentDefaultsSchema } from "./zod-schema.agent-defaults.js";
import { AgentEntrySchema } from "./zod-schema.agent-runtime.js";
import { TranscribeAudioSchema } from "./zod-schema.core.js";

export const AgentsSchema = z
  .object({
    defaults: z.lazy(() => AgentDefaultsSchema).optional(),
    list: z.array(AgentEntrySchema).optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    const defaultsBackend = data.defaults?.sandbox?.backend;
    const defaultsProfile = data.defaults?.sandbox?.seatbelt?.profile?.trim();

    if (defaultsBackend === "seatbelt" && !defaultsProfile) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["defaults", "sandbox", "seatbelt", "profile"],
        message:
          'Seatbelt sandbox requires sandbox.seatbelt.profile when backend="seatbelt". ' +
          "Set agents.defaults.sandbox.seatbelt.profile or provide an agent-specific override. " +
          "Run `openclaw doctor` to validate and repair config issues.",
      });
    }

    for (const [index, entry] of (data.list ?? []).entries()) {
      const backend = entry.sandbox?.backend ?? defaultsBackend;
      if (backend !== "seatbelt") {
        continue;
      }
      const effectiveProfile = entry.sandbox?.seatbelt?.profile?.trim() ?? defaultsProfile;
      if (effectiveProfile) {
        continue;
      }
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["list", index, "sandbox", "seatbelt", "profile"],
        message:
          `Seatbelt sandbox requires a resolved profile for agent "${entry.id}". ` +
          "Set agents.defaults.sandbox.seatbelt.profile or this agent's sandbox.seatbelt.profile. " +
          "Run `openclaw doctor` to validate and repair config issues.",
      });
    }
  })
  .optional();

export const BindingsSchema = z
  .array(
    z
      .object({
        agentId: z.string(),
        comment: z.string().optional(),
        match: z
          .object({
            channel: z.string(),
            accountId: z.string().optional(),
            peer: z
              .object({
                kind: z.union([
                  z.literal("direct"),
                  z.literal("group"),
                  z.literal("channel"),
                  /** @deprecated Use `direct` instead. Kept for backward compatibility. */
                  z.literal("dm"),
                ]),
                id: z.string(),
              })
              .strict()
              .optional(),
            guildId: z.string().optional(),
            teamId: z.string().optional(),
            roles: z.array(z.string()).optional(),
          })
          .strict(),
      })
      .strict(),
  )
  .optional();

export const BroadcastStrategySchema = z.enum(["parallel", "sequential"]);

export const BroadcastSchema = z
  .object({
    strategy: BroadcastStrategySchema.optional(),
  })
  .catchall(z.array(z.string()))
  .optional();

export const AudioSchema = z
  .object({
    transcription: TranscribeAudioSchema,
  })
  .strict()
  .optional();
