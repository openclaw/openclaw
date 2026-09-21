// Defines the canonical operator-configurable SSRF policy from its schema.
import type { z } from "zod";
import type { SsrFPolicyConfigSchema } from "./zod-schema.core.js";

export type SsrFPolicyConfig = z.input<typeof SsrFPolicyConfigSchema>;
