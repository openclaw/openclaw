import { expect, it } from "vitest";
import { runNodeScript } from "../../test/helpers/run-node-script.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { stateNativeProcessEntrypoints } from "./native-process-runtime.test-support.js";

it("preserves onboarding ownership and completion through the host writer broker", async () => {
  const result = await runNodeScript(
    (workerArgv) =>
      workerArgv(resolveRuntimeWorkerUrl(stateNativeProcessEntrypoints.localOnboarding)),
    process.env,
    undefined,
  );
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.status, [result.stdout, result.stderr].join("\n")).toBe(0);
});
