import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { exitCliAfterOutput, runCliWithExitFinalization } from "../cli/one-shot-exit.js";
import { withCliPluginInvocation } from "../cli/run-main-plugin-cache.js";
import { withCliProcessScope } from "../cli/runtime-cleanup-scope.js";
import { closeCliResources } from "../cli/runtime-cleanup.js";
import { withPluginSourceCaptureStorage } from "../plugins/plugin-source-capture-context.js";
import { defaultRuntime } from "../runtime.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { withEnvAsync } from "../test-utils/env.js";
import { runDoctorLintCliInProcess } from "./doctor-lint-runner.js";

type NativeObservation = {
  image: string;
  companion: string;
  privateStateDir: string;
  addon: { type: (name: string) => { size: number } };
};

async function inspect(): Promise<NativeObservation> {
  await withCliProcessScope(() =>
    withCliPluginInvocation(false, async (cleanup) => {
      try {
        assert.equal(
          await runDoctorLintCliInProcess(defaultRuntime, {
            json: true,
            onlyIds: ["core/doctor/runtime-tool-schemas"],
          }),
          0,
        );
      } finally {
        await closeCliResources(cleanup);
        await cleanup?.pluginResources?.release();
      }
    }),
  );
  const observed: NativeObservation | undefined = Reflect.get(
    globalThis,
    Symbol.for("doctor-native-capture-proof"),
  );
  assert(observed, "Doctor did not inspect the native plugin");
  assert.notEqual(observed.privateStateDir, process.env.OPENCLAW_STATE_DIR);
  assert.equal(fs.existsSync(observed.privateStateDir), false);
  assert.equal(fs.existsSync(observed.image), true);
  assert.equal(fs.readFileSync(observed.companion, "utf8"), "retained native companion");
  assert.equal(observed.addon.type("uint32_t").size, 4);
  assert.equal(
    fs.existsSync(path.join(process.env.OPENCLAW_STATE_DIR!, "tmp", "plugin-captures")),
    false,
  );
  return observed;
}

void runCliWithExitFinalization({
  async run() {
    const originalState = process.env.OPENCLAW_STATE_DIR!;
    const observed = [await inspect()];
    await closeOpenClawStateDatabaseAsync();
    const privateState = process.argv[2]!;
    const privateDatabase = resolveOpenClawStateSqlitePath({ OPENCLAW_STATE_DIR: privateState });
    fs.mkdirSync(path.dirname(privateDatabase), { recursive: true });
    // The synthetic source is closed and checkpointed before creating the enclosing private view.
    fs.copyFileSync(resolveOpenClawStateSqlitePath(), privateDatabase);
    try {
      observed.push(
        await withPluginSourceCaptureStorage(
          { stateDir: originalState, placement: "temporary" },
          () => withEnvAsync({ OPENCLAW_STATE_DIR: privateState }, inspect),
        ),
      );
    } finally {
      await closeOpenClawStateDatabaseAsync();
      fs.rmSync(privateState, { recursive: true });
    }
    assert.notEqual(observed[0]!.image, observed[1]!.image);
    for (const capture of observed) {
      assert.equal(fs.readFileSync(capture.companion, "utf8"), "retained native companion");
      assert.equal(capture.addon.type("uint32_t").size, 4);
    }
    process.stdout.write(
      "CAPTURE_PROOF:" +
        JSON.stringify(observed.map(({ image, companion }) => ({ image, companion }))) +
        "\n",
    );
    exitCliAfterOutput(defaultRuntime, 0);
  },
  onError(error) {
    console.error(error);
    process.exitCode = 1;
  },
});
