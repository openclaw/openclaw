import type { SandboxContext, SandboxToolPolicy, SandboxWorkspaceAccess } from "../sandbox.js";
import type { SandboxFsBridge } from "../sandbox/fs-bridge.js";

type PiToolsSandboxContextParams = {
  workspaceDir: string;
  agentWorkspaceDir?: string;
  workspaceAccess?: SandboxWorkspaceAccess;
  fsBridge?: SandboxFsBridge;
  tools?: SandboxToolPolicy;
  browserAllowHostControl?: boolean;
  sessionKey?: string;
  containerName?: string;
  containerWorkdir?: string;
  dockerOverrides?: Partial<SandboxContext["docker"]>;
};

export function createPiToolsSandboxContext(params: PiToolsSandboxContextParams): SandboxContext {
  const workspaceDir = params.workspaceDir;
  return {
    enabled: true,
    sessionKey: params.sessionKey ?? "sandbox:test",
    workspaceDir,
    agentWorkspaceDir: params.agentWorkspaceDir ?? workspaceDir,
    workspaceAccess: params.workspaceAccess ?? "rw",
    containerName: params.containerName ?? "openclaw-sbx-test",
    containerWorkdir: params.containerWorkdir ?? "/workspace",
    fsBridge: params.fsBridge,
    docker: {
      image: "openclaw-sandbox:bookworm-slim",
      containerPrefix: "openclaw-sbx-",
      workdir: "/workspace",
      readOnlyRoot: true,
      tmpfs: [],
      network: "none",
      user: "1000:1000",
      capDrop: ["ALL"],
      env: { LANG: "C.UTF-8" },
      ...params.dockerOverrides,
    },
    tools: params.tools ?? { allow: [], deny: [] },
    browserAllowHostControl: params.browserAllowHostControl ?? false,
  };
}
