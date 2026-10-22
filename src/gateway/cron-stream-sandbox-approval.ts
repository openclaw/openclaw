import { execContainer } from "../agents/sandbox/container-engine.js";
import {
  assertDockerPersistentTargetCurrent,
  readDockerPersistentContainer,
} from "../agents/sandbox/docker-persistent-target.js";
import { getSandboxPersistentExecCapability } from "../agents/sandbox/persistent-exec.types.js";
import { readStreamSandboxContext } from "../agents/sandbox/stream-context.js";
import type { SandboxContext } from "../agents/sandbox/types.js";
import { CronStreamPolicyDeniedError } from "../cron/stream-exec-authority.js";
import type { CronStreamSandboxTarget } from "../cron/stream-sandbox-target.js";

/** Recheck the configured image and sandbox generation across the human approval wait. */
export async function prepareCronStreamSandboxApproval(params: {
  sandbox: SandboxContext;
  target: CronStreamSandboxTarget;
}): Promise<{ assertCurrent: () => void; revalidate: () => Promise<void> }> {
  const { sandbox, target } = params;
  const backend = sandbox.backend;
  const capability = backend && getSandboxPersistentExecCapability(backend);
  if (!backend || !capability) {
    throw new CronStreamPolicyDeniedError(
      "Sandbox stream approval is unavailable for this backend.",
    );
  }
  const assertCurrent = () => {
    const context = readStreamSandboxContext(sandbox);
    if (
      context.configLabel !== target.configLabel ||
      context.scopeKey !== target.scopeKey ||
      sandbox.sessionKey !== target.sessionKey ||
      context.agentId !== target.agentId ||
      getSandboxPersistentExecCapability(backend) !== capability
    ) {
      throw new CronStreamPolicyDeniedError(
        "The sandbox stream target changed while awaiting approval.",
      );
    }
  };
  const read = async () => {
    assertCurrent();
    const engine = await assertDockerPersistentTargetCurrent(
      capability.target,
      AbortSignal.timeout(30_000),
    );
    const container = await readDockerPersistentContainer(
      engine,
      capability.containerId,
      AbortSignal.timeout(30_000),
    );
    assertCurrent();
    if (container.kind !== "running" || container.startedAt !== capability.containerStartedAt) {
      throw new CronStreamPolicyDeniedError(
        "The sandbox container changed while awaiting approval.",
      );
    }
    const imageId = await capability.resolveImage();
    const image = await execContainer(
      engine,
      ["image", "inspect", "--format", "{{.Id}}", capability.imageReference],
      { signal: AbortSignal.timeout(30_000) },
    );
    assertCurrent();
    if (image.stdout.trim() !== imageId) {
      throw new CronStreamPolicyDeniedError(
        "The configured sandbox image changed while awaiting approval.",
      );
    }
  };
  await read();
  return { assertCurrent, revalidate: read };
}
