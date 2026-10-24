import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SandboxResolvedPath } from "../sandbox/fs-bridge.js";
import type { SandboxContext } from "../sandbox/types.js";
import { createAgentToolsSandboxContext } from "./agent-tools-sandbox-context.js";
import { createSandboxFsBridgeFromResolver } from "./host-sandbox-fs-bridge.js";

export function createUnsafeMountedSandbox(params: {
  sandboxRoot: string;
  agentRoot: string;
  skillsWorkspaceDir?: string;
  workspaceAccess?: "none" | "ro" | "rw";
  workspaceContainerRoot?: string;
}): SandboxContext {
  const root = path.resolve(params.sandboxRoot);
  const agentHostRoot = path.resolve(params.agentRoot);
  const skillsHostRoot = params.skillsWorkspaceDir
    ? path.resolve(params.skillsWorkspaceDir, "skills")
    : undefined;
  const workspaceContainerRoot = params.workspaceContainerRoot ?? "/workspace";
  const skillsRelativeRoot = ".openclaw/sandbox-skills/skills";
  const skillsContainerRoot = path.posix.join(workspaceContainerRoot, skillsRelativeRoot);
  const remap = (input: string, container: string, host: string) =>
    input === container || input.startsWith(`${container}/`)
      ? path.join(host, input.slice(container.length))
      : undefined;

  const resolvePath = (filePath: string, cwd?: string): SandboxResolvedPath => {
    const normalizedRelativePath = path.posix.normalize(filePath.replace(/\\/g, "/"));
    // Intentionally unsafe: simulate a sandbox FS bridge that maps /agent/* into a host path
    // outside the workspace root (e.g. an operator-configured bind mount).
    const hostPath =
      remap(filePath, "/agent", agentHostRoot) ??
      (skillsHostRoot
        ? (remap(filePath, skillsContainerRoot, skillsHostRoot) ??
          remap(normalizedRelativePath, skillsRelativeRoot, skillsHostRoot))
        : undefined) ??
      remap(filePath, workspaceContainerRoot, root) ??
      (path.isAbsolute(filePath) ? filePath : path.resolve(cwd ?? root, filePath));

    const relFromRoot = path.relative(root, hostPath);
    const relativePath =
      relFromRoot && !relFromRoot.startsWith("..") && !path.isAbsolute(relFromRoot)
        ? relFromRoot.split(path.sep).filter(Boolean).join(path.posix.sep)
        : filePath.replace(/\\/g, "/");

    const containerPath = filePath.startsWith("/")
      ? filePath.replace(/\\/g, "/")
      : relativePath
        ? path.posix.join(workspaceContainerRoot, relativePath)
        : workspaceContainerRoot;

    return { hostPath, relativePath, containerPath };
  };

  return createAgentToolsSandboxContext({
    ...params,
    workspaceDir: params.sandboxRoot,
    agentWorkspaceDir: params.agentRoot,
    fsBridge: createSandboxFsBridgeFromResolver(resolvePath, [
      { hostRoot: root, containerRoot: workspaceContainerRoot },
      { hostRoot: agentHostRoot, containerRoot: "/agent" },
      ...(skillsHostRoot ? [{ hostRoot: skillsHostRoot, containerRoot: skillsContainerRoot }] : []),
    ]),
  });
}

export async function withUnsafeMountedSandboxHarness(
  run: (ctx: {
    sandboxRoot: string;
    agentRoot: string;
    skillsWorkspaceDir?: string;
    sandbox: SandboxContext;
  }) => Promise<void>,
  options?: {
    includeSkillsWorkspace?: boolean;
    skillsWorkspaceDir?: string;
    workspaceAccess?: "none" | "ro" | "rw";
  },
) {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sbx-mounts-"));
  const sandboxRoot = path.join(stateDir, "sandbox");
  const agentRoot = path.join(stateDir, "agent");
  const skillsWorkspaceDir =
    options?.skillsWorkspaceDir ??
    (options?.includeSkillsWorkspace ? path.join(stateDir, "skills-state") : undefined);
  await fs.mkdir(sandboxRoot, { recursive: true });
  await fs.mkdir(agentRoot, { recursive: true });
  const context = { sandboxRoot, agentRoot, skillsWorkspaceDir };
  const sandbox = createUnsafeMountedSandbox({
    ...context,
    workspaceAccess: options?.workspaceAccess,
  });
  try {
    await run({ ...context, sandbox });
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}
