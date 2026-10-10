import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { normalizeUserBackgroundImage } from "../../state/user-background-image.js";
import { getUserBackground } from "../../state/user-background.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { handleGatewayRequest } from "../server-methods.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

vi.mock("../../state/user-background-image.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/user-background-image.js")>()),
  normalizeUserBackgroundImage: vi.fn(),
}));
const normalized = { image: Buffer.from([255, 216, 255, 217]), width: 1, height: 1 };
const empty = { expectedAssetId: null, expectedPreference: null };
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let client: GatewayClient;
let context: GatewayRequestContext;
let connected: boolean;
let broadcast: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("background-rpc-"));
  const profile = ensureProfileForEmail("reader@example.test");
  client = {
    connId: "background-client",
    authenticatedUserProfile: {
      profileId: profile.id,
      displayName: null,
      hasAvatar: false,
      updatedAt: profile.updatedAt,
    },
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      role: "operator",
      scopes: ["operator.read", "operator.write"],
      client: { id: "test", mode: "test", version: "1", platform: "test" },
    },
  };
  connected = true;
  broadcast = vi.fn();
  context = {
    getRuntimeConfig: () => ({}),
    getClientConnIds: (filter?: (client: GatewayClient) => boolean) =>
      new Set(connected && (!filter || filter(client)) ? [client.connId!] : []),
    broadcastToConnIds: broadcast,
  } as unknown as GatewayRequestContext;
  vi.mocked(normalizeUserBackgroundImage).mockReset().mockResolvedValue(normalized);
});
afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
});
async function rpc(method: string, params: Record<string, unknown> = {}) {
  const respond = vi.fn();
  await handleGatewayRequest({
    req: { type: "req", id: method, method, params },
    client,
    context,
    respond,
    isWebchatConnect: () => false,
  });
  return respond;
}

describe("registered private background methods", () => {
  it("allows ordinary profile read/write scopes and emits only a profile-targeted invalidation", async () => {
    const uploaded = await rpc("users.background.upload", { ...empty, imageBase64: "dGVzdA==" });
    expect(uploaded).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        status: "ok",
        asset: expect.objectContaining({ mime: "image/jpeg" }),
        preference: expect.objectContaining({ showInSessions: false }),
      }),
    );
    expect(broadcast).toHaveBeenCalledWith(
      "users.prefs.changed",
      { profileId: client.authenticatedUserProfile!.profileId, keys: ["ui.background"] },
      new Set([client.connId]),
    );
    client.connect.scopes = ["operator.read"];
    expect(await rpc("users.background.get")).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ status: "ok" }),
    );
    const denied = await rpc("users.background.remove", empty);
    expect(denied.mock.calls[0]?.[0]).toBe(false);
  });

  it.each(["disconnect", "profile-switch", "revoke-write"])(
    "refuses a pending decode after %s",
    async (revocation) => {
      const owner = client.authenticatedUserProfile!.profileId;
      let release!: (value: typeof normalized) => void;
      let started!: () => void;
      const decoding = new Promise<void>((resolve) => {
        started = resolve;
      });
      vi.mocked(normalizeUserBackgroundImage).mockImplementationOnce(() => {
        started();
        return new Promise((resolve) => {
          release = resolve;
        });
      });
      const pending = rpc("users.background.upload", { ...empty, imageBase64: "dGVzdA==" });
      await Promise.race([
        decoding,
        pending.then((response) => {
          throw new Error(
            "Upload finished before decoding: " + JSON.stringify(response.mock.calls),
          );
        }),
      ]);
      if (revocation === "disconnect") {
        connected = false;
      } else if (revocation === "profile-switch") {
        client.authenticatedUserProfile!.profileId = ensureProfileForEmail("other@example.test").id;
      } else {
        client.connect.scopes = ["operator.read"];
      }
      release(normalized);
      const response = await pending;
      expect(response.mock.calls[0]?.[0]).toBe(false);
      expect(await getUserBackground(owner)).toEqual({
        status: "ok",
        asset: null,
        preference: null,
      });
      expect(broadcast).not.toHaveBeenCalled();
    },
  );

  it("requires durable identity and rejects client-supplied ownership", async () => {
    expect(
      (await rpc("users.background.get", { profileId: "someone-else" })).mock.calls[0]?.[0],
    ).toBe(false);
    client.authenticatedUserProfile = undefined;
    expect(await rpc("users.background.get")).toHaveBeenCalledWith(true, {
      status: "no_durable_identity",
    });
  });
});
