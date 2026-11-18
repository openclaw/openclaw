import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { normalizeUserBackgroundImage } from "../../state/user-background-image.js";
import { getUserBackground } from "../../state/user-background.js";
import { prepareUserProfileCatalog } from "../../state/user-profile-list.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { chatRpc } from "./chat-rpc-fixture.test-support.js";
import { holdPushStorage as holdAsyncBoundary } from "./push.test-support.js";
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
beforeEach(async () => {
  vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("background-rpc-"));
  const profile = ensureProfileForEmail("reader@example.test");
  const releaseProfileCatalog = (await prepareUserProfileCatalog()).release;
  client = createSessionMutationTestClient(profile.id);
  delete client.authenticatedUserId;
  client.connId = "background-client";
  client.connect.scopes = ["operator.read", "operator.write"];
  connected = true;
  broadcast = vi.fn();
  context = {
    getRuntimeConfig: () => ({}),
    getClientConnIds: (filter?: (client: GatewayClient) => boolean) =>
      new Set(connected && (!filter || filter(client)) ? [client.connId!] : []),
    broadcastToConnIds: broadcast,
  } as unknown as GatewayRequestContext;
  vi.mocked(normalizeUserBackgroundImage).mockReset().mockResolvedValue(normalized);
  return () => {
    releaseProfileCatalog();
    closeOpenClawStateDatabaseForTest();
    vi.unstubAllEnvs();
  };
});
const rpc = (operation: string, params: Record<string, unknown> = {}) =>
  chatRpc(context, client, `users.background.${operation}`, params);

it("allows ordinary profile read/write scopes and emits only a profile-targeted invalidation", async () => {
  expect(await rpc("upload", { ...empty, imageBase64: "dGVzdA==" })).toMatchObject([
    true,
    {
      status: "ok",
      asset: { mime: "image/jpeg" },
      preference: { showInSessions: false },
    },
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
    const decoding = holdAsyncBoundary();
    vi.mocked(normalizeUserBackgroundImage).mockImplementationOnce(async () => {
      await decoding.wait();
      return normalized;
    });
    const pending = rpc("upload", { ...empty, imageBase64: "dGVzdA==" });
    const response = await decoding.settle(pending, () => {
      if (revocation === "disconnect") {
        connected = false;
      } else if (revocation === "profile-switch") {
        client.authenticatedUserProfile!.profileId = ensureProfileForEmail("other@example.test").id;
      } else {
        client.connect.scopes = ["operator.read"];
      }
    });
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
