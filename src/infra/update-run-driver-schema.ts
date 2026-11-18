import { z } from "zod";

export const UpdateRunDriverSchema = z.object({
  host: z.string().min(1).max(255),
  pid: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  startIdentity: z.string().max(128).regex(/^\d+$/),
});

/**
 * A run's own driver identities also keep the kernel boot and PID namespace the
 * driver ran in, as `captureNamespacedStateLeaseProcessOwner` encodes them. Older
 * readers drop the optional key; lease payloads and the public run never carry it.
 */
export const RecordedUpdateRunDriverSchema = UpdateRunDriverSchema.extend({
  // [platform, boot, Linux PID namespace, machine digest]; the shape bounds its encoded bytes.
  namespace: z
    .string()
    .regex(
      /^\["(?:linux|darwin|win32|freebsd)","[\w:.-]{1,40}",(?:null|"pid:\[\d{1,20}\]"),(?:null|"[a-f0-9]{64}")\]$/u,
    )
    .nullable()
    .optional(),
});

export type RecordedUpdateRunDriver = z.infer<typeof RecordedUpdateRunDriverSchema>;
