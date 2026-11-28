import { expect, it, vi } from "vitest";
import { loadGatewayReaderIdentityV1 } from "./gateway-runtime.js";

const read = vi.hoisted(() => vi.fn());
// mock-isolation: test existing-only selection without touching credential storage.
vi.mock("../infra/device-identity-async.js", () => ({ loadDeviceIdentityIfPresentAsync: read }));

it("reads only the explicit named identity and never falls back to primary", async () => {
  const identity = { deviceId: "reader", publicKeyPem: "public", privateKeyPem: "private" };
  read.mockResolvedValueOnce(identity).mockResolvedValue(null);
  await expect(loadGatewayReaderIdentityV1("session-share:team")).resolves.toBe(identity);
  expect(read).toHaveBeenCalledExactlyOnceWith({ identityKey: "session-share:team" });
  await expect(loadGatewayReaderIdentityV1("missing")).rejects.toThrow("not provisioned");
  for (const key of ["", "primary", " primary", "primary "]) {
    await expect(loadGatewayReaderIdentityV1(key)).rejects.toThrow("non-primary");
  }
  expect(read).toHaveBeenCalledTimes(2);
});
