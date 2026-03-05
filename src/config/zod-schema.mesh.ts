import { z } from "zod";

const MeshStaticPeerSchema = z
  .object({
    url: z.string().min(1),
    deviceId: z.string().min(1),
    tlsFingerprint: z.string().optional(),
  })
  .strict();

export const MeshSchema = z
  .object({
    enabled: z.boolean().optional(),
    scanIntervalMs: z.number().int().min(5000).optional(),
    capabilities: z.array(z.string()).optional(),
    peers: z.array(MeshStaticPeerSchema).optional(),
  })
  .strict()
  .optional();
