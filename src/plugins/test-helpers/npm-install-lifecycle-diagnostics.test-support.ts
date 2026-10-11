import { vi, type TestContext } from "vitest";
import { createFixtureDiagnostics } from "../../../test/helpers/fixture-diagnostics.js";

/** Keep native install timeout evidence bounded without changing command ownership. */
export async function observeNpmInstallLifecycle(
  source: "npm" | "npm-pack",
  {
    signal,
    onTestFailed,
    onTestFinished,
  }: Pick<TestContext, "signal" | "onTestFailed" | "onTestFinished">,
  scenario: "successor" | "authority" = "successor",
) {
  // E2E silences console output; timeout evidence must still reach the runner.
  const diagnostics = createFixtureDiagnostics(`plugin-${source}-${scenario}`, (message) => {
    process.stderr.write(`${message}\n`);
  });
  const observe = (phase: string, details: { version?: string } = {}) =>
    diagnostics.stage(details.version ? `${phase}:${details.version}` : phase);
  // Capture the blocked boundary before timeout teardown changes native state.
  const onAbort = () => diagnostics.report("abort");
  signal.addEventListener("abort", onAbort, { once: true });
  onTestFailed(() => diagnostics.report("failure"));
  onTestFinished(() => signal.removeEventListener("abort", onAbort));
  const commandSpawn = await import("../../process/exec-spawn.js");
  const spawnCommand = commandSpawn.spawnCommandWithInvocation;
  vi.spyOn(commandSpawn, "spawnCommandWithInvocation").mockImplementation((...args) => {
    if (args[0][0] !== "npm") {
      return spawnCommand(...args);
    }
    const observation = diagnostics.command(
      args[0][1] === "pack" ? "npm-pack-metadata" : "npm-install",
    );
    const result = spawnCommand(...args);
    // Observe native events after the command owner installs its handlers.
    queueMicrotask(() => observation.ready(result.child.nodeChildProcess));
    return result;
  });
  return observe;
}
