// Defines sandbox execution configuration types.
import type { z } from "zod";
import type { SecretInput } from "./types.secrets.js";
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

export type SandboxSshSettings = {
  target?: string;
  command?: string;
  workspaceRoot?: string;
  strictHostKeyChecking?: boolean;
  updateHostKeys?: boolean;
  identityFile?: string;
  certificateFile?: string;
  knownHostsFile?: string;
  identityData?: SecretInput;
  certificateData?: SecretInput;
  knownHostsData?: SecretInput;
};
