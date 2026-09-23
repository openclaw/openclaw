// Defines cloud-worker provider profile configuration types from the canonical schema.
import type { z } from "zod";
import type { CloudWorkersConfigSchema } from "./zod-schema.cloud-workers.js";

export type CloudWorkersConfig = NonNullable<z.input<typeof CloudWorkersConfigSchema>>;

export type CloudWorkerProfileConfig = NonNullable<
  NonNullable<CloudWorkersConfig["profiles"]>[string]
>;
