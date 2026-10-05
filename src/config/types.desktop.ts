// Defines local desktop sources from the canonical schema.
import type { z } from "zod";
import type { DesktopConfigSchema } from "./zod-schema.desktop.js";

export type DesktopConfig = NonNullable<z.input<typeof DesktopConfigSchema>>;

export type DesktopHostConfig = NonNullable<DesktopConfig["host"]>;
