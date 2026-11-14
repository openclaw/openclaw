import { resolveSandboxConfigForAgent } from "../../agents/sandbox/config.js";
import { DOCKER_SANDBOX_ENGINE, execContainer } from "../../agents/sandbox/container-engine.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

/** Default-engine liveness, not a guarantee that a session's image or overrides will provision. */
export async function readSandboxBackendAvailability(cfg: OpenClawConfig | undefined): Promise<{
  backend: string;
  available: boolean | null;
}> {
  const backend = resolveSandboxConfigForAgent(cfg).backend.toLowerCase();
  if (backend !== "docker" && backend !== "podman") {
    return { backend, available: null };
  }
  try {
    let engine = DOCKER_SANDBOX_ENGINE;
    if (backend === "podman") {
      const { bindPodmanSandboxEngine, resolvePodmanSandboxRuntimeInfo } =
        await import("../../agents/sandbox/podman-runtime.js");
      engine = bindPodmanSandboxEngine((await resolvePodmanSandboxRuntimeInfo()).target);
    }
    // Probe the selected target afresh; an installed client or cached target is not liveness.
    await execContainer(engine, ["info"], { signal: AbortSignal.timeout(30_000) });
    return { backend, available: true };
  } catch {
    return { backend, available: false };
  }
}
