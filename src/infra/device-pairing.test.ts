import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { issueDeviceBootstrapToken, verifyDeviceBootstrapToken } from "./device-bootstrap.js";
import {
  approveDevicePairing,
  clearDevicePairing,
  ensureDeviceToken,
  getPairedDevice,
  removePairedDevice,
  requestDevicePairing,
  rotateDeviceToken,
  verifyDeviceToken,
  type PairedDevice,
  type RotateDeviceTokenResult,
} from "./device-pairing.js";
import { resolvePairingPaths } from "./pairing-files.js";

async function setupPairedOperatorDevice(baseDir: string, scopes: string[]) {
  const request = await requestDevicePairing(
    {
      deviceId: "device-1",
      publicKey: "public-key-1",
      role: "operator",
      scopes,
    },
    baseDir,
  );
  await approveDevicePairing(request.request.requestId, baseDir);
}

async function setupOperatorToken(scopes: string[]) {
  const baseDir = await mkdtemp(join(tmpdir(), "openclaw-device-pairing-"));
  await setupPairedOperatorDevice(baseDir, scopes);
  const paired = await getPairedDevice("device-1", baseDir);
  const token = requireToken(paired?.tokens?.operator?.token);
  return { baseDir, token };
}

function verifyOperatorToken(params: { baseDir: string; token: string; scopes: string[] }) {
  return verifyDeviceToken({
    deviceId: "device-1",
    token: params.token,
    role: "operator",
    scopes: params.scopes,
    baseDir: params.baseDir,
  });
}

function requireToken(token: string | undefined): string {
  expect(typeof token).toBe("string");
  if (typeof token !== "string") {
    throw new Error("expected operator token to be issued");
  }
  return token;
}

function requireRotatedEntry(result: RotateDeviceTokenResult) {
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(`expected rotated token entry, got ${result.reason}`);
  }
  return result.entry;
}

async function overwritePairedOperatorTokenScopes(baseDir: string, scopes: string[]) {
  const { pairedPath } = resolvePairingPaths(baseDir, "devices");
  const pairedByDeviceId = JSON.parse(await readFile(pairedPath, "utf8")) as Record<
    string,
    PairedDevice
  >;
  const device = pairedByDeviceId["device-1"];
  expect(device?.tokens?.operator).toBeDefined();
  if (!device?.tokens?.operator) {
    throw new Error("expected paired operator token");
  }
  device.tokens.operator.scopes = scopes;
  await writeFile(pairedPath, JSON.stringify(pairedByDeviceId, null, 2));
}

async function mutatePairedOperatorDevice(baseDir: string, mutate: (device: PairedDevice) => void) {
  const { pairedPath } = resolvePairingPaths(baseDir, "devices");
  const pairedByDeviceId = JSON.parse(await readFile(pairedPath, "utf8")) as Record<
    string,
    PairedDevice
  >;
  const device = pairedByDeviceId["device-1"];
  expect(device).toBeDefined();
  if (!device) {
    throw new Error("expected paired operator device");
  }
  mutate(device);
  await writeFile(pairedPath, JSON.stringify(pairedByDeviceId, null, 2));
}

async function clearPairedOperatorApprovalBaseline(baseDir: string) {
  await mutatePairedOperatorDevice(baseDir, (device) => {
    delete device.approvedScopes;
    delete device.scopes;
  });
}

describe("device pairing tokens", () => {
  test("reuses existing pending requests for the same device", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "openclaw-device-pairing-"));
    const first = await requestDevicePairing(
      {
        deviceId: "device-1",
        publicKey: "public-key-1",
      },
      baseDir,
    );
    const second = await requestDevicePairing(
      {
        deviceId: "device-1",
        publicKey: "public-key-1",
      },
      baseDir,
    );

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.request.requestId).toBe(first.request.requestId);
  });

  test("merges pending roles/scopes for the same device before approval", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "openclaw-device-pairing-"));
    const first = await requestDevicePairing(
      {
        deviceId: "device-1",
        publicKey: "public-key-1",
        role: "node",
        scopes: [],
      },
      baseDir,
    );
    const second = await requestDevicePairing(
      {
        deviceId: "device-1",
        publicKey: "public-key-1",
        role: "operator",
        scopes: ["operator.read", "operator.write"],
      },
      baseDir,
    );

    expect(second.created).toBe(false);
    expect(second.request.requestId).toBe(first.request.requestId);
    expect(second.request.roles).toEqual(["node", "operator"]);
    expect(second.request.scopes).toEqual(["operator.read", "operator.write"]);

    await approveDevicePairing(first.request.requestId, baseDir);
    const paired = await getPairedDevice("device-1", baseDir);
    expect(paired?.roles).toEqual(["node", "operator"]);
    expect(paired?.scopes).toEqual(["operator.read", "operator.write"]);
  });

  test("rejects bootstrap token replay before pending scope escalation can be approved", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "openclaw-device-pairing-"));
    const issued = await issueDeviceBootstrapToken({ baseDir });

    await expect(
      verifyDeviceBootstrapToken({
        token: issued.token,
        deviceId: "device-1",
        publicKey: "public-key-1",
        role: "operator",
        scopes: ["operator.read"],
        baseDir,
      }),
    ).resolves.toEqual({ ok: true });

    const first = await requestDevicePairing(
      {
        deviceId: "device-1",
        publicKey: "public-key-1",
        role: "operator",
        scopes: ["operator.read"],
      },
      baseDir,
    );

    await expect(
      verifyDeviceBootstrapToken({
        token: issued.token,
        deviceId: "device-1",
        publicKey: "public-key-1",
        role: "operator",
        scopes: ["operator.admin"],
        baseDir,
      }),
    ).resolves.toEqual({ ok: false, reason: "bootstrap_token_invalid" });

    await approveDevicePairing(first.request.requestId, baseDir);
    const paired = await getPairedDevice("device-1", baseDir);
    expect(paired?.scopes).toEqual(["operator.read"]);
    expect(paired?.approvedScopes).toEqual(["operator.read"]);
    expect(paired?.tokens?.operator?.scopes).toEqual(["operator.read"]);
  });

  test("generates base64url device tokens with 256-bit entropy output length", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "openclaw-device-pairing-"));
    await setupPairedOperatorDevice(baseDir, ["operator.admin"]);

    const paired = await getPairedDevice("device-1", baseDir);
    const token = requireToken(paired?.tokens?.operator?.token);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(token, "base64url")).toHaveLength(32);
  });

  test("allows down-scoping from admin and preserves approved scope baseline", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "openclaw-device-pairing-"));
    await setupPairedOperatorDevice(baseDir, ["operator.admin"]);

    const downscoped = await rotateDeviceToken({
      deviceId: "device-1",
      role: "operator",
      scopes: ["operator.read"],
      baseDir,
    });
    expect(downscoped.ok).toBe(true);
    let paired = await getPairedDevice("device-1", baseDir);
    expect(paired?.tokens?.operator?.scopes).toEqual(["operator.read"]);
    expect(paired?.scopes).toEqual(["operator.admin"]);
    expect(paired?.approvedScopes).toEqual(["operator.admin"]);

    const reused = await rotateDeviceToken({
      deviceId: "device-1",
      role: "operator",
      baseDir,
    });
    expect(reused.ok).toBe(true);
    paired = await getPairedDevice("device-1", baseDir);
    expect(paired?.tokens?.operator?.scopes).toEqual(["operator.read"]);
  });

  test("preserves existing token scopes when approving a repair without requested scopes", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "openclaw-device-pairing-"));
    await setupPairedOperatorDevice(baseDir, ["operator.admin"]);

    const repair = await requestDevicePairing(
      {
        deviceId: "device-1",
        publicKey: "public-key-1",
        role: "operator",
      },
      baseDir,
    );
    await approveDevicePairing(repair.request.requestId, baseDir);

    const paired = await getPairedDevice("device-1", baseDir);
    expect(paired?.scopes).toEqual(["operator.admin"]);
    expect(paired?.approvedScopes).toEqual(["operator.admin"]);
    expect(paired?.tokens?.operator?.scopes).toEqual(["operator.admin"]);
  });

  test("rejects scope escalation when rotating a token and leaves state unchanged", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "openclaw-device-pairing-"));
    await setupPairedOperatorDevice(baseDir, ["operator.read"]);
    const before = await getPairedDevice("device-1", baseDir);

    const rotated = await rotateDeviceToken({
      deviceId: "device-1",
      role: "operator",
      scopes: ["operator.admin"],
      baseDir,
    });
    expect(rotated).toEqual({ ok: false, reason: "scope-outside-approved-baseline" });

    const after = await getPairedDevice("device-1", baseDir);
    expect(after?.tokens?.operator?.token).toEqual(before?.tokens?.operator?.token);
    expect(after?.tokens?.operator?.scopes).toEqual(["operator.read"]);
    expect(after?.scopes).toEqual(["operator.read"]);
    expect(after?.approvedScopes).toEqual(["operator.read"]);
  });

  test("rejects scope escalation when ensuring a token and leaves state unchanged", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "openclaw-device-pairing-"));
    await setupPairedOperatorDevice(baseDir, ["operator.read"]);
    const before = await getPairedDevice("device-1", baseDir);

    const ensured = await ensureDeviceToken({
      deviceId: "device-1",
      role: "operator",
      scopes: ["operator.admin"],
      baseDir,
    });
    expect(ensured).toBeNull();

    const after = await getPairedDevice("device-1", baseDir);
    expect(after?.tokens?.operator?.token).toEqual(before?.tokens?.operator?.token);
    expect(after?.tokens?.operator?.scopes).toEqual(["operator.read"]);
    expect(after?.scopes).toEqual(["operator.read"]);
    expect(after?.approvedScopes).toEqual(["operator.read"]);
  });

  test("verifies token and rejects mismatches", async () => {
    const { baseDir, token } = await setupOperatorToken(["operator.read"]);

    const ok = await verifyOperatorToken({
      baseDir,
      token,
      scopes: ["operator.read"],
    });
    expect(ok.ok).toBe(true);

    const mismatch = await verifyOperatorToken({
      baseDir,
      token: "x".repeat(token.length),
      scopes: ["operator.read"],
    });
    expect(mismatch.ok).toBe(false);
    expect(mismatch.reason).toBe("token-mismatch");
  });

  test("rejects persisted tokens whose scopes exceed the approved scope baseline", async () => {
    const { baseDir, token } = await setupOperatorToken(["operator.read"]);
    await overwritePairedOperatorTokenScopes(baseDir, ["operator.admin"]);

    await expect(
      verifyOperatorToken({
        baseDir,
        token,
        scopes: ["operator.admin"],
      }),
    ).resolves.toEqual({ ok: false, reason: "scope-mismatch" });
  });

  test("fails closed when the paired device approval baseline is missing during verification", async () => {
    const { baseDir, token } = await setupOperatorToken(["operator.read"]);
    await clearPairedOperatorApprovalBaseline(baseDir);

    await expect(
      verifyOperatorToken({
        baseDir,
        token,
        scopes: ["operator.read"],
      }),
    ).resolves.toEqual({ ok: false, reason: "scope-mismatch" });
  });

  test("accepts operator.read/operator.write requests with an operator.admin token scope", async () => {
    const { baseDir, token } = await setupOperatorToken(["operator.admin"]);

    const readOk = await verifyOperatorToken({
      baseDir,
      token,
      scopes: ["operator.read"],
    });
    expect(readOk.ok).toBe(true);

    const writeOk = await verifyOperatorToken({
      baseDir,
      token,
      scopes: ["operator.write"],
    });
    expect(writeOk.ok).toBe(true);
  });

  test("accepts custom operator scopes under an operator.admin approval baseline", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "openclaw-device-pairing-"));
    await setupPairedOperatorDevice(baseDir, ["operator.admin"]);

    const rotated = await rotateDeviceToken({
      deviceId: "device-1",
      role: "operator",
      scopes: ["operator.talk.secrets"],
      baseDir,
    });
    const entry = requireRotatedEntry(rotated);
    expect(entry.scopes).toEqual(["operator.talk.secrets"]);

    await expect(
      verifyOperatorToken({
        baseDir,
        token: requireToken(entry.token),
        scopes: ["operator.talk.secrets"],
      }),
    ).resolves.toEqual({ ok: true });
  });

  test("fails closed when the paired device approval baseline is missing during ensure", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "openclaw-device-pairing-"));
    await setupPairedOperatorDevice(baseDir, ["operator.admin"]);
    await clearPairedOperatorApprovalBaseline(baseDir);

    await expect(
      ensureDeviceToken({
        deviceId: "device-1",
        role: "operator",
        scopes: ["operator.admin"],
        baseDir,
      }),
    ).resolves.toBeNull();
  });

  test("fails closed when the paired device approval baseline is missing during rotation", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "openclaw-device-pairing-"));
    await setupPairedOperatorDevice(baseDir, ["operator.admin"]);
    await clearPairedOperatorApprovalBaseline(baseDir);

    await expect(
      rotateDeviceToken({
        deviceId: "device-1",
        role: "operator",
        scopes: ["operator.admin"],
        baseDir,
      }),
    ).resolves.toEqual({ ok: false, reason: "missing-approved-scope-baseline" });
  });

  test("treats multibyte same-length token input as mismatch without throwing", async () => {
    const { baseDir, token } = await setupOperatorToken(["operator.read"]);
    const multibyteToken = "é".repeat(token.length);
    expect(Buffer.from(multibyteToken).length).not.toBe(Buffer.from(token).length);

    await expect(
      verifyOperatorToken({
        baseDir,
        token: multibyteToken,
        scopes: ["operator.read"],
      }),
    ).resolves.toEqual({ ok: false, reason: "token-mismatch" });
  });

  test("removes paired devices by device id", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "openclaw-device-pairing-"));
    await setupPairedOperatorDevice(baseDir, ["operator.read"]);

    const removed = await removePairedDevice("device-1", baseDir);
    expect(removed).toEqual({ deviceId: "device-1" });
    await expect(getPairedDevice("device-1", baseDir)).resolves.toBeNull();

    await expect(removePairedDevice("device-1", baseDir)).resolves.toBeNull();
  });

  test("clears paired device state by device id", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "openclaw-device-pairing-"));
    await setupPairedOperatorDevice(baseDir, ["operator.read"]);

    await expect(clearDevicePairing("device-1", baseDir)).resolves.toBe(true);
    await expect(getPairedDevice("device-1", baseDir)).resolves.toBeNull();
    await expect(clearDevicePairing("device-1", baseDir)).resolves.toBe(false);
  });
});
