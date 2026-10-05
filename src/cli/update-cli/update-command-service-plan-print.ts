import { theme } from "../../../packages/terminal-core/src/theme.js";
import { defaultRuntime } from "../../runtime.js";
import { CLI_NAME } from "../cli-name.js";
import { resolveNodeRunner } from "./shared.js";
import type { ManagedServiceRootRedirect } from "./update-command-service-context-types.js";

/** Describe the selected plan without changing roots, runtime, or service authority. */
export function printManagedServicePackageUpdatePlan(params: {
  rootRedirect: ManagedServiceRootRedirect | null;
  serviceRoot?: string;
  nodeRunner?: string;
}): void {
  const { rootRedirect, nodeRunner } = params;
  if (rootRedirect) {
    defaultRuntime.log(
      theme.muted(`Targeting managed gateway service package root: ${rootRedirect.root}`),
    );
    defaultRuntime.log(
      theme.warn(
        `Shell OpenClaw root differs from the managed gateway service root: ${rootRedirect.previousRoot}`,
      ),
    );
    defaultRuntime.log(
      theme.muted(
        `After the update, make sure \`${CLI_NAME}\` on PATH resolves to the managed service root or reinstall the gateway service from the shell install you want to use.`,
      ),
    );
    if (nodeRunner) {
      defaultRuntime.log(theme.muted(`Managed gateway service runtime: ${nodeRunner}`));
    }
  } else if (params.serviceRoot) {
    defaultRuntime.log(
      theme.muted(
        `Updating this installation and rebinding the managed Gateway from ${params.serviceRoot} after ownership and runtime verification.`,
      ),
    );
  } else if (nodeRunner) {
    defaultRuntime.log(
      theme.warn(
        `Current runtime (${resolveNodeRunner()}) differs from the managed gateway service runtime (${nodeRunner}).`,
      ),
    );
    defaultRuntime.log(
      theme.muted(
        "Using the managed service runtime for this update so the gateway can start after the upgrade.",
      ),
    );
  }
}
