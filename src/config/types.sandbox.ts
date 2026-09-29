// Defines sandbox execution configuration types.
import type { z } from "zod";
import type { AgentSandboxSchema } from "./zod-schema.agent-runtime.js";
import type {
  SandboxBrowserSchema,
  SandboxDockerSchema,
  SandboxPruneSchema,
} from "./zod-schema.sandbox.js";

export type SandboxDockerSettings = NonNullable<z.output<typeof SandboxDockerSchema>>;

export type SandboxBrowserSettings = NonNullable<z.input<typeof SandboxBrowserSchema>> & {
  /** @deprecated Doctor-only legacy input. */
  enableNoVnc?: boolean;
};

export type SandboxPruneSettings = NonNullable<z.input<typeof SandboxPruneSchema>>;

type AgentSandboxConfig = NonNullable<z.input<typeof AgentSandboxSchema>>;

export type SandboxSshSettings = NonNullable<AgentSandboxConfig["ssh"]>;
