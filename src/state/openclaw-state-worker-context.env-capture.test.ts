import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { cloneEnvWithPlatformSemantics } from "../config/config-env-vars.js";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";

it.each([
  { platform: "win32", stateKey: "OpenClaw_State_Dir", input: "plain" },
  { platform: "win32", stateKey: "OpenClaw_State_Dir", input: "precloned" },
  { platform: "linux", stateKey: "OPENCLAW_STATE_DIR", input: "plain" },
] as const)("pins a $input state root on $platform", (fixture) => {
  withMockedPlatform(fixture.platform, () => {
    const originalRoot = path.join(os.tmpdir(), "openclaw-state-worker-captured");
    const rawEnv: NodeJS.ProcessEnv = {
      HOME: path.resolve("C:/Users/fixture"),
      [fixture.stateKey]: originalRoot,
    };
    const env = fixture.input === "precloned" ? cloneEnvWithPlatformSemantics(rawEnv) : rawEnv;

    const context = captureOpenClawStateWorkerContext({ env });

    expect(context.environment.OPENCLAW_STATE_DIR).toBe(originalRoot);
    expect(context.admission.databasePath).toBe(
      path.join(originalRoot, "state", "openclaw.sqlite"),
    );

    env[fixture.stateKey] = path.join(os.tmpdir(), "openclaw-state-worker-changed");
    expect(context.environment.OPENCLAW_STATE_DIR).toBe(originalRoot);
    expect(context.admission.databasePath).toBe(
      path.join(originalRoot, "state", "openclaw.sqlite"),
    );
  });
});
