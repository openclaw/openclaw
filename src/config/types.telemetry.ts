import type { z } from "zod";
import type { TelemetryConfigSchema } from "./zod-schema.telemetry.js";

export type TelemetryConfig = NonNullable<z.input<typeof TelemetryConfigSchema>>;
