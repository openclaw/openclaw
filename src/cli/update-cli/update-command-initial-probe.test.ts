import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { withUpdateInitialStoreInvocation } from "../../infra/update-initial-store-invocation.js";
import * as recovery from "../../infra/update-run-recovery-admission.js";
import * as stateOwner from "../../state/openclaw-state-ownership.js";
import { withInitialStoreFixture } from "./update-command-initial-store.test-support.js";
import { updateStateNeedsInitialization } from "./update-command-initialization.js";

it.each(["stable", "recovery-selector", "recovery-generation", "ownership-generation"] as const)(
  "revalidates the real initialization-state probe (%s)",
  async (phase) => {
    await withInitialStoreFixture(
      async ({ root, env, input }) => {
        const statePath = input.selection.state.databasePath;
        const before = fs.readFileSync(statePath);
        const other = path.join(root, "unselected-profile");
        fs.mkdirSync(other, { mode: 0o700 });
        const replace = () => {
          fs.renameSync(statePath, statePath + ".retained");
          fs.writeFileSync(statePath, before, { mode: 0o600 });
        };
        const admit = recovery.assertUpdateRecoveryAdmission;
        vi.spyOn(recovery, "assertUpdateRecoveryAdmission").mockImplementation(async (params) => {
          await admit(params);
          if (phase === "recovery-selector") {
            env.OPENCLAW_STATE_DIR = other;
          } else if (phase === "recovery-generation") {
            replace();
          }
        });
        const inspect = stateOwner.assertOpenClawStateWriteAllowedAtPath;
        const ownership = vi
          .spyOn(stateOwner, "assertOpenClawStateWriteAllowedAtPath")
          .mockImplementation(async (params) => {
            await inspect(params);
            if (phase === "ownership-generation") {
              replace();
            }
          });
        const operation = withUpdateInitialStoreInvocation(input, () =>
          updateStateNeedsInitialization(env),
        );
        if (phase === "stable") {
          await expect(operation).resolves.toBe(false);
          expect(ownership).toHaveBeenCalledExactlyOnceWith({
            databasePath: statePath,
            env,
            recoverOrphanedSidecars: false,
          });
        } else {
          await expect(operation).rejects.toThrow(
            phase === "recovery-selector"
              ? "effective installation or store selectors diverged"
              : "database generation changed",
          );
          if (phase.startsWith("recovery-")) {
            expect(ownership).not.toHaveBeenCalled();
          } else {
            expect(ownership).toHaveBeenCalledOnce();
          }
        }
        expect(fs.readdirSync(other)).toEqual([]);
        expect(fs.readFileSync(statePath)).toEqual(before);
        if (phase.endsWith("generation")) {
          expect(fs.readFileSync(statePath + ".retained")).toEqual(before);
        }
      },
      { applicationState: true },
    );
  },
);
