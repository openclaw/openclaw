// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayRequestError } from "../api/gateway-connect-errors.ts";
import {
  closeDevicePairSetup,
  createDevicePairSetupState,
  openDevicePairSetup,
  refreshDevicePairSetup,
  setDevicePairSetupAccess,
} from "./device-pair-setup.ts";

function fixture() {
  const request = vi.fn().mockResolvedValue({
    setupId: "synthetic-setup",
    setupCode: "synthetic-not-a-credential",
    expiresAtMs: Date.now() + 60_000,
  });
  let allowed = true;
  const state = createDevicePairSetupState({
    client: { request },
    connected: true,
    canAssociatePerson: () => allowed,
  });
  state.devicePairSetupOpen = true;
  return {
    state,
    request,
    revoke: () => {
      allowed = false;
    },
  };
}
afterEach(() => vi.useRealTimers());
describe("personal setup issuance", () => {
  it("keeps an email-less enrollment ID and original name across uncertain issuance and dismissal", async () => {
    const { state, request } = fixture();
    request.mockRejectedValueOnce(new Error("connection lost"));
    await refreshDevicePairSetup(state, { name: "  Synthetic Person  " });
    const original = request.mock.calls[0]?.[1];
    expect(original).toEqual({
      enrollmentId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      name: "Synthetic Person",
    });
    expect(state.devicePairSetupLifecycle).toMatchObject({
      phase: "error",
      source: "create",
      uncertain: true,
    });
    await setDevicePairSetupAccess(state, "node");
    closeDevicePairSetup(state);
    await openDevicePairSetup(state);
    expect(request).toHaveBeenCalledTimes(1);
    await refreshDevicePairSetup(state, { name: "Changed draft" });
    expect(request.mock.calls[1]?.[1]).toEqual(original);
    closeDevicePairSetup(state);
  });
  it("retains an in-flight enrollment on dismissal without exposing a late bearer", async () => {
    const { state, request } = fixture();
    let settle!: (value: unknown) => void;
    request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
    );
    const operation = refreshDevicePairSetup(state, { name: "Synthetic Person" });
    const original = request.mock.calls[0]?.[1];
    closeDevicePairSetup(state);
    settle({ setupId: "late", setupCode: "never-render", expiresAtMs: Date.now() + 60_000 });
    await operation;
    expect(state.devicePairSetupLifecycle).toMatchObject({ phase: "error", uncertain: true });
    await openDevicePairSetup(state);
    await refreshDevicePairSetup(state);
    expect(request.mock.calls[1]?.[1]).toEqual(original);
    closeDevicePairSetup(state);
  });
  it("omits the optional name when setting up an unnamed local person", async () => {
    const { state, request } = fixture();
    await refreshDevicePairSetup(state, { name: "   " });
    expect(request.mock.calls[0]?.[1]).toEqual({
      enrollmentId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    closeDevicePairSetup(state);
  });
  it("does not associate a node or a service join with a person", async () => {
    const { state, request } = fixture();
    await setDevicePairSetupAccess(state, "node");
    await refreshDevicePairSetup(state, { profileId: "person-existing" });
    expect(request).not.toHaveBeenCalled();
    await refreshDevicePairSetup(state);
    expect(request.mock.calls[0]?.[1]).toEqual({ bootstrapProfile: "node", includeQr: false });
    closeDevicePairSetup(state);
  });
  it("checks current admin authority before issuance and after awaited work", async () => {
    const { state, request, revoke } = fixture();
    let settle!: (value: unknown) => void;
    request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
    );
    const operation = refreshDevicePairSetup(state, { profileId: "person-existing" });
    revoke();
    settle({ setupId: "retired", setupCode: "never-render", expiresAtMs: Date.now() + 60_000 });
    await operation;
    expect(state.devicePairSetupLifecycle.phase).not.toBe("waiting");
    closeDevicePairSetup(state, true);
    await openDevicePairSetup(state);
    await refreshDevicePairSetup(state, { name: "Synthetic Person" });
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("does not call a definitive denial uncertain or carry a choice into a replacement source", async () => {
    const { state, request } = fixture();
    request.mockRejectedValueOnce(
      new GatewayRequestError({ code: "FORBIDDEN", message: "Admin required" }),
    );
    await refreshDevicePairSetup(state, { name: "Synthetic Person" });
    expect(state.devicePairSetupLifecycle).not.toHaveProperty("uncertain");
    const replacement = vi.fn().mockResolvedValue({
      setupId: "replacement",
      setupCode: "synthetic",
      expiresAtMs: Date.now() + 60_000,
    });
    state.client = { request: replacement };
    closeDevicePairSetup(state, true);
    await openDevicePairSetup(state);
    await refreshDevicePairSetup(state);
    expect(replacement.mock.calls[0]?.[1]).toEqual({});
    closeDevicePairSetup(state);
  });
});
