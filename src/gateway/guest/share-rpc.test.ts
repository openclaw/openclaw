import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import {
  authorizeOperatorScopesForMethod,
  READ_SCOPE,
  resolveLeastPrivilegeOperatorScopesForMethod,
  WRITE_SCOPE,
} from "../method-scopes.js";
import type {
  GatewayRequestContext,
  GatewayRequestHandlerOptions,
} from "../server-methods/types.js";
import { GuestGrantStore } from "./grant-store.js";
import { createGuestShareHandlers } from "./share-rpc.js";

describe("sessions.share RPCs", () => {
  const tempDirs: string[] = [];
  const stores: GuestGrantStore[] = [];

  function makeStore() {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-share-rpc-"));
    tempDirs.push(stateDir);
    const store = new GuestGrantStore({ stateDir });
    stores.push(store);
    return store;
  }

  afterEach(() => {
    for (const store of stores.splice(0)) {
      store.close();
    }
    closeOpenClawStateDatabaseForTest();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("W0-T2 unit: share.create returns {grantId, code, joinUrl} and no connection-token-like field", async () => {
    const store = makeStore();
    const handlers = createGuestShareHandlers({
      store,
      joinUrlBase: "https://joins.example.test/invite",
    });
    const handler = handlers["sessions.share.create"];
    if (!handler) {
      throw new Error("sessions.share.create handler missing");
    }
    let response: { ok: boolean; payload?: unknown } | undefined;
    const params = { sessionKey: "agent:main:guest-demo", access: "link" };
    const options = {
      req: { type: "req", id: "w0-t2", method: "sessions.share.create", params },
      params,
      client: null,
      isWebchatConnect: () => false,
      context: {
        getRuntimeConfig: () => ({}),
      } as unknown as GatewayRequestContext,
      respond: (ok: boolean, payload?: unknown) => {
        response = { ok, payload };
      },
    } as GatewayRequestHandlerOptions;

    await handler(options);

    expect(response?.ok).toBe(true);
    expect(response?.payload).toEqual({
      grantId: expect.any(String),
      code: expect.stringMatching(/^[A-HJ-NP-Z2-9]{3}-[A-HJ-NP-Z2-9]{3}$/),
      joinUrl: expect.stringMatching(
        /^https:\/\/joins\.example\.test\/invite\/[A-HJ-NP-Z2-9]{3}-[A-HJ-NP-Z2-9]{3}$/,
      ),
    });
    expect(JSON.stringify(response?.payload).toLowerCase()).not.toMatch(
      /token|credential|connectionsecret/,
    );
  });

  it("W0-T7 security: sessions.share.* methods reject callers lacking operator scope", () => {
    expect(resolveLeastPrivilegeOperatorScopesForMethod("sessions.share.create")).toEqual([
      WRITE_SCOPE,
    ]);
    expect(resolveLeastPrivilegeOperatorScopesForMethod("sessions.share.list")).toEqual([
      READ_SCOPE,
    ]);
    expect(resolveLeastPrivilegeOperatorScopesForMethod("sessions.share.revoke")).toEqual([
      WRITE_SCOPE,
    ]);

    expect(authorizeOperatorScopesForMethod("sessions.share.create", [READ_SCOPE])).toEqual({
      allowed: false,
      missingScope: WRITE_SCOPE,
    });
    expect(authorizeOperatorScopesForMethod("sessions.share.list", [])).toEqual({
      allowed: false,
      missingScope: READ_SCOPE,
    });
    expect(authorizeOperatorScopesForMethod("sessions.share.revoke", [READ_SCOPE])).toEqual({
      allowed: false,
      missingScope: WRITE_SCOPE,
    });
    expect(authorizeOperatorScopesForMethod("sessions.share.create", [WRITE_SCOPE])).toEqual({
      allowed: true,
    });
    expect(authorizeOperatorScopesForMethod("sessions.share.list", [READ_SCOPE])).toEqual({
      allowed: true,
    });
    expect(authorizeOperatorScopesForMethod("sessions.share.revoke", [WRITE_SCOPE])).toEqual({
      allowed: true,
    });
  });
});
