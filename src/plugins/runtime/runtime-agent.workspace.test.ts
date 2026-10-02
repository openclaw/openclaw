import fs from "node:fs";
import { expect, it, vi } from "vitest";
import { readWorkspaceStateSnapshot } from "../../agents/workspace-state-store.js";
import * as admission from "../../infra/sqlite-worker-operation-admission.js";
import { withExistingOpenClawStateDatabaseCurrentReadOnly } from "../../state/openclaw-state-db-readonly.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createRuntimeAgent } from "./runtime-agent.js";
import type { PluginRuntime } from "./types.js";

it("preserves released plugin callback authority, ordering, diagnostics, and type compatibility", async () => {
  type Params = NonNullable<Parameters<PluginRuntime["agent"]["ensureAgentWorkspace"]>[0]>;
  const state = await createOpenClawTestState({ layout: "state-only" });
  const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
  const ensure = createRuntimeAgent().ensureAgentWorkspace;
  const original = admission.createSqliteWorkerOperationAdmission;
  let phase: string | undefined;
  const events: string[] = [];
  vi.spyOn(admission, "createSqliteWorkerOperationAdmission").mockImplementation((admit, data) =>
    original((request, grant) => {
      phase = request.stage;
      events.push(phase);
      try {
        admit(request, () => {
          events.push("grant");
          return grant();
        });
      } finally {
        phase = undefined;
      }
    }, data),
  );
  try {
    for (const mode of [
      "initial",
      "allowed",
      "commit",
      "reentrant",
      "attestation-revoked",
      "attestation-reentrant",
    ] as const) {
      const reentrant = mode.endsWith("reentrant");
      const dir = state.path(mode);
      events.length = 0;
      if (mode !== "initial") {
        fs.mkdirSync(dir);
        fs.writeFileSync(`${dir}/AGENTS.md`, "Synthetic workspace instructions.\n");
      }
      const before = await readWorkspaceStateSnapshot(dir, { readOnly: true });
      const refusal = new Error("plugin authority revoked");
      const params: Params = {
        dir,
        ensureBootstrapFiles: !mode.startsWith("attestation"),
        guard: { assertHost: () => phase && void events.push("typed") },
        beforePersistentApply() {
          if (phase) {
            events.push("legacy");
          }
          if (
            mode === "initial" ||
            ((mode === "commit" || mode === "attestation-revoked") && phase === "commit")
          ) {
            throw refusal;
          }
          if (reentrant && phase === "commit") {
            withExistingOpenClawStateDatabaseCurrentReadOnly(({ db }) =>
              db.prepare("SELECT 1").get(),
            );
          }
        },
      };
      const pending = ensure(params);
      if (mode === "allowed") {
        await pending;
        for (const [index, event] of events.entries()) {
          if (event === "grant") {
            expect(events.slice(index - 2, index)).toEqual(["typed", "legacy"]);
          }
        }
        expect(events).toContain("commit");
        expect((await readWorkspaceStateSnapshot(dir)).setupExists).toBe(true);
      } else {
        if (reentrant) {
          await expect(pending).rejects.toThrow(
            /beforePersistentApply.*synchronous OpenClaw.*guard.assertHost/,
          );
        } else {
          await expect(pending).rejects.toBe(refusal);
        }
        expect(await readWorkspaceStateSnapshot(dir, { readOnly: true })).toEqual(before);
        if (mode === "initial") {
          expect(fs.existsSync(dir)).toBe(false);
        } else {
          expect(events.slice(-3)).toEqual(["commit", "typed", "legacy"]);
        }
      }
    }
    expect(warning).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("guard.assertHost"), {
      code: "DEP_WORKSPACE_MUTATION_GUARD",
      type: "DeprecationWarning",
    });
  } finally {
    vi.restoreAllMocks();
    await state.cleanup();
  }
});
