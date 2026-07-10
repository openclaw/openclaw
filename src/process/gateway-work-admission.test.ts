// Covers root work counting and reversible suspension admission transitions.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  beginGatewayRestartSignalAdmission,
  GatewayDrainingError,
  getActiveGatewayRootWorkCount,
  isGatewayWorkAdmissionClosed,
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
  runWithGatewayRootWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "./gateway-work-admission.js";

beforeEach(resetGatewayWorkAdmission);
afterEach(resetGatewayWorkAdmission);

it("counts one nested root chain once and excludes the preparing caller", async () => {
  const outer = tryBeginGatewayRootWorkAdmission();
  expect(outer).not.toBeNull();
  expect(outer?.ownsRoot).toBe(true);
  await outer?.run(async () => {
    expect(getActiveGatewayRootWorkCount()).toBe(1);
    expect(getActiveGatewayRootWorkCount({ excludeCurrent: true })).toBe(0);
    const nested = tryBeginGatewayRootWorkAdmission();
    expect(nested).not.toBeNull();
    expect(nested?.ownsRoot).toBe(false);
    expect(getActiveGatewayRootWorkCount()).toBe(1);
    nested?.release();
  });
  outer?.release();
  expect(getActiveGatewayRootWorkCount()).toBe(0);
});

it("rolls back or releases a generation-bound suspension without resetting roots", () => {
  const invalidated = vi.fn();
  const preparing = tryBeginGatewaySuspendAdmission(invalidated);
  expect(preparing).not.toBeNull();
  expect(isGatewayWorkAdmissionClosed()).toBe(true);
  expect(tryBeginGatewayRootWorkAdmission()).toBeNull();
  expect(preparing?.rollback()).toBe(true);
  expect(isGatewayWorkAdmissionClosed()).toBe(false);

  const prepared = tryBeginGatewaySuspendAdmission(invalidated);
  expect(prepared?.commit()).toBe(true);
  expect(prepared?.release()).toBe(true);
  expect(prepared?.release()).toBe(false);
  expect(invalidated).not.toHaveBeenCalled();
  expect(isGatewayWorkAdmissionClosed()).toBe(false);
});

it("does not let a stale suspension release clear restart drain", () => {
  const invalidated = vi.fn();
  const suspension = tryBeginGatewaySuspendAdmission(invalidated);
  expect(suspension?.commit()).toBe(true);

  markGatewayRestartDraining();

  expect(invalidated).toHaveBeenCalledOnce();
  expect(suspension?.release()).toBe(false);
  expect(isGatewayWorkAdmissionClosed()).toBe(true);
});

it("blocks suspension while restart signal handling is pending", () => {
  const pendingSignal = beginGatewayRestartSignalAdmission();

  expect(isGatewayWorkAdmissionClosed()).toBe(true);
  expect(tryBeginGatewayRootWorkAdmission()).toBeNull();
  expect(tryBeginGatewaySuspendAdmission(() => {})).toBeNull();
  expect(pendingSignal.rollback()).toBe(true);
  expect(isGatewayWorkAdmissionClosed()).toBe(false);
  expect(tryBeginGatewaySuspendAdmission(() => {})?.rollback()).toBe(true);
});

it("promotes a pending restart signal to one-way drain", () => {
  const pendingSignal = beginGatewayRestartSignalAdmission();

  markGatewayRestartDraining();

  expect(pendingSignal.rollback()).toBe(false);
  expect(isGatewayWorkAdmissionClosed()).toBe(true);
  expect(tryBeginGatewayRootWorkAdmission()).toBeNull();
});

it("defers required internal root work until suspension reopens", async () => {
  const suspension = tryBeginGatewaySuspendAdmission(() => {});
  expect(suspension?.commit()).toBe(true);
  const entered = vi.fn();
  const pending = runWithGatewayRootWorkAdmission(async () => {
    entered();
    expect(getActiveGatewayRootWorkCount()).toBe(1);
  });

  await Promise.resolve();
  expect(entered).not.toHaveBeenCalled();
  suspension?.release();
  await pending;

  expect(entered).toHaveBeenCalledOnce();
  expect(getActiveGatewayRootWorkCount()).toBe(0);
});

it("retires surviving root records across an in-process reset", async () => {
  const root = tryBeginGatewayRootWorkAdmission();
  expect(root).not.toBeNull();
  await root?.run(async () => {
    resetGatewayWorkAdmission();
    expect(getActiveGatewayRootWorkCount()).toBe(0);
    const nested = tryBeginGatewayRootWorkAdmission();
    expect(nested).not.toBeNull();
    expect(nested?.ownsRoot).toBe(true);
    expect(getActiveGatewayRootWorkCount()).toBe(1);
    nested?.release();
  });
  root?.release();
  expect(getActiveGatewayRootWorkCount()).toBe(0);
});

it("does not wake deferred internal work into a restart drain", async () => {
  const suspension = tryBeginGatewaySuspendAdmission(() => {});
  expect(suspension?.commit()).toBe(true);
  const pending = runWithGatewayRootWorkAdmission(async () => {});

  markGatewayRestartDraining();

  await expect(pending).rejects.toBeInstanceOf(GatewayDrainingError);
});
