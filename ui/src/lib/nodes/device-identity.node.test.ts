import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createStorageMock } from "../../test-helpers/storage.ts";

beforeEach(() => {
  let pending = Promise.resolve();
  vi.stubGlobal("localStorage", createStorageMock());
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("navigator", {
    locks: {
      request: (_name: string, run: () => Promise<unknown>) => {
        const next = pending.then(run);
        pending = next.then(
          () => undefined,
          () => undefined,
        );
        return next;
      },
    },
  });
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

it("shares the first browser identity across simultaneous fresh documents", async () => {
  const firstDocument = await import("./index.ts");
  vi.resetModules();
  const secondDocument = await import("./index.ts");
  const [first, second] = await Promise.all([
    firstDocument.loadOrCreateDeviceIdentity(),
    secondDocument.loadOrCreateDeviceIdentity(),
  ]);

  expect(second).toEqual(first);
  expect(JSON.parse(localStorage.getItem("openclaw-device-identity-v1")!)).toMatchObject(first);
});

it("keeps one page identity for overlapping connects without browser storage", async () => {
  vi.stubGlobal("localStorage", undefined);
  const document = await import("./index.ts");
  const [first, second] = await Promise.all([
    document.loadOrCreateDeviceIdentity(),
    document.loadOrCreateDeviceIdentity(),
  ]);

  expect(second).toEqual(first);
  expect(document.peekStoredDeviceIdentityId()).toBe(first.deviceId);
});

it.each(["access", "request"])("retains page identity when lock %s is denied", async (denial) => {
  const error = new DOMException("Storage access denied", "SecurityError");
  vi.stubGlobal(
    "navigator",
    denial === "access"
      ? Object.defineProperty({}, "locks", {
          get() {
            throw error;
          },
        })
      : { locks: { request: () => Promise.reject(error) } },
  );
  vi.stubGlobal("localStorage", undefined);
  const document = await import("./index.ts");

  const first = await document.loadOrCreateDeviceIdentity();
  expect(first.deviceId).toMatch(/^[0-9a-f]{64}$/);
  expect(await document.loadOrCreateDeviceIdentity()).toEqual(first);
});

it("does not retry identity generation after the lock was acquired", async () => {
  const error = new Error("RNG unavailable");
  const getRandomValues = vi.fn(() => {
    throw error;
  });
  vi.stubGlobal("crypto", { getRandomValues });
  const document = await import("./index.ts");

  await expect(document.loadOrCreateDeviceIdentity()).rejects.toBe(error);
  expect(getRandomValues).toHaveBeenCalledOnce();
});
