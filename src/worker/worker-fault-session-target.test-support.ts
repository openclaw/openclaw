import { vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as workerSessionTarget from "../gateway/worker-environments/session-target.js";
import { withEnv } from "../test-utils/env.js";

const resolveGatewaySessionTarget = workerSessionTarget.resolveWorkerSessionTarget;

/** Gateway and worker share a process only in this fixture; bind its real Gateway reads. */
export function bindWorkerFixtureSessionTarget(cfg: OpenClawConfig, env: NodeJS.ProcessEnv) {
  const resolver = vi
    .spyOn(workerSessionTarget, "resolveWorkerSessionTarget")
    .mockImplementation((current, id) =>
      current === cfg
        ? withEnv(env, () => resolveGatewaySessionTarget(current, id))
        : resolveGatewaySessionTarget(current, id),
    );
  return () => resolver.mockRestore();
}
