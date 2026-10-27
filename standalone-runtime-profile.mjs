// The executing image owns its runtime profile; sidecars describe artifacts on disk.
let runtimeExecutionProfile;

function resolveRuntimeExecutionProfile(build) {
  return build?.mode === "aot" ? "embedded-aot" : "dynamic-execution";
}

/** Compiler bootstrap installs image facts before any application entry or worker executes. */
export function getRuntimeExecutionProfile() {
  return (runtimeExecutionProfile ??= resolveRuntimeExecutionProfile(
    // eslint-disable-next-line no-underscore-dangle -- Compiler-owned bootstrap contract.
    globalThis.__openclawStandaloneBuildInfo,
  ));
}
