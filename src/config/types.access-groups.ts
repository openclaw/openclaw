import type { z } from "zod";
import type { AccessGroupsSchema } from "./zod-schema.root-support.js";

export type AccessGroupsConfig = NonNullable<z.input<typeof AccessGroupsSchema>>;
export type AccessGroupConfig = AccessGroupsConfig[string];
