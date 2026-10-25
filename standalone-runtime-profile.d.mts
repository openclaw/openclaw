import type { StandaloneBuildInfo } from "./cli-invocation.mjs";

export type RuntimeExecutionProfile = "dynamic-execution" | "embedded-aot";

export function resolveRuntimeExecutionProfile(
  build: Pick<StandaloneBuildInfo, "mode"> | undefined,
): RuntimeExecutionProfile;

export function getRuntimeExecutionProfile(): RuntimeExecutionProfile;
