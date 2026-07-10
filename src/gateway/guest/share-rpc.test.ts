import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ErrorCodes, type ErrorShape } from "../../../packages/gateway-protocol/src/index.js";
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
import { GuestGrantStore, type GuestGrant } from "./grant-store.js";
import { createGuestShareHandlers } from "./share-rpc.js";

describe("sessions.share RPCs", () => {
  const tempDirs: string[] = [];
  const stores: GuestGrantStore[] = [];

  function makeStore(options: { now?: () => number } = {}) {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-share-rpc-"));
    tempDirs.push(stateDir);
    const store = new GuestGrantStore({ stateDir, ...options });
    stores.push(store);
    return store;
  }

  async function invoke(
    handlers: ReturnType<typeof createGuestShareHandlers>,
    method: string,
    params: Record<string, unknown>,
  ): Promise<{ ok: boolean; payload?: unknown; error?: ErrorShape }> {
    const handler = handlers[method];
    if (!handler) {
      throw new Error(`${method} handler missing`);
    }
    let response: { ok: boolean; payload?: unknown; error?: ErrorShape } | undefined;
    await handler({
      req: { type: "req", id: `test-${method}`, method, params },
      params,
      client: null,
      isWebchatConnect: () => false,
      context: {
        getRuntimeConfig: () => ({}),
      } as unknown as GatewayRequestContext,
      respond: (ok: boolean, payload?: unknown, error?: ErrorShape) => {
        response = { ok, payload, error };
      },
    } as GatewayRequestHandlerOptions);
    if (!response) {
      throw new Error(`${method} did not respond`);
    }
    return response;
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
      sessionExists: () => true,
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

  it("W0-T8 integration: multi-grant create, filtered ordered list, and revoke round-trip returns every non-secret field", async () => {
    const startedAtMs = 1_800_000_000_000;
    let now = startedAtMs;
    const store = makeStore({ now: () => now });
    const firstSession = "agent:main:guest-round-trip";
    const secondSession = "agent:main:guest-round-trip-other";
    const knownSessions = new Set([firstSession, secondSession]);
    const handlerOptions = {
      store,
      joinUrlBase: "https://joins.example.test/invite",
      sessionExists: (sessionKey: string) => knownSessions.has(sessionKey),
    };
    const handlers = createGuestShareHandlers(handlerOptions);

    const firstExpiresAtMs = startedAtMs + 60_000;
    const first = await invoke(handlers, "sessions.share.create", {
      sessionKey: firstSession,
      access: "link",
      expiresAtMs: firstExpiresAtMs,
    });
    now += 100;
    const secondExpiresAtMs = startedAtMs + 70_000;
    const second = await invoke(handlers, "sessions.share.create", {
      sessionKey: firstSession,
      access: "invite",
      invitedPrincipal: { issuer: "deva", subject: "deva-user-42" },
      expiresAtMs: secondExpiresAtMs,
      replayPolicy: "full",
    });
    now += 100;
    const thirdExpiresAtMs = startedAtMs + 80_000;
    const third = await invoke(handlers, "sessions.share.create", {
      sessionKey: secondSession,
      access: "link",
      expiresAtMs: thirdExpiresAtMs,
      replayPolicy: "full",
    });
    const firstGrantId = (first.payload as { grantId: string }).grantId;
    const secondGrantId = (second.payload as { grantId: string }).grantId;
    const thirdGrantId = (third.payload as { grantId: string }).grantId;

    const filtered = await invoke(handlers, "sessions.share.list", {
      sessionKey: firstSession,
    });
    expect(filtered).toEqual({
      ok: true,
      error: undefined,
      payload: {
        grants: [
          {
            grantId: secondGrantId,
            sessionKey: firstSession,
            mode: "viewer",
            audience: "deva-user",
            invitedPrincipal: { issuer: "deva", subject: "deva-user-42" },
            createdBy: "unknown-device",
            createdAtMs: startedAtMs + 100,
            expiresAtMs: secondExpiresAtMs,
            replayPolicy: "full",
          },
          {
            grantId: firstGrantId,
            sessionKey: firstSession,
            mode: "viewer",
            audience: "open",
            createdBy: "unknown-device",
            createdAtMs: startedAtMs,
            expiresAtMs: firstExpiresAtMs,
            replayPolicy: "share-start",
          },
        ],
      },
    });
    const unfiltered = await invoke(handlers, "sessions.share.list", {});
    expect((unfiltered.payload as { grants: Array<{ grantId: string }> }).grants).toEqual([
      expect.objectContaining({ grantId: thirdGrantId, sessionKey: secondSession }),
      expect.objectContaining({ grantId: secondGrantId, sessionKey: firstSession }),
      expect.objectContaining({ grantId: firstGrantId, sessionKey: firstSession }),
    ]);

    now += 100;
    expect(await invoke(handlers, "sessions.share.revoke", { grantId: secondGrantId })).toEqual({
      ok: true,
      error: undefined,
      payload: { grantId: secondGrantId, revokedAtMs: now },
    });
    const afterRevoke = await invoke(handlers, "sessions.share.list", {
      sessionKey: firstSession,
    });
    expect(afterRevoke.payload).toEqual({
      grants: [
        expect.objectContaining({ grantId: secondGrantId, revokedAtMs: now }),
        expect.objectContaining({ grantId: firstGrantId }),
      ],
    });
    expect(JSON.stringify(afterRevoke.payload)).not.toMatch(/codeHash|joinUrl|"code"|token/iu);
  });

  it("W0-T13 negative: invalid create inputs and unknown or repeated list/revoke targets fail cleanly", async () => {
    const now = 1_800_000_000_000;
    const store = makeStore({ now: () => now });
    const sessionKey = "agent:main:negative-share";
    const handlerOptions = {
      store,
      sessionExists: (candidate: string) => candidate === sessionKey,
    };
    const handlers = createGuestShareHandlers(handlerOptions);
    const invalidCreateParams: Array<Record<string, unknown>> = [
      { sessionKey, access: "link", expiresAtMs: 0 },
      { sessionKey, access: "link", expiresAtMs: -1 },
      { sessionKey, access: "link", expiresAtMs: now - 1 },
      { sessionKey, access: "invalid-audience" },
      { sessionKey, access: "link", replayPolicy: "invalid-replay" },
      { sessionKey: "agent:main:does-not-exist", access: "link" },
    ];
    for (const params of invalidCreateParams) {
      const response = await invoke(handlers, "sessions.share.create", params);
      expect(response.ok).toBe(false);
      expect(response.error?.code).toBe(ErrorCodes.INVALID_REQUEST);
    }

    const invalidJoinUrlHandlers = createGuestShareHandlers({
      ...handlerOptions,
      joinUrlBase: "file:///tmp/guest-share",
    });
    const invalidJoinUrlCreate = await invoke(invalidJoinUrlHandlers, "sessions.share.create", {
      sessionKey,
      access: "link",
    });
    expect(invalidJoinUrlCreate.ok).toBe(false);
    expect(invalidJoinUrlCreate.error?.code).toBe(ErrorCodes.INVALID_REQUEST);
    expect(store.listGrants()).toEqual([]);

    const commonGrantParams = {
      sessionKey,
      createdBy: "device:negative-test",
      expiresAtMs: now + 60_000,
    };
    expect(() =>
      store.createGrant({
        ...commonGrantParams,
        audience: "invalid-audience" as GuestGrant["audience"],
      }),
    ).toThrow("audience must be open or deva-user");
    expect(() =>
      store.createGrant({
        ...commonGrantParams,
        audience: "open",
        replayPolicy: "invalid-replay" as GuestGrant["replayPolicy"],
      }),
    ).toThrow("replayPolicy must be share-start or full");

    const unknownList = await invoke(handlers, "sessions.share.list", {
      sessionKey: "agent:main:does-not-exist",
    });
    expect(unknownList.ok).toBe(false);
    expect(unknownList.error?.code).toBe(ErrorCodes.INVALID_REQUEST);
    const unknownRevoke = await invoke(handlers, "sessions.share.revoke", {
      grantId: "grant-does-not-exist",
    });
    expect(unknownRevoke.ok).toBe(false);
    expect(unknownRevoke.error?.code).toBe(ErrorCodes.INVALID_REQUEST);

    const created = await invoke(handlers, "sessions.share.create", {
      sessionKey,
      access: "link",
      expiresAtMs: now + 60_000,
    });
    const grantId = (created.payload as { grantId: string }).grantId;
    expect((await invoke(handlers, "sessions.share.revoke", { grantId })).ok).toBe(true);
    const repeatedRevoke = await invoke(handlers, "sessions.share.revoke", { grantId });
    expect(repeatedRevoke.ok).toBe(false);
    expect(repeatedRevoke.error?.code).toBe(ErrorCodes.INVALID_REQUEST);

    const tombstoneList = await invoke(handlers, "sessions.share.list", { sessionKey });
    expect(tombstoneList).toMatchObject({
      ok: true,
      payload: { grants: [expect.objectContaining({ grantId, revokedAtMs: now })] },
    });
  });
});
