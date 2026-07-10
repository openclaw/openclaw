import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { GuestAccessController } from "./access-controller.js";
import { GuestGrantStore } from "./grant-store.js";

function readDatabaseArtifacts(filePath: string): string {
  const directory = path.dirname(filePath);
  const basename = path.basename(filePath);
  return fs
    .readdirSync(directory)
    .filter((entry) => entry.startsWith(basename))
    .map((entry) => fs.readFileSync(path.join(directory, entry)).toString("latin1"))
    .join("\n");
}

describe("Wave 1 guest token crash boundaries", () => {
  const tempDirs: string[] = [];
  const stores: GuestGrantStore[] = [];
  const controllers: GuestAccessController[] = [];

  function makeStore(now: () => number) {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-guest-w1-crash-"));
    tempDirs.push(stateDir);
    const store = new GuestGrantStore({ stateDir, now });
    stores.push(store);
    return { stateDir, store };
  }

  afterEach(() => {
    for (const controller of controllers.splice(0)) {
      controller.close();
    }
    for (const store of stores.splice(0)) {
      store.close();
    }
    closeOpenClawStateDatabaseForTest();
    for (const directory of tempDirs.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("W1-T15 integration: Crash/restart at token-mint and handshake-consume boundaries: no reusable plaintext token, no half-attached join", async () => {
    const nowMs = 1_800_000_000_000;
    const now = () => nowMs;
    const mintedPlaintext = "minted-before-crash-plaintext-token";
    const consumedPlaintext = "consumed-before-crash-plaintext-token";
    const { stateDir, store } = makeStore(now);
    const mintedGrant = store.createGrant({
      sessionKey: "agent:main:mint-crash",
      audience: "open",
      createdBy: "device:w1-host",
      expiresAtMs: nowMs + 60_000,
    });
    const consumedGrant = store.createGrant({
      sessionKey: "agent:main:consume-crash",
      audience: "open",
      createdBy: "device:w1-host",
      expiresAtMs: nowMs + 60_000,
    });

    store.redeemGrant({
      code: mintedGrant.code,
      token: mintedPlaintext,
      tokenExpiresAtMs: nowMs + 1_000,
    });
    const consumedJoin = store.redeemGrant({
      code: consumedGrant.code,
      token: consumedPlaintext,
      tokenExpiresAtMs: nowMs + 1_000,
    });
    expect(store.consumeConnectionToken({ token: consumedPlaintext })).toMatchObject({
      join: { guestId: consumedJoin.guestId },
    });
    expect(readDatabaseArtifacts(store.filePath)).not.toContain(mintedPlaintext);
    expect(readDatabaseArtifacts(store.filePath)).not.toContain(consumedPlaintext);

    store.close();
    closeOpenClawStateDatabaseForTest();
    const reloadedStore = new GuestGrantStore({ stateDir, now });
    stores.push(reloadedStore);
    const reloadedController = new GuestAccessController({ store: reloadedStore, now });
    controllers.push(reloadedController);

    expect(reloadedStore.consumeConnectionToken({ token: mintedPlaintext })).toBeUndefined();
    expect(reloadedStore.consumeConnectionToken({ token: consumedPlaintext })).toBeUndefined();
    expect(reloadedStore.listJoins(mintedGrant.grant.grantId)).toEqual([]);
    expect(reloadedStore.listJoins(consumedGrant.grant.grantId)).toEqual([]);
    expect(reloadedController.connections.countAll()).toBe(0);
  });
});
