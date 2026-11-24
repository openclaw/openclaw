import { expect, it } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import {
  patchSessionEntryCore,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { readSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { prepareWorkerPlacementSessionRuntime } from "./placement-session-runtime-preparation.js";

it("prepares parent model facts without host SQL and recomputes current config", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const parent = { agentId: "main", sessionKey: "agent:main:placement-runtime-parent" };
    const child = { agentId: "main", sessionKey: "agent:main:placement-runtime-child" };
    const cfg = { agents: { defaults: { model: { primary: "anthropic/claude-test" } } } };
    setRuntimeConfigSnapshot(cfg);
    const entry = {
      sessionId: "placement-runtime-child",
      updatedAt: 1,
      parentSessionKey: parent.sessionKey,
    };
    await upsertSessionEntryCore(child, entry);
    const sql = observeHostDataSql();
    try {
      const absent = await prepareWorkerPlacementSessionRuntime({ ...child, cfg, entry });
      expect(absent(cfg, entry)).toBe("openclaw");
      await upsertSessionEntryCore(parent, {
        sessionId: "placement-runtime-parent",
        updatedAt: 1,
        providerOverride: "openai",
        modelOverride: "gpt-5.6-sol",
      });
      expect(absent(cfg, entry)).toBe("openclaw");

      const prepared = await prepareWorkerPlacementSessionRuntime({ ...child, cfg, entry });
      expect(prepared(cfg, entry)).toBe("codex");
      expect(prepared({ ...cfg, cloudWorkers: { requiredProfile: "test-profile" } }, entry)).toBe(
        "openclaw",
      );
      await patchSessionEntryCore(child, () => ({ label: "A display-only edit" }), {
        workerGuard: {},
      });
      const currentChild = await readSessionEntryReadOnlyInWorker(child);
      expect(currentChild?.label).toBe("A display-only edit");
      expect(prepared(cfg, currentChild!)).toBe("codex");
      await patchSessionEntryCore(
        parent,
        () => ({ providerOverride: "anthropic", modelOverride: "claude-test" }),
        { workerGuard: {} },
      );
      expect(prepared(cfg, currentChild!)).toBe("codex");
      const refreshed = await prepareWorkerPlacementSessionRuntime({ ...child, cfg, entry });
      expect(refreshed(cfg, currentChild!)).toBe("openclaw");
      expect(sql.queries).toEqual([]);
    } finally {
      sql.restore();
    }
  });
});
