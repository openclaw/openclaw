import { afterEach, expect, it, vi } from "vitest";
const boundary = vi.hoisted(() => ({
  current: true,
  revokeOn: "",
  request: vi.fn(),
  capture: vi.fn(() => {
    throw new Error("unexpected offline access");
  }),
}));
// mock-isolation: Fixed app I/O and import-time revocation expose the live authority boundary.
vi.mock("./client-credential-ipc.js", () => {
  if (boundary.revokeOn === "app") {
    boundary.current = false;
  }
  return { requestClientCredentialsFromApp: boundary.request };
});
// mock-isolation: Revoke at module evaluation without acquiring a real state database.
vi.mock("./gateway-state-owner.js", () => {
  if (boundary.revokeOn === "offline") {
    boundary.current = false;
  }
  return { captureStateDatabaseAccess: boundary.capture, acquireStateDatabaseSchemaLease: vi.fn() };
});
afterEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  boundary.current = true;
  boundary.revokeOn = "";
});
const env = { OPENCLAW_STATE_DIR: "/synthetic/credential-lazy-authority" };
const operation = { kind: "identity.read", identity_key: "primary" } as const;
const assertCurrent = () => {
  if (!boundary.current) {
    throw new Error("revoked credential request");
  }
};

it.each(["app", "offline"])(
  "rechecks live authority after loading the %s runtime",
  async (phase) => {
    const { runClientCredentialOperationAsync } = await import("./client-credential-async.js");
    boundary.revokeOn = phase;
    boundary.request.mockResolvedValue(undefined);
    await expect(
      runClientCredentialOperationAsync(env, operation, { assertCurrent }),
    ).rejects.toThrow("revoked credential request");
    expect(boundary.capture).not.toHaveBeenCalled();
    expect(boundary.request).toHaveBeenCalledTimes(phase === "app" ? 0 : 1);
  },
);

it("returns app results and never turns an uncertain dispatch into offline work", async () => {
  const { runClientCredentialOperationAsync } = await import("./client-credential-async.js");
  const result = { kind: "identity", identity: null };
  boundary.request.mockResolvedValueOnce(result).mockRejectedValueOnce(new Error("app reply lost"));
  await expect(
    runClientCredentialOperationAsync(env, operation, { assertCurrent }),
  ).resolves.toEqual(result);
  await expect(
    runClientCredentialOperationAsync(env, operation, { assertCurrent }),
  ).rejects.toThrow("app reply lost");
  expect(boundary.capture).not.toHaveBeenCalled();
});
