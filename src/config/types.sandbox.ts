import type { z } from "zod";
import type { AgentSandboxConfig } from "./types.agents-shared.js";
import type { SandboxDockerSchema } from "./zod-schema.sandbox.js";

export type SandboxDockerSettings = NonNullable<z.output<typeof SandboxDockerSchema>>;

export type SandboxSshSettings = NonNullable<AgentSandboxConfig["ssh"]>;
