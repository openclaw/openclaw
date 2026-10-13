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

it("retains parent model authority without host SQL and recomputes current config", async () => {
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
      using absent = await prepareWorkerPlacementSessionRuntime({ ...child, cfg, entry });
      expect(absent.read(cfg, entry)).toBe("openclaw");
      await upsertSessionEntryCore(parent, {
        sessionId: "placement-runtime-parent",
        updatedAt: 1,
        providerOverride: "openai",
        modelOverride: "gpt-5.6-sol",
      });
      expect(() => absent.read(cfg, entry)).toThrow("model inheritance changed");

      using prepared = await prepareWorkerPlacementSessionRuntime({ ...child, cfg, entry });
      expect(prepared.read(cfg, entry)).toBe("codex");
      expect(
        prepared.read({ ...cfg, cloudWorkers: { requiredProfile: "test-profile" } }, entry),
      ).toBe("openclaw");
      await patchSessionEntryCore(child, () => ({ label: "A display-only edit" }), {
        workerGuard: {},
      });
      const currentChild = await readSessionEntryReadOnlyInWorker(child);
      expect(currentChild?.label).toBe("A display-only edit");
      expect(prepared.read(cfg, currentChild!)).toBe("codex");
      await patchSessionEntryCore(
        parent,
        () => ({ providerOverride: "anthropic", modelOverride: "claude-test" }),
        { workerGuard: {} },
      );
      expect(() => prepared.read(cfg, currentChild!)).toThrow("model inheritance changed");
      expect(sql.queries).toEqual([]);
    } finally {
      sql.restore();
    }
  });
});
