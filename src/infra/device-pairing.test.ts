import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { requireNodeSqlite } from "../memory/sqlite.js";
import {
  approveDevicePairing,
  clearDevicePairing,
  getPairedDevice,
  removePairedDevice,
  requestDevicePairing,
  rotateDeviceToken,
  verifyDeviceToken,
} from "./device-pairing.js";
import {
  resetDevicePairingDbForTest,
  setDevicePairingDbForTest,
} from "./state-db/device-pairing-sqlite.js";
import { runMigrations } from "./state-db/schema.js";

describe("device pairing tokens", () => {
  let db: ReturnType<typeof requireNodeSqlite>["DatabaseSync"]["prototype"];

  beforeEach(() => {
    const { DatabaseSync } = requireNodeSqlite();
    db = new DatabaseSync(":memory:");
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    runMigrations(db);
    setDevicePairingDbForTest(db);
  });

  afterEach(() => {
    resetDevicePairingDbForTest();
    try {
      db.close();
    } catch {
      // ignore
    }
  });

  async function setupPairedOperatorDevice(scopes: string[]) {
    const request = await requestDevicePairing({
      deviceId: "device-1",
      publicKey: "public-key-1",
      role: "operator",
      scopes,
    });
    await approveDevicePairing(request.request.requestId);
  }

  async function setupOperatorToken(scopes: string[]) {
    await setupPairedOperatorDevice(scopes);
    const paired = await getPairedDevice("device-1");
    const token = requireToken(paired?.tokens?.operator?.token);
    return token;
  }

  function requireToken(token: string | undefined): string {
    expect(typeof token).toBe("string");
    if (typeof token !== "string") {
      throw new Error("expected operator token to be issued");
    }
    return token;
  }

  test("reuses existing pending requests for the same device", async () => {
    const first = await requestDevicePairing({
      deviceId: "device-1",
      publicKey: "public-key-1",
    });
    const second = await requestDevicePairing({
      deviceId: "device-1",
      publicKey: "public-key-1",
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.request.requestId).toBe(first.request.requestId);
  });

  test("merges pending roles/scopes for the same device before approval", async () => {
    const first = await requestDevicePairing({
      deviceId: "device-1",
      publicKey: "public-key-1",
      role: "node",
      scopes: [],
    });
    const second = await requestDevicePairing({
      deviceId: "device-1",
      publicKey: "public-key-1",
      role: "operator",
      scopes: ["operator.read", "operator.write"],
    });

    expect(second.created).toBe(false);
    expect(second.request.requestId).toBe(first.request.requestId);
    expect(second.request.roles).toEqual(["node", "operator"]);
    expect(second.request.scopes).toEqual(["operator.read", "operator.write"]);

    await approveDevicePairing(first.request.requestId);
    const paired = await getPairedDevice("device-1");
    expect(paired?.roles).toEqual(["node", "operator"]);
    expect(paired?.scopes).toEqual(["operator.read", "operator.write"]);
  });

  test("generates base64url device tokens with 256-bit entropy output length", async () => {
    await setupPairedOperatorDevice(["operator.admin"]);

    const paired = await getPairedDevice("device-1");
    const token = requireToken(paired?.tokens?.operator?.token);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(token, "base64url")).toHaveLength(32);
  });

  test("allows down-scoping from admin and preserves approved scope baseline", async () => {
    await setupPairedOperatorDevice(["operator.admin"]);

    await rotateDeviceToken({
      deviceId: "device-1",
      role: "operator",
      scopes: ["operator.read"],
    });
    let paired = await getPairedDevice("device-1");
    expect(paired?.tokens?.operator?.scopes).toEqual(["operator.read"]);
    expect(paired?.scopes).toEqual(["operator.admin"]);
    expect(paired?.approvedScopes).toEqual(["operator.admin"]);

    await rotateDeviceToken({
      deviceId: "device-1",
      role: "operator",
    });
    paired = await getPairedDevice("device-1");
    expect(paired?.tokens?.operator?.scopes).toEqual(["operator.read"]);
  });

  test("preserves existing token scopes when approving a repair without requested scopes", async () => {
    await setupPairedOperatorDevice(["operator.admin"]);

    const repair = await requestDevicePairing({
      deviceId: "device-1",
      publicKey: "public-key-1",
      role: "operator",
    });
    await approveDevicePairing(repair.request.requestId);

    const paired = await getPairedDevice("device-1");
    expect(paired?.scopes).toEqual(["operator.admin"]);
    expect(paired?.approvedScopes).toEqual(["operator.admin"]);
    expect(paired?.tokens?.operator?.scopes).toEqual(["operator.admin"]);
  });

  test("rejects scope escalation when rotating a token and leaves state unchanged", async () => {
    await setupPairedOperatorDevice(["operator.read"]);
    const before = await getPairedDevice("device-1");

    const rotated = await rotateDeviceToken({
      deviceId: "device-1",
      role: "operator",
      scopes: ["operator.admin"],
    });
    expect(rotated).toBeNull();

    const after = await getPairedDevice("device-1");
    expect(after?.tokens?.operator?.token).toEqual(before?.tokens?.operator?.token);
    expect(after?.tokens?.operator?.scopes).toEqual(["operator.read"]);
    expect(after?.scopes).toEqual(["operator.read"]);
    expect(after?.approvedScopes).toEqual(["operator.read"]);
  });

  test("verifies token and rejects mismatches", async () => {
    const token = await setupOperatorToken(["operator.read"]);

    const ok = await verifyDeviceToken({
      deviceId: "device-1",
      token,
      role: "operator",
      scopes: ["operator.read"],
    });
    expect(ok.ok).toBe(true);

    const mismatch = await verifyDeviceToken({
      deviceId: "device-1",
      token: "x".repeat(token.length),
      role: "operator",
      scopes: ["operator.read"],
    });
    expect(mismatch.ok).toBe(false);
    expect(mismatch.reason).toBe("token-mismatch");
  });

  test("accepts operator.read/operator.write requests with an operator.admin token scope", async () => {
    const token = await setupOperatorToken(["operator.admin"]);

    const readOk = await verifyDeviceToken({
      deviceId: "device-1",
      token,
      role: "operator",
      scopes: ["operator.read"],
    });
    expect(readOk.ok).toBe(true);

    const writeOk = await verifyDeviceToken({
      deviceId: "device-1",
      token,
      role: "operator",
      scopes: ["operator.write"],
    });
    expect(writeOk.ok).toBe(true);
  });

  test("treats multibyte same-length token input as mismatch without throwing", async () => {
    const token = await setupOperatorToken(["operator.read"]);
    const multibyteToken = "é".repeat(token.length);
    expect(Buffer.from(multibyteToken).length).not.toBe(Buffer.from(token).length);

    await expect(
      verifyDeviceToken({
        deviceId: "device-1",
        token: multibyteToken,
        role: "operator",
        scopes: ["operator.read"],
      }),
    ).resolves.toEqual({ ok: false, reason: "token-mismatch" });
  });

  test("removes paired devices by device id", async () => {
    await setupPairedOperatorDevice(["operator.read"]);

    const removed = await removePairedDevice("device-1");
    expect(removed).toEqual({ deviceId: "device-1" });
    await expect(getPairedDevice("device-1")).resolves.toBeNull();

    await expect(removePairedDevice("device-1")).resolves.toBeNull();
  });

  test("clears paired device state by device id", async () => {
    await setupPairedOperatorDevice(["operator.read"]);

    await expect(clearDevicePairing("device-1")).resolves.toBe(true);
    await expect(getPairedDevice("device-1")).resolves.toBeNull();
    await expect(clearDevicePairing("device-1")).resolves.toBe(false);
  });
});
