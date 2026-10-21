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
import { requestDevicePairing } from "../infra/device-pairing.js";
import {
  detectLegacyDeviceAuth,
  migrateLegacyDeviceAuth,
} from "../infra/state-migrations.device-auth.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";

const callGatewayMock = vi.hoisted(() => vi.fn());
const noteMock = vi.hoisted(() => vi.fn());

// mock-isolation: exercise doctor response handling without opening network connections.
vi.mock("../gateway/call.js", () => ({ callGateway: callGatewayMock }));
// mock-isolation: capture user-facing notes without terminal output.
vi.mock("../../packages/terminal-core/src/note.js", () => ({ note: noteMock }));

function requireNoteMessage(): string {
  const message: unknown = noteMock.mock.calls[0]?.[0];
  if (typeof message !== "string") {
    throw new Error("expected doctor note message");
  }
  return message;
}

const localHealth = { cfg: { gateway: { mode: "local" as const } }, healthOk: false };
const remoteHealth = { cfg: { gateway: { mode: "remote" as const } }, healthOk: true };
const operatorToken = { role: "operator", token: "stale-local-token", scopes: ["operator.read"] };
const operatorRequest = {
  role: operatorToken.role,
  scopes: operatorToken.scopes,
  clientId: "control-ui",
  clientMode: "webchat",
  displayName: "Dashboard",
};
const pendingDevice = {
  ...operatorRequest,
  requestId: "req-gateway-1",
  deviceId: "device-gateway-1",
  publicKey: "pubkey",
  roles: ["operator"],
  ts: 1,
  isRepair: false,
};

const legacyDeviceAuthContents = JSON.stringify({
  version: 1,
  deviceId: "synthetic-device",
  tokens: {
    operator: {
      ...operatorToken,
      token: "synthetic-legacy-token",
      updatedAtMs: 10,
    },
  },
});

describe("noteDevicePairingHealth", () => {
  let collectDevicePairingHealthFindings: typeof import("./doctor-device-pairing.js").collectDevicePairingHealthFindings;
  let noteDevicePairingHealth: typeof import("./doctor-device-pairing.js").noteDevicePairingHealth;

  async function withApprovedOperatorPairing(
    run: (context: {
      identity: ReturnType<typeof loadOrCreateDeviceIdentity>;
      publicKey: string;
    }) => Promise<void>,
  ): Promise<void> {
    await withOpenClawTestState(
      { prefix: "openclaw-doctor-device-pairing-", env: { OPENCLAW_TEST_FAST: "1" } },
      async () => {
        const identity = loadOrCreateDeviceIdentity();
        const publicKey = publicKeyRawBase64UrlFromPem(identity.publicKeyPem);
        const initial = await requestDevicePairing({
          deviceId: identity.deviceId,
          publicKey,
          ...operatorRequest,
        });
        await approveDevicePairing(initial.request.requestId, { callerScopes: ["operator.read"] });
        await run({ identity, publicKey });
      },
    );
  }

  async function localNote(): Promise<string> {
    await noteDevicePairingHealth(localHealth);
    expect(noteMock).toHaveBeenCalledTimes(1);
    return requireNoteMessage();
  }

  beforeAll(async () => {
    vi.resetModules();
    ({ collectDevicePairingHealthFindings, noteDevicePairingHealth } =
      await import("./doctor-device-pairing.js"));
  });

  beforeEach(() => {
    callGatewayMock.mockReset();
    noteMock.mockReset();
  });

  it("warns about pending scope upgrades from local pairing state when the gateway is down", async () => {
    await withApprovedOperatorPairing(async ({ identity, publicKey }) => {
      const pending = await requestDevicePairing({
        deviceId: identity.deviceId,
        publicKey,
        ...operatorRequest,
        scopes: ["operator.admin"],
      });

      const message = await localNote();
      expect(noteMock.mock.calls[0]?.[1]).toBe("Device pairing");
      expect(message).toContain("Pending scope upgrade");
      expect(message).toContain("operator.admin");
      expect(message).toContain("openclaw devices approve");
      expect(callGatewayMock).not.toHaveBeenCalled();

      const findings = await collectDevicePairingHealthFindings(localHealth);
      expect(findings).toMatchObject([
        {
          checkId: "core/doctor/device-pairing",
          severity: "warning",
          path: "devices.pending",
          target: identity.deviceId + ":" + pending.request.requestId,
          requirement: "scope-upgrade",
          message: expect.stringContaining("Pending scope upgrade"),
          fixHint: expect.stringContaining("openclaw devices approve"),
        },
      ]);
      expect(callGatewayMock).not.toHaveBeenCalled();
    });
  });

  it.each([
    ["nodes/paired.json", "local", "devices.legacy-store", "pairing-store-legacy-file"],
    [
      "identity/device-auth.json",
      "remote",
      "identity.device-auth",
      "device-auth-store-legacy-file",
    ],
  ] as const)(
    "warns about unimported %s in %s mode without changing it",
    async (file, mode, findingPath, requirement) => {
      await withOpenClawTestState(
        { prefix: "openclaw-doctor-device-pairing-", env: { OPENCLAW_TEST_FAST: "1" } },
        async (state) => {
          const content =
            requirement === "pairing-store-legacy-file" ? "{not-json}" : legacyDeviceAuthContents;
          const sourcePath = await state.writeText(file, content);
          const params = { cfg: { gateway: { mode } }, healthOk: false };

          const findings = await collectDevicePairingHealthFindings(params);
          expect.soft(findings).toMatchObject([
            {
              checkId: "core/doctor/device-pairing",
              severity: "warning",
              path: findingPath,
              requirement,
              message: expect.stringContaining(
                requirement === "pairing-store-legacy-file"
                  ? "has not been imported"
                  : "is still present",
              ),
              fixHint: expect.stringContaining("openclaw doctor --fix"),
            },
          ]);
          await noteDevicePairingHealth(params);
          expect.soft(noteMock).toHaveBeenCalledTimes(1);
          expect(noteMock).toHaveBeenCalledWith(
            expect.stringContaining(path.basename(sourcePath)),
            "Device pairing",
          );
          expect(requireNoteMessage()).not.toContain("synthetic-legacy-token");
          expect(await fs.readFile(sourcePath, "utf8")).toBe(content);
          await expect(fs.stat(state.statePath("state", "openclaw.sqlite"))).rejects.toMatchObject({
            code: "ENOENT",
          });
        },
      );
    },
  );

  it("retains imported device-auth JSON without reimporting a removed token", async () => {
    await withOpenClawTestState(
      { prefix: "openclaw-doctor-device-auth-debt-", env: { OPENCLAW_TEST_FAST: "1" } },
      async (state) => {
        const expectedToken = "synthetic-legacy-token";
        const sourcePath = await state.writeText(
          "identity/device-auth.json",
          legacyDeviceAuthContents,
        );
        const readTokenRow = () => {
          const entry = readDeviceAuthTokenForTest({
            env: state.env,
            deviceId: "synthetic-device",
            role: "operator",
          });
          return entry ? { token: entry.token } : undefined;
        };
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
        expect(readTokenRow()).toEqual({ token: expectedToken });
        await expect(
          loadDeviceAuthToken({ deviceId: "synthetic-device", role: "operator", env: state.env }),
        ).resolves.toMatchObject({ token: expectedToken });
        const params = { cfg: { gateway: { mode: "remote" as const } }, healthOk: false };
        const findings = await collectDevicePairingHealthFindings(params);
        expect(findings).toEqual([]);
        await noteDevicePairingHealth(params);
        expect(noteMock).not.toHaveBeenCalled();
        expect(await fs.readFile(sourcePath, "utf8")).toBe(legacyDeviceAuthContents);
        expect(readTokenRow()).toEqual({ token: expectedToken });
        expect(
          await clearDeviceAuthToken({
            deviceId: "synthetic-device",
            role: "operator",
            env: state.env,
          }),
        ).toBe(true);
        expect((await migrate()).changes).toEqual([]);
        expect(readTokenRow()).toBeUndefined();
        expect(await fs.readFile(sourcePath, "utf8")).toBe(legacyDeviceAuthContents);
      },
    );
  });

  it.each(["rotated token", "unapproved role", "revoked token"] as const)(
    "diagnoses local auth with a %s without misleading recovery advice",
    async (scenario) => {
      await withApprovedOperatorPairing(async ({ identity: { deviceId } }) => {
        seedDeviceAuthToken(
          scenario === "unapproved role"
            ? { deviceId, role: "node", token: "stale-node-token", scopes: [] }
            : {
                deviceId,
                ...operatorToken,
                ...(scenario === "rotated token" ? { updatedAtMs: 1 } : {}),
              },
        );
        if (scenario === "rotated token") {
          expect((await rotateDeviceToken({ deviceId, role: "operator" })).ok).toBe(true);
        } else if (scenario === "revoked token") {
          await revokeDeviceToken({ deviceId, role: "operator" });
        }
        const message = await localNote();
        if (scenario === "rotated token") {
          expect(message).toContain("stale device-token pattern");
          expect(message).toContain("openclaw devices rotate");
        } else if (scenario === "unapproved role") {
          expect(message).toContain("Local cached node device auth");
          expect(message).toContain("role is no longer approved");
          expect(message).toContain("remove the stale cached node auth entry");
          expect(message).not.toContain("--role node");
        } else {
          expect(message).toContain("has no active operator device token");
          expect(message).not.toContain("no longer has a matching active gateway token");
        }
      });
    },
  );

  it("preserves pairing diagnostics when the token inventory read rejects", async () => {
    await withApprovedOperatorPairing(async () => {
      const inventory = vi
        .spyOn(await import("../infra/device-auth-store.js"), "loadDeviceAuthTokens")
        .mockRejectedValueOnce(new Error("synthetic inventory failure"));
      try {
        await expect(collectDevicePairingHealthFindings(localHealth)).resolves.toEqual([]);
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
          {
            deviceId: "paired-device",
            publicKey: "paired-public-key",
            roles: [role],
            scopes: ["operator.read"],
            tokens: [{ role, scopes: tokenScopes, createdAtMs: 1 }],
            createdAtMs: 1,
            approvedAtMs: 1,
          },
        ],
      });

      const findings = await collectDevicePairingHealthFindings(remoteHealth);

      expect(findings).toContainEqual(
        expect.objectContaining({
          requirement: "token-outside-approved-scope",
          fixHint: `Rotate it with openclaw devices rotate --device paired-device --role ${role}${recoveryOption}.`,
        }),
      );
    },
  );

  it("sanitizes device labels before printing doctor notes", async () => {
    callGatewayMock.mockResolvedValue({
      pending: [
        {
          ...pendingDevice,
          scopes: ["operator.admin"],
          clientId: "control-ui\tclient",
          displayName: "\u001b[2Kbad\nname",
        },
      ],
      paired: [],
    });

    await noteDevicePairingHealth(remoteHealth);

    const message = requireNoteMessage();
    expect(callGatewayMock).toHaveBeenCalledExactlyOnceWith({
      method: "device.pair.list",
      timeoutMs: 5_000,
      sharedStateMode: "read-only",
      config: { gateway: { mode: "remote" } },
    });
    expect(noteMock).toHaveBeenCalledTimes(1);
    expect(message).toContain("req-gateway-1");
    expect(message).toContain("bad\\nname");
    expect(message).not.toContain("\u001b");
    expect(message).not.toContain("control-ui\tclient");
  });

  it("quotes untrusted device pairing fields in suggested commands", async () => {
    callGatewayMock.mockResolvedValue({
      pending: [
        {
          ...pendingDevice,
          deviceId: "device; echo pwn",
          publicKey: "pending-pubkey",
          isRepair: true,
        },
      ],
      paired: [
        {
          deviceId: "device; echo pwn",
          publicKey: "paired-pubkey",
          displayName: "Dashboard",
          clientId: "control-ui",
          clientMode: "webchat",
          role: "operator; touch /tmp/pwn",
          roles: ["operator; touch /tmp/pwn"],
          scopes: [],
          approvedScopes: [],
          tokens: [],
          createdAtMs: 1,
          approvedAtMs: 1,
        },
      ],
    });

    await noteDevicePairingHealth(remoteHealth);

    const message = requireNoteMessage();
    expect(message).toContain("openclaw devices remove 'device; echo pwn'");
    expect(message).toContain(
      "openclaw devices rotate --device 'device; echo pwn' --role 'operator; touch /tmp/pwn'",
    );
  });
});
