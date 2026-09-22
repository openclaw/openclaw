import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import {
  bindGatewayDeviceRevocation,
  captureGatewayDeviceRevocation,
  closeGatewayDeviceRevocation,
  invalidateGatewayDeviceRevocation,
  onGatewayDeviceSourceRevoked,
  retainGatewayDeviceRevocation,
  readGatewayDeviceSourceAuthority,
} from "./device-revocation.js";

describe("Gateway device revocation", () => {
  it("reaches the original admitted caller after the request releases its hold", () => {
    const context = {};
    const identity = { deviceId: "device", role: "operator" };
    const request = captureGatewayDeviceRevocation(context, identity, () => true);
    const releaseRun = expectDefined(
      retainGatewayDeviceRevocation(request.isCurrent),
      "original run hold",
    );
    request.release();
    expect(request.isCurrent()).toBe(true);

    invalidateGatewayDeviceRevocation(context, identity.deviceId, identity.role);
    expect(request.isCurrent()).toBe(false);
    expect(() => retainGatewayDeviceRevocation(request.isCurrent)).toThrow("no longer active");

    const replacement = captureGatewayDeviceRevocation(context, identity, () => true);
    expect(replacement.isCurrent()).toBe(true);
    releaseRun();
    releaseRun();
    expect(request.isCurrent()).toBe(false);
    expect(replacement.isCurrent()).toBe(true);
    replacement.release();
  });

  it("retains one source until its last independent holder releases it", () => {
    const context = {};
    const releaseSource = vi.fn();
    const request = captureGatewayDeviceRevocation(
      context,
      { deviceId: "device", role: "operator" },
      () => true,
      undefined,
      { isCurrent: () => true, subscribe: () => releaseSource },
    );
    const revoked = vi.fn();
    const unsubscribe = onGatewayDeviceSourceRevoked(request.isCurrent, revoked);
    const releaseRun = expectDefined(
      retainGatewayDeviceRevocation(request.isCurrent),
      "original run hold",
    );
    const releaseQueuedTurn = expectDefined(
      retainGatewayDeviceRevocation(request.isCurrent),
      "queued turn hold",
    );
    request.release();
    releaseRun();
    expect(releaseSource).not.toHaveBeenCalled();
    expect(revoked).not.toHaveBeenCalled();
    invalidateGatewayDeviceRevocation(context, "device", "operator");
    expect(revoked).toHaveBeenCalledOnce();
    expect(request.isCurrent()).toBe(false);
    releaseQueuedTurn();
    releaseQueuedTurn();
    expect(releaseSource).toHaveBeenCalledOnce();
    unsubscribe?.();
  });

  it("preserves exact device and optional role matching", () => {
    const context = {};
    const operator = captureGatewayDeviceRevocation(
      context,
      { deviceId: "device", role: "operator" },
      () => true,
    );
    const node = captureGatewayDeviceRevocation(
      context,
      { deviceId: "device", role: "node" },
      () => true,
    );
    const otherDevice = captureGatewayDeviceRevocation(
      context,
      { deviceId: "other", role: "operator" },
      () => true,
    );
    invalidateGatewayDeviceRevocation(context, "device", "operator");
    expect(operator.isCurrent()).toBe(false);
    expect(node.isCurrent()).toBe(true);
    expect(otherDevice.isCurrent()).toBe(true);
    invalidateGatewayDeviceRevocation(context, "device");
    expect(node.isCurrent()).toBe(false);
    expect(otherDevice.isCurrent()).toBe(true);
    operator.release();
    node.release();
    otherDevice.release();
  });

  it("cannot use or retain a released source without an owning connection", () => {
    const request = captureGatewayDeviceRevocation(
      {},
      { deviceId: "device", role: "operator" },
      () => true,
    );
    request.release();
    request.release();
    expect(request.isCurrent()).toBe(false);
    expect(() => retainGatewayDeviceRevocation(request.isCurrent)).toThrow("no longer active");
  });

  it("preserves connection-owned callbacks until the original transport retires", () => {
    const connection = new AbortController();
    let clientInvalidated = false;
    const request = captureGatewayDeviceRevocation(
      {},
      { deviceId: "device", role: "operator" },
      () => !clientInvalidated,
      connection.signal,
    );
    const revoked = vi.fn();
    const unsubscribe = onGatewayDeviceSourceRevoked(request.isCurrent, revoked);
    request.release();
    expect(request.isCurrent()).toBe(true);
    expect(() => retainGatewayDeviceRevocation(request.isCurrent)).toThrow("no longer active");
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
    const request = captureGatewayDeviceRevocation(
      context,
      { deviceId: "device", role: "operator" },
      () => authenticated,
    );
    const guard = bindGatewayDeviceRevocation(() => {
      if (!requestCurrent || !request.isCurrent()) {
        throw new Error("revoked");
      }
    }, request.isCurrent);
    const releaseQueue = expectDefined(retainGatewayDeviceRevocation(guard), "queue hold");
    const source = expectDefined(readGatewayDeviceSourceAuthority(guard), "original auth guard");
    request.release();
    expect(guard).not.toThrow();
    requestCurrent = false;
    expect(guard).toThrow("revoked");
    expect(source()).toBe(true);
    authenticated = false;
    expect(source()).toBe(false);
    authenticated = true;
    invalidateGatewayDeviceRevocation(context, "device", "operator");
    expect(guard).toThrow("revoked");
    expect(source()).toBe(false);
    releaseQueue();
    expect(() => retainGatewayDeviceRevocation(guard)).toThrow("no longer active");
  });

  it("preserves existing caller checks for requests without a device", () => {
    const context = {};
    let current = true;
    const request = captureGatewayDeviceRevocation(context, {}, () => current);
    expect(request.isCurrent()).toBe(true);
    current = false;
    expect(request.isCurrent()).toBe(false);
    expect(() => retainGatewayDeviceRevocation(request.isCurrent)).toThrow("no longer active");
    request.release();
    expect(retainGatewayDeviceRevocation(undefined)).toBeUndefined();
    expect(retainGatewayDeviceRevocation(() => true)).toBeUndefined();
  });

  it("closes only its own Gateway and cannot create a live capture after shutdown", () => {
    const context = {};
    const otherContext = {};
    const identity = { deviceId: "device", role: "operator" };
    const request = captureGatewayDeviceRevocation(context, identity, () => true);
    const other = captureGatewayDeviceRevocation(otherContext, identity, () => true);
    const revoked = vi.fn();
    const unsubscribe = onGatewayDeviceSourceRevoked(request.isCurrent, revoked);
    closeGatewayDeviceRevocation(context);
    closeGatewayDeviceRevocation(context);
    expect(request.isCurrent()).toBe(false);
    expect(other.isCurrent()).toBe(true);
    expect(revoked).not.toHaveBeenCalled();
    const late = captureGatewayDeviceRevocation(context, identity, () => true);
    expect(late.isCurrent()).toBe(false);
    expect(() => retainGatewayDeviceRevocation(late.isCurrent)).toThrow("no longer active");
    request.release();
    late.release();
    other.release();
    unsubscribe?.();
  });
});
