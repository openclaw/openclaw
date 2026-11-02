import type { z } from "zod";
import type { StorageConfigSchema } from "./zod-schema.storage.js";

export type StorageConfig = NonNullable<z.input<typeof StorageConfigSchema>>;
export type StorageLocationConfig = NonNullable<StorageConfig["locations"]>[string];
