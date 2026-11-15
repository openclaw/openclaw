import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  listenLoopback,
  closeHttpServer,
} from "../../test/helpers/gateway-integration-fixtures.js";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { getRuntimeConfig } from "../config/io.js";
import type { GatewayOperatorRoleDefinition } from "../config/types.gateway.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { approveDevicePairing } from "../infra/device-pairing-approval.js";
import { ensureDeviceToken, revokeDeviceToken } from "../infra/device-pairing-tokens.js";
import { requestDevicePairing, withPairedDeviceRecords } from "../infra/device-pairing.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { normalizeUserBackgroundImage } from "../state/user-background-image.js";
import { getUserBackground, uploadUserBackground } from "../state/user-background.js";
import { linkCanonicalUserProfileEmail } from "../state/user-profile-writes.js";
import { ensureGatewayOwnerProfile, ensureProfileForEmail } from "../state/user-profiles.js";
import { AUTH_TOKEN, createTestGatewayServer } from "./server-http.test-harness.js";
import { resolveSharedGatewaySessionGeneration } from "./server/ws-shared-generation.js";

const profileWait = vi.hoisted(() => vi.fn<() => Promise<void>>());
const imageWait = vi.hoisted(() => vi.fn<(image: Uint8Array | undefined) => Promise<void>>());
// Hold the actual prepared bytes, not a fabricated authorization or reader result.
vi.mock("../state/user-background.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../state/user-background.js")>();
  return {
    ...actual,
    getUserBackgroundImage: async (...args: Parameters<typeof actual.getUserBackgroundImage>) => {
      const prepared = await actual.getUserBackgroundImage(...args);
      await imageWait(prepared.image);
      return prepared;
    },
  };
});
// Keep actual credential/profile authorization; delay only its asynchronous attribution stage.
vi.mock("./http-auth-user-profile.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./http-auth-user-profile.js")>();
  return {
    ...actual,
    checkAuthenticatedHttpUserProfile: async (
      ...args: Parameters<typeof actual.checkAuthenticatedHttpUserProfile>
    ) => {
      const profile = await actual.checkAuthenticatedHttpUserProfile(...args);
      await profileWait();
      return profile;
    },
  };
});
vi.mock("../config/io.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/io.js")>()),
  getRuntimeConfig: vi.fn(() => ({})),
}));
vi.mock("../state/user-background-image.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/user-background-image.js")>()),
  normalizeUserBackgroundImage: vi.fn(async () => ({
    image: Buffer.from([255, 216, 255, 217]),
    width: 1,
    height: 1,
  })),
}));
const directories = useAutoCleanupTempDirTracker(afterEach);
const imageBytes = new Uint8Array([255, 216, 255, 217]);

async function upload(profileId: string, imageBase64 = "fixture") {
  const result = await uploadUserBackground(profileId, {
    expectedAssetId: null,
    expectedPreference: null,
    imageBase64,
  });
  if (result.status !== "ok" || !result.asset) {
    throw new Error("Missing background fixture");
  }
  return result.asset;
}

function holdRead(imageStage: boolean) {
  const entered = createDeferred();
  const release = createDeferred();
  const hold = async () => {
    entered.resolve();
    await release.promise;
  };
  if (imageStage) {
    imageWait.mockImplementation(async (image) => {
      expect(image).toEqual(imageBytes);
      await hold();
    });
  } else {
    profileWait.mockImplementation(hold);
  }
  return {
    release: release.resolve,
    wait: (response: Promise<Response>) =>
      awaitGateBeforeSettlement(
        entered.promise,
        response,
        "Read finished before authority barrier",
      ),
  };
}

async function startServer(
  auth: Parameters<typeof createTestGatewayServer>[0]["resolvedAuth"],
  getResolvedAuth = () => auth,
) {
  const server = createTestGatewayServer({
    resolvedAuth: auth,
    overrides: { controlUiBasePath: "/control", getResolvedAuth, getRuntimeConfig },
  });
  return { server, origin: await listenLoopback(server) };
}

async function expectPrivateBytesWithheld(response: Response) {
  expect(response.status).toBe(401);
  expect(response.headers.get("content-type")).not.toMatch(/^image\//);
  const bytes = new Uint8Array(await response.arrayBuffer());
  expect(bytes).not.toEqual(imageBytes);
  return bytes;
}
beforeEach(() => {
  profileWait.mockReset().mockResolvedValue(undefined);
  imageWait.mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
});

it.each([
  ...(["unchanged", "revoked", "scope-reduced", "gateway-rotated", "origin-revoked"] as const).map(
    (change) => ({ change, stage: "profile resolution" as const }),
  ),
  ...(["unchanged", "revoked"] as const).map((change) => ({
    change,
    stage: "image preparation" as const,
  })),
])(
  "registered background HTTP read rechecks $change authority after $stage",
  async ({ change, stage }) => {
    vi.stubEnv("OPENCLAW_STATE_DIR", directories.make("background-device-authority-"));
    let currentAuth = AUTH_TOKEN;
    let allowedOrigins = ["https://control.example.test"];
    vi.mocked(getRuntimeConfig).mockImplementation(() => ({
      gateway: { auth: currentAuth, trustedProxies: [], controlUi: { allowedOrigins } },
    }));
    const profile = ensureGatewayOwnerProfile("Background owner");
    const asset = await upload(profile.id);
    const request = await requestDevicePairing({
      deviceId: "background-reader",
      publicKey: "fixture-key",
      role: "operator",
      scopes: ["operator.read"],
      clientId: "openclaw-control-ui",
      clientMode: "webchat",
    });
    await approveDevicePairing(request.request.requestId, { callerScopes: ["operator.read"] });
    const token = await ensureDeviceToken({
      deviceId: "background-reader",
      role: "operator",
      scopes: ["operator.read"],
      issuer: {
        kind: "shared-gateway-auth",
        generation: resolveSharedGatewaySessionGeneration(currentAuth, [])!,
      },
    });
    if (!token) {
      throw new Error("Missing paired credential fixture");
    }
    const gate = holdRead(stage === "image preparation");
    const { server, origin } = await startServer(currentAuth, () => currentAuth);
    try {
      const response = fetch(origin + "/control/__openclaw__/users/background/" + asset.assetId, {
        headers: {
          Authorization: "Bearer " + token.token,
          Origin: change === "origin-revoked" ? "https://control.example.test" : origin,
        },
      });
      await gate.wait(response);
      if (change === "revoked") {
        await revokeDeviceToken({ deviceId: "background-reader", role: "operator" });
      } else if (change === "scope-reduced") {
        // Narrow through the canonical locked store without changing the token bytes.
        await withPairedDeviceRecords(undefined, (records) => {
          const grant = records["background-reader"]?.tokens?.operator;
          if (!grant) {
            throw new Error("Missing admitted grant");
          }
          grant.scopes = [];
          return { value: undefined, persist: true };
        });
      } else if (change === "origin-revoked") {
        allowedOrigins = [];
      } else if (change === "gateway-rotated") {
        currentAuth = { ...AUTH_TOKEN, token: "rotated-fixture-secret" };
      }
      gate.release();
      const result = await response;
      // Explicit credentials still authorize the HTTP owner; CORS controls
      // whether the browser may expose that response to the requesting origin.
      if (change === "origin-revoked") {
        expect(result.headers.get("access-control-allow-origin")).toBeNull();
        expect(result.headers.get("access-control-allow-credentials")).toBeNull();
      }
      if (change === "unchanged" || change === "origin-revoked") {
        expect(result.status).toBe(200);
        expect(new Uint8Array(await result.arrayBuffer())).toEqual(imageBytes);
      } else {
        await expectPrivateBytesWithheld(result);
      }
      if (stage === "image preparation") {
        expect(imageWait).toHaveBeenCalledOnce();
      }
    } finally {
      gate.release();
      await closeHttpServer(server);
    }
  },
);

it.each(["role-reduced", "profile-reassigned"] as const)(
  "registered background read withholds private bytes after %s",
  async (change) => {
    vi.stubEnv("OPENCLAW_STATE_DIR", directories.make("background-role-authority-"));
    const auth = {
      mode: "trusted-proxy" as const,
      allowTailscale: false,
      trustedProxy: {
        userHeader: "x-forwarded-user",
        requiredHeaders: ["x-forwarded-proto"],
        allowLoopback: true,
      },
    };
    const reader: GatewayOperatorRoleDefinition = {
      agents: "*" as const,
      sessions: { others: "view" as const },
      scopes: ["operator.read"],
    };
    let config: OpenClawConfig = {
      gateway: {
        auth,
        trustedProxies: ["127.0.0.1"],
        controlUi: { allowedOrigins: ["https://control.example.test"] },
        roles: { default: "reader", definitions: { reader } },
      },
    };
    vi.mocked(getRuntimeConfig).mockImplementation(() => config);
    const profile = ensureProfileForEmail("reader@example.test");
    const asset = await upload(profile.id);
    const foreignBytes = Buffer.from([255, 216, 17, 217]);
    const replacement =
      change === "profile-reassigned"
        ? ensureProfileForEmail("replacement@example.test")
        : undefined;
    let foreignAssetId: string | undefined;
    if (replacement) {
      vi.mocked(normalizeUserBackgroundImage).mockResolvedValueOnce({
        image: foreignBytes,
        width: 1,
        height: 1,
      });
      foreignAssetId = (await upload(replacement.id, "foreign-fixture")).assetId;
    }
    const gate = holdRead(change === "profile-reassigned");
    const { server, origin } = await startServer(auth);
    try {
      const response = fetch(origin + "/control/__openclaw__/users/background/" + asset.assetId, {
        headers: {
          "x-forwarded-for": "198.51.100.23",
          "x-forwarded-user": "reader@example.test",
          "x-forwarded-proto": "https",
          "x-openclaw-scopes": "operator.read",
          Origin: "https://control.example.test",
        },
      });
      await gate.wait(response);
      if (replacement) {
        const reassigned = await linkCanonicalUserProfileEmail(
          "reader@example.test",
          replacement.id,
        );
        expect(reassigned.profile.id).toBe(replacement.id);
        const current = await getUserBackground(profile.id);
        expect(current).toMatchObject({ status: "ok", asset: { assetId: foreignAssetId } });
      } else {
        config = {
          gateway: {
            ...config.gateway,
            roles: { default: "reader", definitions: { reader: { ...reader, scopes: [] } } },
          },
        };
      }
      gate.release();
      const result = await response;
      expect(await expectPrivateBytesWithheld(result)).not.toEqual(new Uint8Array(foreignBytes));
      expect(replacement ? imageWait : profileWait).toHaveBeenCalledOnce();
    } finally {
      gate.release();
      await closeHttpServer(server);
    }
  },
);
