import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  assertDaemonRuntimePinCurrent,
  commitDaemonRuntimePin,
  readDaemonRuntimePin,
  readDaemonRuntimePinForInstall,
} from "./runtime-pin-state.js";

afterEach(() => closeOpenClawStateDatabaseForTest());
const runtimePath = "/runtime tools/node";
const command = { programArguments: [runtimePath, "/app/openclaw.mjs", "gateway"] };
const pin = { runtime: "node" as const, path: runtimePath };
describe("transactional runtime pin state", () => {
  it("keeps absent/default state read-only and persists explicit intent across reopen", async () => {
    await withOpenClawTestState({ label: "runtime-pin" }, async (state) => {
      const scope = { kind: "gateway" as const, env: state.env };
      const empty = readDaemonRuntimePin(scope, command);
      expect(empty.pin).toBeUndefined();
      expect(fs.existsSync(state.statePath("state", "openclaw.sqlite"))).toBe(false);
      commitDaemonRuntimePin(scope, { expected: empty, pin }, command);
      closeOpenClawStateDatabaseForTest();
      expect(readDaemonRuntimePin(scope, command).pin).toEqual(pin);
      expect(readDaemonRuntimePin({ ...scope, kind: "node" }, command).pin).toBeUndefined();
      expect(
        readDaemonRuntimePin(
          { ...scope, env: { ...state.env, OPENCLAW_PROFILE: "other" } },
          command,
        ).pin,
      ).toBeUndefined();
      expect(
        readDaemonRuntimePin(
          { ...scope, env: { ...state.env, OPENCLAW_CONFIG_PATH: state.path("other.json") } },
          command,
        ).pin,
      ).toBeUndefined();
    });
  });
  it("rejects stale plans and definition mismatch without adopting operator overrides", async () => {
    await withOpenClawTestState({ label: "runtime-pin-stale" }, async (state) => {
      const scope = { kind: "gateway" as const, env: state.env };
      const original = readDaemonRuntimePin(scope, command);
      commitDaemonRuntimePin(scope, { expected: original, pin }, command);
      expect(() => assertDaemonRuntimePinCurrent(scope, original)).toThrow(/changed/);
      expect(() => commitDaemonRuntimePin(scope, { expected: original }, null)).toThrow(/changed/);
      const override = { programArguments: ["/operator/wrapper"], managedDefinition: command };
      expect(readDaemonRuntimePin(scope, override).pin).toEqual(pin);
      expect(() => readDaemonRuntimePin(scope, { programArguments: ["/different/node"] })).toThrow(
        /changed/,
      );
      expect(readDaemonRuntimePin(scope, null).pin).toBeUndefined();
      const explicit = readDaemonRuntimePinForInstall(scope, override, true);
      expect(explicit.pin).toBeUndefined();
      commitDaemonRuntimePin(scope, { expected: explicit }, null);
      expect(readDaemonRuntimePin(scope, command).stored).toBe(false);
    });
  });
  it("retains inactive wrapper pins separately and clears intent transactionally", async () => {
    await withOpenClawTestState({ label: "runtime-pin-wrapper" }, async (state) => {
      const scope = { kind: "gateway" as const, env: state.env };
      const wrapped = { programArguments: ["/wrapper", "gateway"] };
      const bun = { runtime: "bun" as const, path: "/runtime tools/bun" };
      commitDaemonRuntimePin(
        scope,
        { expected: readDaemonRuntimePin(scope, null), pin: bun },
        wrapped,
      );
      expect(readDaemonRuntimePin(scope, wrapped).pin).toEqual(bun);
      const updated = { programArguments: [bun.path, "/new/openclaw.mjs", "gateway"] };
      commitDaemonRuntimePin(
        scope,
        { expected: readDaemonRuntimePin(scope, wrapped), pin: bun },
        updated,
      );
      expect(readDaemonRuntimePin(scope, updated).pin).toEqual(bun);
      commitDaemonRuntimePin(scope, { expected: readDaemonRuntimePin(scope, updated) }, updated);
      expect(readDaemonRuntimePin(scope, updated).pin).toBeUndefined();
    });
  });
});
