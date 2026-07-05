import { describe, expect, it, vi } from "vitest";
import {
  closeDevicePairSetup,
  refreshDevicePairSetup,
  type DevicePairSetup,
  type DevicePairSetupState,
} from "./device-pair-setup.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function setupResult(setupCode: string): DevicePairSetup {
  return {
    setupCode,
    gatewayUrl: "wss://gateway.example.com",
    auth: "token",
    urlSource: "test",
  };
}

function stateWithClient(client: DevicePairSetupState["client"]): DevicePairSetupState {
  return {
    client,
    connected: true,
    devicePairSetupOpen: true,
    devicePairSetupLoading: false,
    devicePairSetupError: null,
    devicePairSetup: null,
  };
}

describe("device pairing setup state", () => {
  it("ignores a setup response from a replaced Gateway client", async () => {
    const oldResponse = deferred<DevicePairSetup>();
    const newResponse = deferred<DevicePairSetup>();
    const oldClient = {
      request: vi.fn(() => oldResponse.promise),
    } as unknown as DevicePairSetupState["client"];
    const newClient = {
      request: vi.fn(() => newResponse.promise),
    } as unknown as DevicePairSetupState["client"];
    const state = stateWithClient(oldClient);

    const oldRequest = refreshDevicePairSetup(state);
    closeDevicePairSetup(state);
    state.client = newClient;
    state.connected = true;
    state.devicePairSetupOpen = true;
    const newRequest = refreshDevicePairSetup(state);

    oldResponse.resolve(setupResult("OLD"));
    await oldRequest;
    expect(state.devicePairSetup).toBeNull();
    expect(state.devicePairSetupLoading).toBe(true);

    newResponse.resolve(setupResult("NEW"));
    await newRequest;
    expect(state.devicePairSetup?.setupCode).toBe("NEW");
    expect(state.devicePairSetupLoading).toBe(false);
  });

  it("ignores an older request after closing and reopening on the same client", async () => {
    const oldResponse = deferred<DevicePairSetup>();
    const newResponse = deferred<DevicePairSetup>();
    const client = {
      request: vi
        .fn()
        .mockReturnValueOnce(oldResponse.promise)
        .mockReturnValueOnce(newResponse.promise),
    } as unknown as DevicePairSetupState["client"];
    const state = stateWithClient(client);

    const oldRequest = refreshDevicePairSetup(state);
    closeDevicePairSetup(state);
    state.devicePairSetupOpen = true;
    const newRequest = refreshDevicePairSetup(state);

    oldResponse.resolve(setupResult("OLD"));
    await oldRequest;
    expect(state.devicePairSetup).toBeNull();
    expect(state.devicePairSetupLoading).toBe(true);

    newResponse.resolve(setupResult("NEW"));
    await newRequest;
    expect(state.devicePairSetup?.setupCode).toBe("NEW");
  });

  it("clears setup credentials and loading state when the dialog closes", () => {
    const state = stateWithClient(null);
    state.devicePairSetupLoading = true;
    state.devicePairSetupError = "failed";
    state.devicePairSetup = setupResult("SECRET");

    closeDevicePairSetup(state);

    expect(state.devicePairSetupOpen).toBe(false);
    expect(state.devicePairSetupLoading).toBe(false);
    expect(state.devicePairSetupError).toBeNull();
    expect(state.devicePairSetup).toBeNull();
  });
});
