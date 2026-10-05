import { afterAll, beforeAll, expect, it, vi } from "vitest";
import * as configEnv from "../../config/config-env-vars.js";
import { loadSessionEntryForAdmission } from "../../config/sessions/session-accessor.sqlite-entry-admission.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.sqlite-entry.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { prepareCronSession } from "./session.js";

let state: OpenClawTestState;
beforeAll(async () => {
  state = await createOpenClawTestState({ scenario: "minimal" });
});
afterAll(async () => {
  await state.cleanup();
});

it.each(["admission", "cron discovery"] as const)(
  "reads stored sessions through %s with a Windows environment Proxy",
  async (mode) => {
    const sessionKey = `agent:main:cron:proxy-${mode.replaceAll(" ", "-")}`;
    const storePath = mode === "cron discovery" ? state.path("proxy-store.json") : undefined;
    const scope = { agentId: "main", env: state.env, sessionKey, storePath };
    const entry = { sessionId: "proxy-session", updatedAt: 1, sessionStartedAt: 1 };
    replaceSessionEntrySync(scope, entry);
    const clone = configEnv.cloneEnvWithPlatformSemantics;
    const windowsEnv = vi
      .spyOn(configEnv, "cloneEnvWithPlatformSemantics")
      .mockImplementation((env) => {
        const source: NodeJS.ProcessEnv = { ...env, openclaw_state_dir: env.OPENCLAW_STATE_DIR };
        delete source.OPENCLAW_STATE_DIR;
        // Use the actual Windows Proxy while keeping host paths and worker execution native.
        const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
        Object.defineProperty(process, "platform", { value: "win32" });
        try {
          return clone(source);
        } finally {
          Object.defineProperty(process, "platform", platform);
        }
      });
    try {
      expect(() => structuredClone(configEnv.cloneEnvWithPlatformSemantics(state.env))).toThrow(
        expect.objectContaining({ name: "DataCloneError", code: 25 }),
      );
      if (mode === "admission") {
        const admitted = await loadSessionEntryForAdmission(scope);
        try {
          expect(admitted.entry).toMatchObject(entry);
          admitted.databaseClaim.assertCurrent();
        } finally {
          await admitted.databaseClaim.release();
        }
      } else {
        const prepared = await prepareCronSession({
          cfg: { session: { store: storePath, reset: { mode: "none" } } },
          agentId: "main",
          sessionKey,
          nowMs: 2,
        });
        expect(prepared.sessionEntry).toMatchObject({ ...entry, updatedAt: 2 });
        expect(prepared.isNewSession).toBe(false);
      }
    } finally {
      windowsEnv.mockRestore();
    }
  },
);
