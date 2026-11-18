import { expect, it } from "vitest";
import {
  readRestartSentinel,
  writeRestartSentinel,
  type RestartSentinelPayload,
} from "../infra/restart-sentinel.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  getLatestUpdateRestartSentinel,
  recordLatestUpdateRestartSentinel,
  refreshLatestUpdateRestartSentinel,
} from "./server-update-sentinel.js";

it("shares immutable reads while detaching recorded caller input", () => {
  const input: RestartSentinelPayload = {
    kind: "update",
    status: "ok",
    ts: 123,
    stats: { before: { version: "previous" } },
  };
  recordLatestUpdateRestartSentinel(input);
  const snapshot = getLatestUpdateRestartSentinel();
  input.stats!.before!.version = "caller edit";
  expect(snapshot?.stats?.before?.version).toBe("previous");
  expect(() => {
    snapshot!.stats!.before!.version = "reader edit";
  }).toThrow(TypeError);
  expect(getLatestUpdateRestartSentinel()).toBe(snapshot);
});

it("shares immutable pending and finalized snapshots during status refresh", async () => {
  await withOpenClawTestState(
    { label: "restart-snapshot", layout: "state-only" },
    async (state) => {
      const env = { OPENCLAW_STATE_DIR: state.stateDir };
      const sentinel = await writeRestartSentinel(
        {
          kind: "update",
          status: "skipped",
          ts: 123,
          stats: { mode: "git", handoffId: "handoff-1", reason: "managed-service-handoff-started" },
        },
        env,
      );
      const previous = await refreshLatestUpdateRestartSentinel(env);
      expect(previous).toEqual(sentinel.payload);
      expect(() => {
        previous!.stats!.reason = "reader edit";
      }).toThrow(TypeError);
      expect(getLatestUpdateRestartSentinel()).toBe(previous);
      expect(await readRestartSentinel(env)).toEqual(sentinel);

      await writeRestartSentinel(
        { kind: "update", status: "ok", ts: 124, stats: { before: { version: "previous" } } },
        env,
      );
      const current = await refreshLatestUpdateRestartSentinel(env);
      expect(getLatestUpdateRestartSentinel()).toBe(current);
      expect(current).toMatchObject({ status: "ok", stats: { before: { version: "previous" } } });
      expect(() => {
        current!.stats!.before!.version = "reader edit";
      }).toThrow(TypeError);
      expect(previous).toMatchObject({
        status: "skipped",
        stats: { reason: "managed-service-handoff-started" },
      });
    },
  );
});
