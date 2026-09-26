// Defines auth profile configuration types.
import type { z } from "zod";
import type { OpenClawSchemaShape } from "./zod-schema.root-shape.js";

export type AuthConfig = NonNullable<z.input<typeof OpenClawSchemaShape.auth>>;
export type AuthProfileConfig = NonNullable<AuthConfig["profiles"]>[string];
