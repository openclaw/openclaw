import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { readWorkspaceStateSnapshot } from "../../agents/workspace-state-store.js";
import * as admission from "../../infra/sqlite-worker-operation-admission.js";
import { withExistingOpenClawStateDatabaseCurrentReadOnly } from "../../state/openclaw-state-db-readonly.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import * as workerStore from "../../state/openclaw-state-worker-store.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createRuntimeAgent } from "./runtime-agent.js";
import type { PluginRuntime } from "./types.js";

it("allows deprecated plugin SQL checks once before dispatch while typed guards retain commit authority", async () => {
  type Params = NonNullable<Parameters<PluginRuntime["agent"]["ensureAgentWorkspace"]>[0]>;
  const state = await createOpenClawTestState({ layout: "state-only" });
  const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
  const ensure = createRuntimeAgent().ensureAgentWorkspace;
  const originalAdmission = admission.createSqliteWorkerOperationAdmission;
  const originalOperation = workerStore.runOpenClawStateWorkerOperation;
  const originalMkdir = fsPromises.mkdir;
  let phase: string | undefined;
  let workspace: string;
  const events: string[] = [];
  vi.spyOn(admission, "createSqliteWorkerOperationAdmission").mockImplementation((admit, data) =>
    originalAdmission((request, grant) => {
      phase = request.stage;
      try {
        admit(request, () => {
          events.push(`grant:${phase}`);
          return grant();
        });
      } finally {
        phase = undefined;
      }
    }, data),
  );
  vi.spyOn(workerStore, "runOpenClawStateWorkerOperation").mockImplementation(
    (context, operation, options) =>
      originalOperation(
        context,
        (scope) => {
          const execute: typeof scope.execute = (...args) => {
            events.push(`dispatch:${args[0].type}`);
            return scope.execute(...args);
          };
          return operation({ execute });
        },
        options,
      ),
  );
  vi.spyOn(fsPromises, "mkdir").mockImplementation((dir, options) => {
    if (dir === workspace) {
      events.push("file:mkdir");
    }
    return originalMkdir(dir, options);
  });
  try {
    runOpenClawStateWriteTransaction(() => undefined);
    for (const mode of [
      "initial-refusal",
      "allowed-sql",
      "legacy-refusal",
      "typed-revocation",
    ] as const) {
      workspace = state.path(mode);
      events.length = 0;
      if (mode !== "initial-refusal") {
        fs.mkdirSync(workspace);
        fs.writeFileSync(`${workspace}/AGENTS.md`, "Synthetic workspace instructions.\n");
      }
      const before = await readWorkspaceStateSnapshot(workspace, { readOnly: true });
      const refusal = new Error("plugin authority revoked");
      const params: Params = {
        dir: workspace,
        ensureBootstrapFiles: false,
        guard: {
          assertHost() {
            if (phase) {
              events.push("typed");
              if (mode === "typed-revocation" && phase === "commit") {
                throw refusal;
              }
            }
          },
        },
        beforePersistentApply() {
          expect(phase).toBeUndefined();
          const previous = events.at(-1);
          events.push("legacy");
          if (
            mode === "initial-refusal" ||
            (mode === "legacy-refusal" && previous === "file:mkdir")
          ) {
            throw refusal;
          }
          expect(
            withExistingOpenClawStateDatabaseCurrentReadOnly(({ db }) =>
              db.prepare("SELECT 1 AS value").get(),
            ),
          ).toEqual({ value: 1 });
        },
      };
      const pending = ensure(params);
      if (mode === "allowed-sql") {
        await pending;
        expect(events.filter((event) => event !== "typed" && !event.startsWith("grant:"))).toEqual([
          "legacy",
          "dispatch:workspace.snapshotAndRegister",
          "legacy",
          "file:mkdir",
          "legacy",
          "dispatch:workspace.replaceAttestation",
        ]);
        for (const [index, event] of events.entries()) {
          if (event.startsWith("grant:")) {
            expect(events[index - 1]).toBe("typed");
          }
        }
        expect(events).toContain("grant:commit");
        expect(
          (await readWorkspaceStateSnapshot(workspace, { readOnly: true })).attestation,
        ).toBeDefined();
      } else {
        await expect(pending).rejects.toBe(refusal);
        expect(await readWorkspaceStateSnapshot(workspace, { readOnly: true })).toEqual(before);
        if (mode === "initial-refusal") {
          expect(events).toEqual(["legacy"]);
          expect(fs.existsSync(workspace)).toBe(false);
        } else if (mode === "legacy-refusal") {
          expect(events.filter((event) => event.startsWith("dispatch:"))).toEqual([
            "dispatch:workspace.snapshotAndRegister",
          ]);
        }
      }
    }
    expect(warning).toHaveBeenCalledExactlyOnceWith(
      expect.stringMatching(
        /before dispatch.*synchronous OpenClaw DB access.*deprecated.*guard.assertHost/,
      ),
      { code: "DEP_WORKSPACE_MUTATION_GUARD", type: "DeprecationWarning" },
    );
  } finally {
    vi.restoreAllMocks();
    await state.cleanup();
  }
});
