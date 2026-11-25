import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  listenLoopback,
  closeHttpServer,
} from "../../test/helpers/gateway-integration-fixtures.js";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { getRuntimeConfig } from "../config/io.js";
import { approveDevicePairing } from "../infra/device-pairing-approval.js";
import { ensureDeviceToken } from "../infra/device-pairing-tokens.js";
import { requestDevicePairing } from "../infra/device-pairing.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { uploadUserBackground } from "../state/user-background.js";
import { ensureGatewayOwnerProfile } from "../state/user-profiles.js";
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

beforeEach(() => {
  profileWait.mockReset().mockResolvedValue(undefined);
  imageWait.mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
});

it.each([
  ...(["unchanged", "origin-revoked"] as const).map((change) => ({
    change,
    stage: "profile resolution" as const,
  })),
  { change: "unchanged" as const, stage: "image preparation" as const },
])(
  "registered background HTTP read rechecks $change authority after $stage",
  async ({ change, stage }) => {
    vi.stubEnv("OPENCLAW_STATE_DIR", directories.make("background-device-authority-"));
    const currentAuth = AUTH_TOKEN;
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
      if (change === "origin-revoked") {
        allowedOrigins = [];
      }
      gate.release();
      const result = await response;
      // Explicit credentials still authorize the HTTP owner; CORS controls
      // whether the browser may expose that response to the requesting origin.
      if (change === "origin-revoked") {
        expect(result.headers.get("access-control-allow-origin")).toBeNull();
        expect(result.headers.get("access-control-allow-credentials")).toBeNull();
      }
      expect(result.status).toBe(200);
      expect(new Uint8Array(await result.arrayBuffer())).toEqual(imageBytes);
      if (stage === "image preparation") {
        expect(imageWait).toHaveBeenCalledOnce();
      }
    } finally {
      gate.release();
      await closeHttpServer(server);
    }
  },
);
