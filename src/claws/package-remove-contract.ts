import { Value } from "typebox/value";
import { z } from "zod";
import {
  PluginRuntimeApplicationSchema,
  type PluginRuntimeApplication,
} from "../../packages/gateway-protocol/src/schema/plugins.js";
import { clawMonitorCleanupBindingSchema } from "./monitor-cleanup-contract.js";
import { MAX_CLAW_MANIFEST_BYTES } from "./source-limits.js";

const text = z.string().min(1).max(4096);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);

export const clawPackageRemovalRequestSchema = z
  .object({
    agentId: text,
    operationId: text,
    binding: clawMonitorCleanupBindingSchema,
    expectedInstallDigest: digest,
    expectedPackagePlanDigest: digest,
    cleanup: z
      .object({
        mode: z.enum(["retain", "remove-if-unused", "remove-selected"]),
        selected: z.array(text).optional(),
        allowConflicts: z.boolean().optional(),
      })
      .strict(),
  })
  .strict()
  .refine(
    (request) => Buffer.byteLength(JSON.stringify(request)) <= MAX_CLAW_MANIFEST_BYTES,
    "Package cleanup request exceeds the Claw manifest byte limit.",
  );

export const clawPackageRemovalResultSchema = z
  .object({
    packages: z.array(
      z
        .object({
          kind: z.enum(["plugin", "skill"]),
          ref: text,
          version: text,
          action: z.enum(["uninstalled", "retained", "error"]),
          reason: z.string().optional(),
        })
        .strict(),
    ),
    warnings: z.array(z.string()).optional(),
    application: z
      .custom<PluginRuntimeApplication>((value) =>
        Value.Check(PluginRuntimeApplicationSchema, value),
      )
      .optional(),
  })
  .strict();

export type ClawPackageRemovalPhaseResult = z.infer<typeof clawPackageRemovalResultSchema>;
export type ClawPackageRemovalGateway = (
  request: Omit<z.infer<typeof clawPackageRemovalRequestSchema>, "binding">,
) => Promise<ClawPackageRemovalPhaseResult>;
