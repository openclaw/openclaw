import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { normalizeUserBackgroundImage } from "../../state/user-background-image.js";
import { getUserBackground } from "../../state/user-background.js";
import { prepareUserProfileCatalog } from "../../state/user-profile-list.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { handleGatewayRequest } from "../server-methods.js";
import { createSessionMutationTestClient } from "./sessions-mutations.owner.test-support.js";
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
let releaseProfileCatalog: (() => void) | undefined;
beforeEach(async () => {
  vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("background-rpc-"));
  const profile = ensureProfileForEmail("reader@example.test");
  releaseProfileCatalog = (await prepareUserProfileCatalog()).release;
  client = createSessionMutationTestClient(profile.id);
  delete client.authenticatedUserId;
  client.connId = "background-client";
  client.authenticatedUserProfile!.displayName = null;
  client.authenticatedUserProfile!.updatedAt = profile.updatedAt;
  client.connect.scopes = ["operator.read", "operator.write"];
  client.connect.client = { id: "test", mode: "test", version: "1", platform: "test" };
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
  releaseProfileCatalog?.();
  releaseProfileCatalog = undefined;
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
});
async function rpc(operation: string, params: Record<string, unknown> = {}) {
  const method = `users.background.${operation}`;
  const respond = vi.fn();
  await handleGatewayRequest({
    req: { type: "req", id: method, method, params },
    client,
    context,
    respond,
    isWebchatConnect: () => false,
  });
  expect(respond).toHaveBeenCalledOnce();
  return respond.mock.calls[0]!;
}

describe("registered private background methods", () => {
  it("allows ordinary profile read/write scopes and emits only a profile-targeted invalidation", async () => {
    expect(await rpc("upload", { ...empty, imageBase64: "dGVzdA==" })).toEqual([
      true,
      expect.objectContaining({
        status: "ok",
        asset: expect.objectContaining({ mime: "image/jpeg" }),
        preference: expect.objectContaining({ showInSessions: false }),
      }),
    ]);
    expect(broadcast).toHaveBeenCalledWith(
      "users.prefs.changed",
      { profileId: client.authenticatedUserProfile!.profileId, keys: ["ui.background"] },
      new Set([client.connId]),
    );
    client.connect.scopes = ["operator.read"];
    expect(await rpc("get")).toEqual([true, expect.objectContaining({ status: "ok" })]);
    expect((await rpc("remove", empty))[0]).toBe(false);
  });

  it.each(["disconnect", "profile-switch", "revoke-write"])(
    "refuses a pending decode after %s",
    async (revocation) => {
      const owner = client.authenticatedUserProfile!.profileId;
      const decoding = createDeferred();
      const decoded = createDeferred<typeof normalized>();
      vi.mocked(normalizeUserBackgroundImage).mockImplementationOnce(() => {
        decoding.resolve();
        return decoded.promise;
      });
      const pending = rpc("upload", { ...empty, imageBase64: "dGVzdA==" });
      await awaitGateBeforeSettlement(decoding.promise, pending, "Upload finished before decoding");
      if (revocation === "disconnect") {
        connected = false;
      } else if (revocation === "profile-switch") {
        client.authenticatedUserProfile!.profileId = ensureProfileForEmail("other@example.test").id;
      } else {
        client.connect.scopes = ["operator.read"];
      }
      decoded.resolve(normalized);
      const response = await pending;
      expect(response[0]).toBe(false);
      expect(await getUserBackground(owner)).toEqual({
        status: "ok",
        asset: null,
        preference: null,
      });
      expect(broadcast).not.toHaveBeenCalled();
    },
  );

  it("requires durable identity and rejects client-supplied ownership", async () => {
    expect((await rpc("get", { profileId: "someone-else" }))[0]).toBe(false);
    client.authenticatedUserProfile = undefined;
    expect(await rpc("get")).toEqual([true, { status: "no_durable_identity" }]);
  });
});
