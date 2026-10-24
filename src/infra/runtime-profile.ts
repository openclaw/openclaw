import {
  getStandaloneRuntimeBuild,
  isEmbeddedStandaloneModule,
  type StandaloneBuildInfo,
} from "../../cli-invocation.mjs";

export type RuntimeExecutionProfile = "dynamic-execution" | "embedded-aot";

let runtimeExecutionProfile: RuntimeExecutionProfile | undefined;

export function resolveRuntimeExecutionProfile(
  build: Pick<StandaloneBuildInfo, "mode"> | undefined,
): RuntimeExecutionProfile {
  return build?.mode === "aot" ? "embedded-aot" : "dynamic-execution";
}

/** Artifact capabilities stay fixed for this process, including its workers. */
export function getRuntimeExecutionProfile(): RuntimeExecutionProfile {
  return (runtimeExecutionProfile ??= resolveRuntimeExecutionProfile(getStandaloneRuntimeBuild()));
}

const DYNAMIC_EXECUTION_NEXT_STEP =
  "Run the Gateway with a Node/Bun installation or a JIT/bytecode standalone build.";

/** Compatibility admission, not an authorization or sandbox boundary. */
export function assertRuntimeSupportsDynamicExecution(feature: string): void {
  if (getRuntimeExecutionProfile() === "embedded-aot") {
    throw new Error(
      `${feature} requires the dynamic-execution runtime profile; this host uses embedded-aot. ` +
        DYNAMIC_EXECUTION_NEXT_STEP,
    );
  }
}

/** Only compiler-owned membership establishes that a module is already embedded. */
export function assertRuntimeSupportsPluginModule(modulePath: string): void {
  if (getRuntimeExecutionProfile() === "embedded-aot" && !isEmbeddedStandaloneModule(modulePath)) {
    throw new Error(
      `Plugin module ${modulePath} is not embedded in this AOT host and requires the dynamic-execution runtime profile. ` +
        "Rebuild the complete standalone artifact with this plugin. " +
        DYNAMIC_EXECUTION_NEXT_STEP,
    );
  }
}
