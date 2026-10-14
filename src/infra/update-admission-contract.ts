import { z } from "zod";
import { SUPERVISOR_HINT_ENV_VARS } from "./supervisor-markers.js";
import { UPDATE_ADMISSION_PROTOCOL } from "./update-run-schema.js";

const authorityEnvKeys = new Set<string>([
  ...SUPERVISOR_HINT_ENV_VARS,
  "OPENCLAW_CONTROL_PLANE_UPDATE_SENTINEL_META",
  "OPENCLAW_GATEWAY_SERVICE_PID",
  "OPENCLAW_COMPATIBILITY_HOST_VERSION",
]);

/** Admission may observe a live profile, but cannot inherit an update or service continuation. */
export function isUpdateAdmissionAuthorityEnvKey(key: string): boolean {
  const normalized = key.toUpperCase();
  return authorityEnvKeys.has(normalized) || normalized.startsWith("OPENCLAW_UPDATE_");
}

const text = z.string().min(1);
const channel = z.enum(["stable", "extended-stable", "beta", "dev"]);
const contextSchema = z.object({
  protocol: z.literal(UPDATE_ADMISSION_PROTOCOL),
  installation: z.object({
    root: text,
    canonicalRoot: text,
    version: text.nullable(),
    installKind: z.enum(["package", "git", "unknown"]),
    packageManager: z.enum(["npm", "pnpm", "bun"]),
    globalRoot: text.optional(),
  }),
  target: z.object({
    spec: text,
    version: text.nullable(),
    source: z.enum(["registry", "artifact"]),
    channel,
    tag: text.optional(),
  }),
  request: z.object({
    yes: z.boolean(),
    noRestart: z.boolean(),
    acceptCapabilities: z.boolean(),
    json: z.boolean(),
    timeoutMs: z.number().finite().positive().optional(),
    requestedChannel: channel.nullable().optional(),
  }),
  run: z.object({ id: text }),
  supervisor: z.object({ version: text, host: text, pid: z.number().int().positive() }),
});

export type UpdateAdmissionContext = z.infer<typeof contextSchema>;

/** Admission carries observations only, never update execution authority. */
export function parseUpdateAdmissionContext(value: unknown): UpdateAdmissionContext | null {
  const parsed = contextSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
