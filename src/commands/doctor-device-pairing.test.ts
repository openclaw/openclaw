import fs from "node:fs/promises";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { clearDeviceAuthToken, loadDeviceAuthToken } from "../infra/device-auth-store.js";
import {
  seedDeviceAuthToken,
  readDeviceAuthTokenForTest,
} from "../infra/device-auth-store.test-support.js";
import {
  loadOrCreateDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
} from "../infra/device-identity.js";
import { approveDevicePairing } from "../infra/device-pairing-approval.js";
import { revokeDeviceToken, rotateDeviceToken } from "../infra/device-pairing-tokens.js";
import type { DeviceAuthTokenSummary } from "../infra/device-pairing-tokens.js";
import {
  requestDevicePairing,
  type DevicePairingPendingRequest,
  type PairedDevice,
} from "../infra/device-pairing.js";
import {
  detectLegacyDeviceAuth,
  migrateLegacyDeviceAuth,
} from "../infra/state-migrations.device-auth.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { withTempDir } from "../test-utils/temp-dir.js";

const callGatewayMock = vi.hoisted(() => vi.fn());

// mock-isolation: exercise pairing diagnostics without opening Gateway connections.
vi.mock("../gateway/call.js", () => ({
  callGateway: (...args: unknown[]) => callGatewayMock(...args),
}));

const legacyDeviceAuthContents = JSON.stringify({
  version: 1,
  deviceId: "synthetic-device",
  tokens: {
    operator: {
      token: "synthetic-legacy-token",
      role: "operator",
      scopes: ["operator.read"],
      updatedAtMs: 10,
    },
  },
});

function pendingDevice(overrides: Partial<DevicePairingPendingRequest> = {}) {
  return {
    requestId: "req-gateway-1",
    deviceId: "device-gateway-1",
    publicKey: "pubkey",
    role: "operator",
    roles: ["operator"],
    scopes: ["operator.admin"],
    clientId: "control-ui",
    clientMode: "webchat",
    displayName: "Dashboard",
    ts: 1,
    isRepair: false,
    ...overrides,
  };
}

type GatewayPairedDevice = Omit<PairedDevice, "tokens"> & { tokens: DeviceAuthTokenSummary[] };
function pairedDevice(overrides: Partial<GatewayPairedDevice> = {}) {
  return {
    deviceId: "paired-device",
    publicKey: "paired-public-key",
    roles: ["operator"],
    scopes: ["operator.read"],
    tokens: [],
    createdAtMs: 1,
    approvedAtMs: 1,
    ...overrides,
  };
}

describe("collectDevicePairingHealthFindings", () => {
  let collectDevicePairingHealthFindings: typeof import("./doctor-device-pairing.js").collectDevicePairingHealthFindings;
  const collect = (mode: "local" | "remote", healthOk = false) =>
    collectDevicePairingHealthFindings({ cfg: { gateway: { mode } }, healthOk });
  const withState = (run: Parameters<typeof withOpenClawTestState>[1]) =>
    withOpenClawTestState(
      { prefix: "openclaw-doctor-device-pairing-", env: { OPENCLAW_TEST_FAST: "1" } },
      run,
    );

  async function withApprovedOperatorPairing(
    run: (context: {
      identity: ReturnType<typeof loadOrCreateDeviceIdentity>;
      publicKey: string;
    }) => Promise<void>,
  ): Promise<void> {
    await withTempDir("openclaw-doctor-device-pairing-", async (stateDir) => {
      await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir, OPENCLAW_TEST_FAST: "1" }, async () => {
        const identity = loadOrCreateDeviceIdentity();
        const publicKey = publicKeyRawBase64UrlFromPem(identity.publicKeyPem);
        const initial = await requestDevicePairing({
          deviceId: identity.deviceId,
          publicKey,
          role: "operator",
          scopes: ["operator.read"],
          clientId: "control-ui",
          clientMode: "webchat",
          displayName: "Dashboard",
        });
        await approveDevicePairing(initial.request.requestId, { callerScopes: ["operator.read"] });
        try {
          await run({ identity, publicKey });
        } finally {
          await closeOpenClawStateDatabaseByPathAsync(
            path.join(stateDir, "state", "openclaw.sqlite"),
          );
        }
      });
    });
  }

  beforeAll(async () => {
    vi.resetModules();
    ({ collectDevicePairingHealthFindings } = await import("./doctor-device-pairing.js"));
  });

  beforeEach(() => {
    callGatewayMock.mockReset();
  });

  it("warns about pending scope upgrades from local pairing state when the gateway is down", async () => {
    await withApprovedOperatorPairing(async ({ identity, publicKey }) => {
      const pending = await requestDevicePairing({
        deviceId: identity.deviceId,
        publicKey,
        role: "operator",
        scopes: ["operator.admin"],
      });

      const findings = await collect("local");
      expect(findings).toEqual([
        expect.objectContaining({
          severity: "warning",
          path: "devices.pending",
          target: identity.deviceId + ":" + pending.request.requestId,
          category: "recommended",
          requirement: "scope-upgrade",
          message: expect.stringContaining("Pending scope upgrade"),
          fixHint: expect.stringContaining("openclaw devices approve"),
        }),
      ]);
      expect(findings[0]?.message).toContain("operator.admin");
      expect(callGatewayMock).not.toHaveBeenCalled();
    });
  });

  it.each([
    {
      file: "nodes/paired.json",
      mode: "local",
      findingPath: "devices.legacy-store",
      requirement: "pairing-store-legacy-file",
    },
    {
      file: "identity/device-auth.json",
      mode: "remote",
      findingPath: "identity.device-auth",
      requirement: "device-auth-store-legacy-file",
    },
  ] as const)(
    "warns about unimported $file in $mode mode without changing it",
    async (testCase) => {
      await withState(async (state) => {
        const content =
          testCase.requirement === "pairing-store-legacy-file"
            ? "{not-json}"
            : legacyDeviceAuthContents;
        const sourcePath = await state.writeText(testCase.file, content);
        const findings = await collect(testCase.mode);
        expect.soft(findings).toEqual([
          expect.objectContaining({
            severity: "warning",
            path: testCase.findingPath,
            category: "fix-now",
            requirement: testCase.requirement,
            message: expect.stringContaining(
              testCase.requirement === "pairing-store-legacy-file"
                ? "has not been imported"
                : "is still present",
            ),
            fixHint: expect.stringContaining("openclaw doctor --fix"),
          }),
        ]);
        expect(findings[0]?.message).toContain(path.basename(sourcePath));
        expect(findings[0]?.message).not.toContain("synthetic-legacy-token");
        expect(await fs.readFile(sourcePath, "utf8")).toBe(content);
        await expect(fs.stat(state.statePath("state", "openclaw.sqlite"))).rejects.toMatchObject({
          code: "ENOENT",
        });
      });
    },
  );

  it("retains imported device-auth JSON without reimporting a removed token", async () => {
    await withState(async (state) => {
      const expectedToken = "synthetic-legacy-token";
      const sourcePath = await state.writeText(
        "identity/device-auth.json",
        legacyDeviceAuthContents,
      );
      const auth = { env: state.env, deviceId: "synthetic-device", role: "operator" };
      const readToken = () => readDeviceAuthTokenForTest(auth)?.token;
      const migrate = () =>
        migrateLegacyDeviceAuth({
          detected: detectLegacyDeviceAuth({
            stateDir: state.stateDir,
            doctorOnlyStateMigrations: true,
          }),
          stateDir: state.stateDir,
          env: state.env,
        });
      expect((await migrate()).warnings).toEqual([]);
      expect(readToken()).toBe(expectedToken);
      await expect(loadDeviceAuthToken(auth)).resolves.toMatchObject({ token: expectedToken });
      const findings = await collect("remote");
      expect(findings).toEqual([]);
      expect(await fs.readFile(sourcePath, "utf8")).toBe(legacyDeviceAuthContents);
      expect(readToken()).toBe(expectedToken);
      expect(await clearDeviceAuthToken(auth)).toBe(true);
      expect((await migrate()).changes).toEqual([]);
      expect(readToken()).toBeUndefined();
      expect(await fs.readFile(sourcePath, "utf8")).toBe(legacyDeviceAuthContents);
    });
  });

  it("warns when the local cached device token predates the gateway rotation", async () => {
    await withApprovedOperatorPairing(async ({ identity }) => {
      const now = vi.spyOn(Date, "now").mockReturnValue(1);
      try {
        seedDeviceAuthToken({
          deviceId: identity.deviceId,
          role: "operator",
          token: "stale-local-token",
          scopes: ["operator.read"],
        });
      } finally {
        now.mockRestore();
      }

      const rotated = await rotateDeviceToken({
        deviceId: identity.deviceId,
        role: "operator",
      });
      expect(rotated.ok).toBe(true);

      const findings = await collect("local");

      expect(findings).toHaveLength(1);
      const message = findings.map((finding) => finding.message).join("\n");
      expect(message).toContain("stale device-token pattern");
      expect(message).toContain("openclaw devices rotate");
    });
  });

  it("preserves pairing diagnostics when the token inventory read rejects", async () => {
    await withApprovedOperatorPairing(async () => {
      const inventory = vi
        .spyOn(await import("../infra/device-auth-store.js"), "loadDeviceAuthTokens")
        .mockRejectedValueOnce(new Error("synthetic inventory failure"));
      try {
        await expect(collect("local")).resolves.toEqual([]);
        expect(inventory).toHaveBeenCalledOnce();
      } finally {
        inventory.mockRestore();
      }
    });
  });

  it.each([
    { role: "node", tokenScopes: ["operator.read"], recoveryOption: " --no-scopes" },
    { role: "operator", tokenScopes: ["operator.admin"], recoveryOption: "" },
  ])(
    "recommends explicit scope recovery only for legacy node tokens: $role",
    async ({ role, tokenScopes, recoveryOption }) => {
      callGatewayMock.mockResolvedValue({
        pending: [],
        paired: [
          pairedDevice({ roles: [role], tokens: [{ role, scopes: tokenScopes, createdAtMs: 1 }] }),
        ],
      });

      const findings = await collect("remote", true);

      expect(findings).toContainEqual(
        expect.objectContaining({
          requirement: "token-outside-approved-scope",
          fixHint: `Rotate it with openclaw devices rotate --device paired-device --role ${role}${recoveryOption}.`,
        }),
      );
    },
  );

  it("does not suggest rotating local auth for a role that is no longer approved", async () => {
    await withApprovedOperatorPairing(async ({ identity }) => {
      seedDeviceAuthToken({
        deviceId: identity.deviceId,
        role: "node",
        token: "stale-node-token",
        scopes: [],
      });

      const findings = await collect("local");

      expect(findings).toHaveLength(1);
      const message = findings.map((finding) => finding.message).join("\n");
      expect(message).toContain("Local cached node device auth");
      expect(message).toContain("role is no longer approved");
      expect(message).toContain("remove the stale cached node auth entry");
      expect(message).not.toContain("--role node");
    });
  });

  it("sanitizes device labels in findings", async () => {
    callGatewayMock.mockResolvedValue({
      pending: [
        pendingDevice({
          clientId: "control-ui\tclient",
          displayName: "\u001b[2Kbad\nname",
        }),
      ],
      paired: [],
    });

    const findings = await collect("remote", true);

    const message = findings.map((finding) => finding.message).join("\n");
    expect(callGatewayMock).toHaveBeenCalledWith(
      expect.objectContaining({ method: "device.pair.list", sharedStateMode: "read-only" }),
    );
    expect(findings).toHaveLength(1);
    expect(message).toContain("req-gateway-1");
    expect(message).toContain("bad\\nname");
    expect(message).not.toContain("\u001b");
    expect(message).not.toContain("control-ui\tclient");
  });

  it("quotes untrusted device pairing fields in suggested commands", async () => {
    callGatewayMock.mockResolvedValue({
      pending: [
        pendingDevice({
          deviceId: "device; echo pwn",
          publicKey: "pending-pubkey",
          scopes: ["operator.read"],
          isRepair: true,
        }),
      ],
      paired: [
        pairedDevice({
          deviceId: "device; echo pwn",
          publicKey: "paired-pubkey",
          role: "operator; touch /tmp/pwn",
          roles: ["operator; touch /tmp/pwn"],
          scopes: [],
          approvedScopes: [],
        }),
      ],
    });

    const findings = await collect("remote", true);

    const message = findings.map((finding) => finding.message).join("\n");
    expect(message).toContain("openclaw devices remove 'device; echo pwn'");
    expect(message).toContain(
      "openclaw devices rotate --device 'device; echo pwn' --role 'operator; touch /tmp/pwn'",
    );
  });

  it("does not duplicate missing-token warnings when local cache exists for an approved role", async () => {
    await withApprovedOperatorPairing(async ({ identity }) => {
      seedDeviceAuthToken({
        deviceId: identity.deviceId,
        role: "operator",
        token: "stale-local-token",
        scopes: ["operator.read"],
      });
      await revokeDeviceToken({
        deviceId: identity.deviceId,
        role: "operator",
      });

      const findings = await collect("local");

      const message = findings.map((finding) => finding.message).join("\n");
      expect(message).toContain("has no active operator device token");
      expect(message).not.toContain("no longer has a matching active gateway token");
    });
  });
});
