import assert from "node:assert/strict";
import { hkdfSync } from "node:crypto";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import type { ClientCredentialResult } from "./client-credential-store.js";
import {
  loadChatRequestIdentityKeyAsync as loadChatKey,
  loadDeviceIdentityIfPresentAsync as readIdentity,
  loadOrCreateDeviceIdentityAsync as createIdentity,
  loadOrCreateProcessDeviceIdentityAsync as processIdentity,
} from "./device-identity-async.js";
import {
  generateStoredDeviceIdentity,
  storedDeviceIdentityToRow,
} from "./device-identity-material.js";
import type { DeviceIdentityStoreOptions } from "./device-identity-store.js";
import { ed25519PrivateKeyPemFromRaw } from "./ed25519-signature.js";

const boundary = vi.hoisted(() => ({
  run: vi.fn<typeof import("./client-credential-async.js").runClientCredentialOperationAsync>(),
  warn: vi.fn(),
}));
vi.mock("./client-credential-async.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./client-credential-async.js")>()),
  runClientCredentialOperationAsync: boundary.run,
}));
vi.mock("../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (...args: Parameters<typeof actual.createSubsystemLogger>) => ({
      ...actual.createSubsystemLogger(...args),
      warn: boundary.warn,
    }),
  };
});

beforeEach(() => {
  boundary.run.mockReset();
  boundary.warn.mockReset();
});

function fixture(name: string) {
  const stored = generateStoredDeviceIdentity();
  const { createdAtMs: _created, ...identity } = stored;
  const env = { OPENCLAW_STATE_DIR: path.resolve("/synthetic", name) };
  const result = {
    kind: "identity",
    identity: storedDeviceIdentityToRow("primary", stored),
  } satisfies ClientCredentialResult;
  return { identity, env, result };
}

describe("async local identity boundary", () => {
  it("rejects unsupported identity paths before dispatching to the credential worker", async () => {
    const options = { path: path.resolve("/synthetic", "identity.sqlite") };
    await expect(createIdentity(options)).rejects.toThrow("client/credentials.sqlite");
    await expect(readIdentity(options)).rejects.toThrow("client/credentials.sqlite");
    expect(boundary.run).not.toHaveBeenCalled();
  });

  it("keeps existing-only lookup non-creating", async () => {
    const { env } = fixture("existing-only");
    boundary.run.mockResolvedValue({ kind: "identity", identity: null });
    expect(await readIdentity({ env })).toBeNull();
    expect(boundary.run).toHaveBeenCalledExactlyOnceWith(env, {
      kind: "identity.read",
      identity_key: "primary",
    });
  });

  it("returns the owner's persisted winner from atomic identity creation", async () => {
    const { env, identity, result } = fixture("persisted-winner");
    boundary.run.mockResolvedValue(result);
    expect(await createIdentity({ env })).toEqual(identity);
    expect(boundary.run).toHaveBeenCalledExactlyOnceWith(
      env,
      expect.objectContaining({ kind: "identity.create" }),
    );
  });

  it.each(["create", "read"] as const)(
    "captures credential root and identity key before delayed %s dispatch",
    async (mode) => {
      const { env, identity, result } = fixture(`captured-${mode}`);
      const completion = createDeferredCore<ClientCredentialResult>();
      boundary.run.mockReturnValue(completion.promise);
      const options: DeviceIdentityStoreOptions = { env, identityKey: "primary" };
      const loading = mode === "create" ? createIdentity(options) : readIdentity(options);
      options.env!.OPENCLAW_STATE_DIR = "/synthetic/changed";
      options.identityKey = "node";
      options.path = "/synthetic/replaced/client/credentials.sqlite";
      const [captured] = boundary.run.mock.calls;
      assert.ok(captured);
      expect(captured[0]).toEqual({
        OPENCLAW_STATE_DIR: path.resolve("/synthetic", `captured-${mode}`),
      });
      expect(captured[1]).toEqual(
        mode === "create"
          ? {
              kind: "identity.create",
              identity: expect.objectContaining({ identity_key: "primary" }),
            }
          : { kind: "identity.read", identity_key: "primary" },
      );
      completion.resolve(result);
      expect(await loading).toEqual(identity);
    },
  );

  it("derives and caches a chat-only key from persisted raw Ed25519 bytes", async () => {
    const { env, result } = fixture("chat-cache");
    const raw = Buffer.alloc(32, 7);
    result.identity.private_key_pem = ed25519PrivateKeyPemFromRaw(raw);
    boundary.run.mockResolvedValue(result);
    const key = await loadChatKey({ env });
    expect(key).toEqual(
      Buffer.from(
        hkdfSync("sha256", raw, "openclaw.device-identity", "openclaw.chat.request.v1", 32),
      ),
    );
    expect(key).not.toEqual(raw);
    expect(await loadChatKey({ env })).toBe(key);
    expect(boundary.run).toHaveBeenCalledOnce();
  });

  it("warns once for missing or unreadable chat identity and retries without creating a replacement", async () => {
    const { env, result } = fixture("unavailable-chat-key");
    boundary.run
      .mockResolvedValueOnce({ kind: "identity", identity: null })
      .mockRejectedValueOnce(new Error("synthetic identity read failure"))
      .mockResolvedValueOnce(result);
    await expect(loadChatKey({ env })).resolves.toBeNull();
    await expect(loadChatKey({ env })).resolves.toBeNull();
    await expect(loadChatKey({ env })).resolves.toHaveLength(32);
    expect(boundary.run.mock.calls.every((call) => call[1].kind === "identity.read")).toBe(true);
    expect(boundary.warn).toHaveBeenCalledExactlyOnceWith(
      'Gateway device identity "primary" is missing or unreadable; chat.send will continue without a keyed request fingerprint.',
    );
  });

  it("converges concurrent process callers on one object and keeps keys independent", async () => {
    const { env, identity, result } = fixture("process-cache");
    const options: DeviceIdentityStoreOptions = { env, identityKey: "first" };
    const capturedOptions = { ...options, env: { ...env } };
    const cached = (identityKey = "first") => processIdentity({ ...capturedOptions, identityKey });
    const first = createDeferredCore<ClientCredentialResult>();
    const second = createDeferredCore<ClientCredentialResult>();
    boundary.run.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const firstLoad = processIdentity(options);
    const secondLoad = processIdentity(options);
    options.path = "/synthetic/changed-process/client/credentials.sqlite";
    options.identityKey = "changed-key";
    env.OPENCLAW_STATE_DIR = "/synthetic/changed-process";
    second.resolve(result);
    const winner = await secondLoad;
    first.resolve(result);
    await expect(firstLoad).resolves.toBe(winner);

    const other = fixture("other-process-key");
    boundary.run.mockResolvedValue(other.result);
    expect(await cached("second")).toEqual(other.identity);
    boundary.run.mockRejectedValue(new Error("The owner is unavailable after caching"));
    await expect(cached()).resolves.toBe(winner);
    await expect(cached("second")).resolves.toEqual(other.identity);
    expect(winner).toEqual(identity);
  });
});
