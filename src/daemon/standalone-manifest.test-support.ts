export function standaloneManifestFixture(
  mode: "aot" | "jit",
  executable: string,
  version: string,
  bunVersion: string,
) {
  return {
    schemaVersion: 1,
    mode,
    executable: { path: executable },
    runtime: { path: "runtime" },
    openclaw: { version },
    bun: { version: bunVersion },
  };
}
