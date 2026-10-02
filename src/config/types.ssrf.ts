import type { z } from "zod";
import type { SsrFPolicyConfigSchema } from "./zod-schema.core.js";

export type SsrFPolicyConfig = z.input<typeof SsrFPolicyConfigSchema>;
