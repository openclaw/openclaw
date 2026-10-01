import type { z } from "zod";
import type { AgentSandboxSchema } from "./zod-schema.agent-runtime.js";
import type { SandboxDockerSchema } from "./zod-schema.sandbox.js";

export type SandboxDockerSettings = NonNullable<z.output<typeof SandboxDockerSchema>>;

type AgentSandboxConfig = NonNullable<z.input<typeof AgentSandboxSchema>>;

export type SandboxSshSettings = NonNullable<AgentSandboxConfig["ssh"]>;
