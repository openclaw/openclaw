import type { OpenClawConfig } from "../../config/config.js";
import type { AgentSandboxConfig } from "../../config/types.agents-shared.js";
import type { SandboxBackendHandle } from "../sandbox/backend.js";

export function createBackend(
  params: Pick<SandboxBackendHandle, "id" | "runtimeId" | "runtimeLabel"> &
    Partial<SandboxBackendHandle>,
): SandboxBackendHandle {
  return {
    workdir: "/workspace",
    buildExecSpec: async () => ({
      argv: [params.id, "exec"],
      env: process.env,
      stdinMode: "pipe-closed",
    }),
    runShellCommand: async () => ({ stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), code: 0 }),
    ...params,
  };
}

export function sandboxConfig(backend: string, overrides: AgentSandboxConfig = {}): OpenClawConfig {
  return {
    agents: {
      defaults: {
        sandbox: {
          mode: "all",
          backend,
          scope: "session",
          workspaceAccess: "rw",
          prune: { idleHours: 0, maxAgeDays: 0 },
          ...overrides,
        },
      },
    },
  };
}
