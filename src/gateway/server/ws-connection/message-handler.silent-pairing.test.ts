import { describe, expect, test } from "vitest";
import { shouldAllowSilentLocalPairing } from "./message-handler.js";

const base = {
  isLocalClient: true,
  hasBrowserOriginHeader: false,
  isControlUi: false,
  isWebchat: false,
} as const;

describe("shouldAllowSilentLocalPairing", () => {
  test("allows not-paired for local client", () => {
    expect(shouldAllowSilentLocalPairing({ ...base, reason: "not-paired" })).toBe(true);
  });

  test("allows scope-upgrade for local client", () => {
    expect(shouldAllowSilentLocalPairing({ ...base, reason: "scope-upgrade" })).toBe(true);
  });

  test("allows role-upgrade for local client", () => {
    expect(shouldAllowSilentLocalPairing({ ...base, reason: "role-upgrade" })).toBe(true);
  });

  test("rejects metadata-upgrade for local client", () => {
    expect(shouldAllowSilentLocalPairing({ ...base, reason: "metadata-upgrade" })).toBe(false);
  });

  test("rejects all reasons for non-local client", () => {
    const remote = { ...base, isLocalClient: false };
    expect(shouldAllowSilentLocalPairing({ ...remote, reason: "not-paired" })).toBe(false);
    expect(shouldAllowSilentLocalPairing({ ...remote, reason: "scope-upgrade" })).toBe(false);
    expect(shouldAllowSilentLocalPairing({ ...remote, reason: "role-upgrade" })).toBe(false);
    expect(shouldAllowSilentLocalPairing({ ...remote, reason: "metadata-upgrade" })).toBe(false);
  });

  test("rejects non-control-ui browser origin even for local client", () => {
    const browser = { ...base, hasBrowserOriginHeader: true };
    expect(shouldAllowSilentLocalPairing({ ...browser, reason: "not-paired" })).toBe(false);
    expect(shouldAllowSilentLocalPairing({ ...browser, reason: "role-upgrade" })).toBe(false);
  });

  test("allows control-ui browser origin for local client", () => {
    const controlUi = { ...base, hasBrowserOriginHeader: true, isControlUi: true };
    expect(shouldAllowSilentLocalPairing({ ...controlUi, reason: "not-paired" })).toBe(true);
    expect(shouldAllowSilentLocalPairing({ ...controlUi, reason: "role-upgrade" })).toBe(true);
  });

  test("allows webchat browser origin for local client", () => {
    const webchat = { ...base, hasBrowserOriginHeader: true, isWebchat: true };
    expect(shouldAllowSilentLocalPairing({ ...webchat, reason: "not-paired" })).toBe(true);
    expect(shouldAllowSilentLocalPairing({ ...webchat, reason: "role-upgrade" })).toBe(true);
  });
});
