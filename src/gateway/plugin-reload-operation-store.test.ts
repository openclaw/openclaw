import assert from "node:assert/strict";
import { expect, it } from "vitest";
import { writeConfigMachineStateAsync } from "../state/config-machine-state-async.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  listPluginReloadOperations,
  readPluginReloadOperation,
  savePluginReloadOperation,
  type PluginReloadOperation,
} from "./plugin-reload-operation-store.js";

function operation(id: string, updatedAtMs = 1): PluginReloadOperation {
  return {
    id,
    pluginIds: ["example"],
    createdAtMs: 1,
    updatedAtMs,
    state: "accepted",
    continuations: [
      {
        agentId: "main",
        sessionKey: "agent:main:journal-proof",
        sessionId: "session-proof",
        lifecycleRevision: "revision-2",
        sourceRunId: "run-proof",
        recoverySource: {
          kind: "gateway",
          snapshot: {
            profileId: "operator-proof",
            scopes: ["operator.write"],
            assignedRole: null,
            githubLogin: null,
            grant: null,
            aliasBindingIds: [],
            authPolicy: {
              generation: "",
              grantGeneration: "proof-generation",
              role: "operator",
              authMethod: "token",
            },
            controlUiAdmin: false,
            localOperator: true,
            sourceIngress: "internal",
          },
        },
        queuedInputIds: ["queued-proof"],
        state: "pending",
      },
    ],
  };
}

it("round-trips native continuation custody through the actual state workers", async () => {
  await withOpenClawTestState({ label: "reload-journal-roundtrip" }, async ({ env }) => {
    const options = { env };
    expect(await readPluginReloadOperation("missing", options)).toBeUndefined();
    expect(await listPluginReloadOperations(options)).toEqual([]);
    const accepted = operation("roundtrip");
    await savePluginReloadOperation(accepted, options);
    expect(await readPluginReloadOperation(accepted.id, options)).toEqual(accepted);
    const [acceptedContinuation] = accepted.continuations;
    assert(acceptedContinuation, "expected the accepted continuation fixture");
    const complete = {
      ...accepted,
      state: "succeeded" as const,
      updatedAtMs: 2,
      result: { pluginIds: ["example"], reloaded: true },
      continuations: [{ ...acceptedContinuation, state: "complete" as const }],
    };
    await savePluginReloadOperation(complete, options);
    await writeConfigMachineStateAsync(
      "pluginReload.operation_other",
      { unrelated: true },
      options,
    );
    expect(await listPluginReloadOperations(options)).toEqual([complete]);
  });
});

it("atomically caps terminal receipts without pruning accepted intent or blocking existing updates", async () => {
  await withOpenClawTestState({ label: "reload-journal-retention" }, async ({ env }) => {
    const options = { env };
    const candidates = Array.from({ length: 33 }, (_, index) => operation("active-" + index));
    const admissions = await Promise.allSettled(
      candidates.map((entry) => savePluginReloadOperation(entry, options)),
    );
    const active = candidates.filter((_, index) => admissions[index]?.status === "fulfilled");
    expect(active).toHaveLength(32);
    const refused = admissions.filter((result) => result.status === "rejected");
    expect(refused).toHaveLength(1);
    const [refusal] = refused;
    assert(refusal, "expected one capacity refusal");
    const [firstActive, secondActive] = active;
    assert(firstActive && secondActive, "expected the active operation fixtures");
    expect(String(refusal.reason)).toContain("capacity reached (32 active operations)");
    await expect(savePluginReloadOperation(operation("overflow"), options)).rejects.toThrow(
      "capacity reached (32 active operations)",
    );
    expect(await readPluginReloadOperation("overflow", options)).toBeUndefined();
    await savePluginReloadOperation({ ...firstActive, state: "interrupting" }, options);
    await savePluginReloadOperation({ ...secondActive, state: "succeeded" }, options);
    for (let index = 0; index < 130; index += 1) {
      const terminal = operation("terminal-" + index, index + 2);
      terminal.state = index % 2 === 0 ? "succeeded" : "failed";
      for (const continuation of terminal.continuations) {
        continuation.state = "complete";
      }
      await savePluginReloadOperation(terminal, options);
    }
    const retained = await listPluginReloadOperations(options);
    expect(retained.filter((entry) => entry.id.startsWith("active-"))).toHaveLength(32);
    expect(
      (await readPluginReloadOperation(secondActive.id, options))?.continuations[0]?.state,
    ).toBe("pending");
    expect(retained.filter((entry) => entry.id.startsWith("terminal-"))).toHaveLength(128);
    expect(await readPluginReloadOperation("terminal-0", options)).toBeUndefined();
    expect(await readPluginReloadOperation("terminal-1", options)).toBeUndefined();
    expect(await readPluginReloadOperation("terminal-129", options)).toMatchObject({
      state: "failed",
    });
    expect(await readPluginReloadOperation(firstActive.id, options)).toMatchObject({
      state: "interrupting",
    });
    firstActive.state = "succeeded";
    firstActive.updatedAtMs = 200;
    for (const continuation of firstActive.continuations) {
      continuation.state = "complete";
    }
    await savePluginReloadOperation(firstActive, options);
    await savePluginReloadOperation(operation("replacement"), options);
    expect(await readPluginReloadOperation("replacement", options)).toEqual(
      operation("replacement"),
    );
    expect(await listPluginReloadOperations(options)).toHaveLength(160);
  });
});

it("rejects invalid writes and corrupt durable continuation custody", async () => {
  await withOpenClawTestState({ label: "reload-journal-validation" }, async ({ env }) => {
    const options = { env };
    const invalid = operation("invalid");
    Object.assign(invalid.continuations[0]!, { lifecycleRevision: -1 });
    await expect(savePluginReloadOperation(invalid, options)).rejects.toThrow();
    expect(await readPluginReloadOperation(invalid.id, options)).toBeUndefined();
    await writeConfigMachineStateAsync(
      "pluginReload.operation.corrupt",
      {
        ...operation("corrupt"),
        continuations: [{ ...operation("corrupt").continuations[0], recoverySource: {} }],
      },
      options,
    );
    await expect(readPluginReloadOperation("corrupt", options)).rejects.toThrow(
      "Invalid queued operator recovery source",
    );
    await expect(listPluginReloadOperations(options)).rejects.toThrow(
      "Invalid queued operator recovery source",
    );
  });
});

it.each(["forward", "reverse"] as const)(
  "merges queued custody from stale continuation snapshots in %s order",
  (order) =>
    withOpenClawTestState({ scenario: "minimal" }, async (fixture) => {
      const options = { env: { ...process.env, OPENCLAW_STATE_DIR: fixture.stateDir } };
      const initial = operation("stale-custody");
      const a = initial.continuations[0];
      assert(a);
      const b = structuredClone(a);
      b.agentId = "other";
      b.sessionKey = "agent:other:proof";
      b.sessionId = "session-other";
      b.sourceRunId = "source-other";
      initial.continuations.push(b);
      await savePluginReloadOperation(initial, options);
      const first = structuredClone(initial);
      const second = structuredClone(initial);
      const firstA = first.continuations[0];
      const secondB = second.continuations[1];
      assert(firstA && secondB);
      firstA.queuedInputIds.push("transferred-a");
      firstA.state = "accepted";
      secondB.queuedInputIds.push("transferred-b");
      secondB.state = "accepted";
      for (const snapshot of order === "forward" ? [first, second] : [second, first]) {
        await savePluginReloadOperation(snapshot, options);
      }
      let stored = await readPluginReloadOperation(initial.id, options);
      assert(stored);
      expect(stored.continuations[0]).toMatchObject({
        state: "accepted",
        queuedInputIds: ["queued-proof", "transferred-a"],
      });
      expect(stored.continuations[1]).toMatchObject({
        state: "accepted",
        queuedInputIds: ["queued-proof", "transferred-b"],
      });
      // Even another stale update of the same identity cannot erase transferred IDs.
      const stale = structuredClone(initial);
      const staleA = stale.continuations[0];
      assert(staleA);
      staleA.queuedInputIds.push("transferred-later");
      await savePluginReloadOperation(stale, options);
      stored = await readPluginReloadOperation(initial.id, options);
      assert(stored);
      expect(stored.continuations[0]?.queuedInputIds).toEqual([
        "queued-proof",
        "transferred-a",
        "transferred-later",
      ]);
      const terminalA = stored.continuations[0];
      const terminalB = stored.continuations[1];
      assert(terminalA && terminalB);
      terminalA.state = "complete";
      terminalB.state = "cancelled";
      await savePluginReloadOperation(stored, options);
      await savePluginReloadOperation(first, options);
      expect((await readPluginReloadOperation(initial.id, options))?.continuations).toEqual(
        stored.continuations,
      );
    }),
);
