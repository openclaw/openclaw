import type { ZodType } from "zod";
import { z } from "./zod-compat.js";

// Everything registered here will be redacted when the config is exposed,
// e.g. sent to the dashboard
export const sensitive = z.registry<undefined, ZodType>();
