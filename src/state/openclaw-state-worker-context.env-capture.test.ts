import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { cloneEnvWithPlatformSemantics } from "../config/config-env-vars.js";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";
import { closeOpenClawStateDatabaseAsync } from "./openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";
import { getCanonicalUserPreferences, setCanonicalUserPreferences } from "./user-preferences.js";
import { ensureProfileForEmail } from "./user-profiles.js";

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

it.runIf(process.platform === "win32")(
  "keeps a real worker operation on the captured mixed-case state root",
  async () => {
    const proofRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-win-worker-capture-"));
    const capturedRoot = path.join(proofRoot, "captured");
    const changedRoot = path.join(proofRoot, "changed");
    const safeHome = path.join(proofRoot, "home");
    const env: NodeJS.ProcessEnv = {
      HOME: safeHome,
      USERPROFILE: safeHome,
      OpenClaw_State_Dir: capturedRoot,
    };
    fs.mkdirSync(safeHome, { recursive: true });

    try {
      const profile = ensureProfileForEmail("worker-capture@example.invalid", {
        env,
        path: path.join(capturedRoot, "state", "openclaw.sqlite"),
      });
      await closeOpenClawStateDatabaseAsync();
      const write = setCanonicalUserPreferences(
        profile.id,
        { "proof.route": { completed: true } },
        { env },
      );
      env.OpenClaw_State_Dir = changedRoot;

      expect((await write)?.ok).toBe(true);
      await expect(
        getCanonicalUserPreferences(profile.id, ["proof.route"], {
          env: {
            HOME: safeHome,
            USERPROFILE: safeHome,
            OpenClaw_State_Dir: capturedRoot,
          },
        }),
      ).resolves.toEqual({
        profileId: profile.id,
        entries: { "proof.route": { completed: true } },
      });
      expect(fs.existsSync(path.join(capturedRoot, "state", "openclaw.sqlite"))).toBe(true);
      expect(fs.existsSync(path.join(changedRoot, "state", "openclaw.sqlite"))).toBe(false);
      expect(fs.existsSync(path.join(safeHome, ".openclaw", "state", "openclaw.sqlite"))).toBe(
        false,
      );
    } finally {
      await closeOpenClawStateDatabaseAsync().catch(() => {});
      fs.rmSync(proofRoot, { force: true, recursive: true });
    }
  },
);
