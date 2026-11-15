import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import {
  acceptGatewayDeviceSourceAuthority as acceptSource,
  bindGatewayDeviceRevocation as bindGuard,
  captureGatewayDeviceRevocation as capture,
  closeGatewayDeviceRevocation as closeGateway,
  hasPreparedGatewayDeviceAuthority as hasAuthority,
  invalidateGatewayDeviceRevocation as invalidate,
  onGatewayDeviceSourceRevoked as onRevoked,
  retainGatewayDeviceRevocation as retain,
  readGatewayDeviceSourceAuthority as readSource,
  readAcceptedGatewayDeviceSourceAuthority as readAccepted,
} from "./device-revocation.js";

const device = { deviceId: "device", role: "operator" };
const live = () => true;
const makeSource = (isCurrent = live, release = () => {}) => ({
  isCurrent,
  subscribe: () => release,
});
const hold = (guard: Parameters<typeof retain>[0]) => expectDefined(retain(guard), "hold");
const expectCurrent = (expected: boolean, ...guards: Array<() => boolean>) =>
  expect(guards.map((guard) => guard())).toEqual(guards.map(() => expected));
const expectInactive = (guard: () => boolean, ...related: Array<() => boolean>) => {
  expectCurrent(false, guard, ...related);
  expect(() => retain(guard)).toThrow("no longer active");
};

describe("Gateway device revocation", () => {
  it("keeps accepted source custody through fencing, but only while a holder retains it", () => {
    const connection = new AbortController();
    let transportCurrent = true;
    let sourceCurrent = true;
    const releaseSource = vi.fn();
    const source = makeSource(() => sourceCurrent, releaseSource);
    const request = capture({}, {}, () => transportCurrent, connection.signal, source);
    transportCurrent = false;
    expect(request.isCurrent()).toBe(false);
    const client = { invalidated: true };
    expect(hasAuthority(client, request.isCurrent)).toBe(false);
    expect(acceptSource(request.isCurrent)).toBe(true);
    expect(hasAuthority(client, request.isCurrent)).toBe(true);
    const accepted = expectDefined(readAccepted(request.isCurrent), "accepted source");
    const releaseInput = hold(request.isCurrent);
    request.release();
    expectCurrent(true, request.isCurrent, accepted);
    sourceCurrent = false;
    expect(hasAuthority(client, request.isCurrent)).toBe(false);
    expectCurrent(false, request.isCurrent, accepted);
    sourceCurrent = true;
    releaseInput();
    expect(releaseSource).toHaveBeenCalledOnce();
    expect(connection.signal.aborted).toBe(false);
    expect(acceptSource(request.isCurrent)).toBe(false);
    expect(hasAuthority(client, request.isCurrent)).toBe(false);
    expectInactive(request.isCurrent, accepted);
  });

  it("does not retain or accept unknown source guards", () => {
    expect([retain(undefined), retain(live)]).toEqual([undefined, undefined]);
    expect(acceptSource(() => true)).toBe(false);
  });

  it("retains one source until its last independent holder releases it", () => {
    const context = {};
    const releaseSource = vi.fn();
    const request = capture(context, device, live, undefined, makeSource(live, releaseSource));
    const revoked = vi.fn();
    const unsubscribe = onRevoked(request.isCurrent, revoked);
    const releaseRun = hold(request.isCurrent);
    const releaseQueuedTurn = hold(request.isCurrent);
    request.release();
    expect(request.isCurrent()).toBe(true);
    releaseRun();
    expect([releaseSource.mock.calls, revoked.mock.calls]).toEqual([[], []]);
    invalidate(context, "device", "operator");
    expect(revoked).toHaveBeenCalledOnce();
    expect(acceptSource(request.isCurrent)).toBe(false);
    expectInactive(request.isCurrent);
    const replacement = capture(context, device, live);
    expect(replacement.isCurrent()).toBe(true);
    releaseQueuedTurn();
    releaseQueuedTurn();
    expect(releaseSource).toHaveBeenCalledOnce();
    expect([request.isCurrent(), replacement.isCurrent()]).toEqual([false, true]);
    replacement.release();
    unsubscribe?.();
  });

  it("preserves exact device and optional role matching", () => {
    const context = {};
    const operator = capture(context, device, () => true);
    const node = capture(context, { deviceId: "device", role: "node" }, () => true);
    const otherDevice = capture(context, { deviceId: "other", role: "operator" }, () => true);
    invalidate(context, "device", "operator");
    expectCurrent(false, operator.isCurrent);
    expectCurrent(true, node.isCurrent, otherDevice.isCurrent);
    invalidate(context, "device");
    expect([node.isCurrent(), otherDevice.isCurrent()]).toEqual([false, true]);
    [operator, node, otherDevice].forEach((request) => request.release());
  });

  it.each([false, true])("requires a live owner after release (connection: %s)", (connected) => {
    const connection = new AbortController();
    let clientInvalidated = false;
    const signal = connected ? connection.signal : undefined;
    const request = capture({}, device, () => !clientInvalidated, signal);
    expectCurrent(true, request.isCurrent);
    expect(acceptSource(request.isCurrent)).toBe(false);
    expect(readAccepted(request.isCurrent)).toBeUndefined();
    const revoked = vi.fn();
    const unsubscribe = onRevoked(request.isCurrent, revoked);
    request.release();
    request.release();
    expect(request.isCurrent()).toBe(connected);
    expect(() => retain(request.isCurrent)).toThrow("no longer active");
    clientInvalidated = true;
    expect(request.isCurrent()).toBe(false);
    clientInvalidated = false;
    connection.abort();
    expect(request.isCurrent()).toBe(false);
    expect(revoked).not.toHaveBeenCalled();
    unsubscribe?.();
  });

  it("transfers the same caller through a queued commit guard", () => {
    const context = {};
    let requestCurrent = true;
    let authenticated = true;
    const request = capture(context, device, () => authenticated);
    const guard = bindGuard(() => {
      if (!requestCurrent || !request.isCurrent()) {
        throw new Error("revoked");
      }
    }, request.isCurrent);
    const releaseQueue = hold(guard);
    const source = expectDefined(readSource(guard), "original auth guard");
    request.release();
    expect(guard).not.toThrow();
    requestCurrent = false;
    expect(guard).toThrow("revoked");
    expect(source()).toBe(true);
    authenticated = false;
    expect(source()).toBe(false);
    authenticated = true;
    invalidate(context, "device", "operator");
    expect(guard).toThrow("revoked");
    expect(source()).toBe(false);
    releaseQueue();
    expect(() => retain(guard)).toThrow("no longer active");
  });

  it("closes only its own Gateway and cannot create a live capture after shutdown", () => {
    const context = {};
    const otherContext = {};
    const request = capture(context, device, live);
    const other = capture(otherContext, device, live);
    const revoked = vi.fn();
    const unsubscribe = onRevoked(request.isCurrent, revoked);
    closeGateway(context);
    closeGateway(context);
    expect([request.isCurrent(), other.isCurrent()]).toEqual([false, true]);
    expect(revoked).not.toHaveBeenCalled();
    const late = capture(context, device, live);
    expectInactive(late.isCurrent);
    [request, late, other].forEach((entry) => entry.release());
    unsubscribe?.();
  });
});
