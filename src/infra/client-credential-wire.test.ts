import fs from "node:fs";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  runClientCredentialOperation,
  type ClientCredentialOperation,
  type ClientCredentialResult,
} from "./client-credential-store.js";
import { normalizeLegacyDeviceIdentity } from "./device-identity-legacy.js";

const directories = useAutoCleanupTempDirTracker(afterEach);

it("replays the shared Swift wire fixture through actual typed owner operations", () => {
  const env = { OPENCLAW_STATE_DIR: directories.make("credential-wire-") };
  const material = normalizeLegacyDeviceIdentity({
    deviceId: "56475aa75463474c0285df5dbf2bcab73da651358839e9b77481b2eab107708c",
    publicKey: "A6EHv/POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg=",
    privateKey: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=", // pragma: allowlist secret
    createdAtMs: 123,
  });
  if (!material) {
    throw new Error("Invalid fixed Ed25519 fixture");
  }
  // Both runtimes execute the same input trace against its independent golden results.
  // Only the synthetic private-key placeholder is hydrated; no fixture is rewritten.
  const fixture: {
    format: number;
    cases: { name: string; operation: ClientCredentialOperation; result: ClientCredentialResult }[];
  } = JSON.parse(
    fs
      .readFileSync(
        new URL(
          "../../apps/shared/OpenClawKit/Tests/OpenClawNativeStateTests/Fixtures/ClientCredentials/operations.json",
          import.meta.url,
        ),
        "utf8",
      )
      .replaceAll(
        JSON.stringify("synthetic:ed25519-seed-0-through-31"),
        JSON.stringify(material.privateKeyPem),
      ),
  );
  expect(fixture.format).toBe(1);
  expect(fixture.cases).not.toHaveLength(0);
  for (const { name, operation, result } of fixture.cases) {
    expect(runClientCredentialOperation(env, operation), name).toEqual(result);
  }
});
