import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { routeIdFromPath } from "../../app-routes.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import {
  clearFirstRunActivationReceipt,
  persistFirstRunActivationReceipt,
  readFirstRunActivationReceipt as readReceipt,
} from "./first-run-activation-receipt.ts";
import { isDefaultChatLanding, startModelSetupFirstRunRedirectAfterLocation } from "./first-run.ts";

const receiptKey = "openclaw.modelSetup.pendingActivation.v1";
const deviceKey = "openclaw-device-identity-v1";
const privateKey = "high-entropy-device-private-key-never-in-receipts";
const candidate = { kind: "openai-api-key", modelRef: "openai/expected" };
const setDeviceKey = (key: string) =>
  localStorage.setItem(deviceKey, JSON.stringify({ version: 1, privateKey: key }));

const defaultLanding = { pathname: "/chat/main", search: "", hash: "" };

function startRedirect(context: ApplicationContext, onInitialDecision?: () => void) {
  return startModelSetupFirstRunRedirectAfterLocation({
    context,
    enabled: true,
    history: { location: () => defaultLanding, replace: () => undefined },
    initialLocationReady: Promise.resolve(defaultLanding),
    onInitialDecision,
  });
}

function createConnectedContext({
  selectedId = "main",
  modelConfigured = false,
  admin = true,
  stopped = false,
  token = "gateway-auth-token",
  deviceToken,
}: {
  selectedId?: string | null;
  modelConfigured?: boolean;
  admin?: boolean;
  stopped?: boolean;
  token?: string;
  deviceToken?: string;
} = {}) {
  const request = vi.fn();
  const replace = vi.fn();
  const subscribe = vi.fn(() => () => undefined);
  const context = {
    gateway: {
      snapshot: {
        phase: stopped ? "stopped" : "connected",
        client: stopped ? null : { request },
        hello: stopped
          ? null
          : {
              auth: {
                role: "operator",
                scopes: [admin ? "operator.admin" : "operator.read"],
                deviceToken,
              },
              features: { methods: ["openclaw.setup.detect"] },
              snapshot: { sessionDefaults: { defaultAgentId: "main", modelConfigured } },
            },
      },
      connection: {
        gatewayUrl: "wss://gateway.example/control?profile=work",
        token,
        password: "",
        bootstrapToken: "",
      },
      subscribe,
    },
    agentSelection: { state: { selectedId } },
    replace,
  } as unknown as ApplicationContext;
  return { context, replace, request, subscribe };
}

beforeEach(() => {
  vi.stubGlobal("localStorage", createStorageMock());
  setDeviceKey(privateKey);
});
afterEach(() => vi.unstubAllGlobals());

describe("model setup first-run redirect", () => {
  it("recognizes default chat landings without accepting session deep links", () => {
    const cases = [
      ["/", "", "", "", true],
      ["/chat", "", "", "", true],
      ["/chat", "?session=agent%3Amain%3Amain", "", "", false],
      ["/chat", "", "#session=agent%3Amain%3Amain", "", false],
      ["/chat/main/", "", "", "", true],
      ["/openclaw/chat/main/", "", "", "/openclaw", true],
      ["/chat/research", "", "", "", false],
      ["/chat/main/existing-session", "", "", "", false],
      ["/dashboard/main", "", "", "", false],
      ["/settings/appearance", "", "", "", false],
    ] as const;
    for (const [pathname, search, hash, basePath, expected] of cases) {
      expect(isDefaultChatLanding({ pathname, search, hash }, basePath, routeIdFromPath)).toBe(
        expected,
      );
    }
  });

  it("installs a released session deep link without registering the first-run gate", async () => {
    const releasedLocation = {
      pathname: "/chat",
      search: "?session=agent%3Aresearch%3Atelegram%3A12345",
      hash: "",
    };
    const canonicalLocation = { ...defaultLanding, pathname: "/chat/research/telegram/12345" };
    let currentLocation = releasedLocation;
    const replaceLocation = vi.fn((location: typeof releasedLocation) => {
      currentLocation = location;
    });
    const { context, replace: replaceRoute, subscribe } = createConnectedContext();

    await startModelSetupFirstRunRedirectAfterLocation({
      context,
      enabled: isDefaultChatLanding(releasedLocation, "", routeIdFromPath),
      history: { location: () => currentLocation, replace: replaceLocation },
      initialLocationReady: Promise.resolve(canonicalLocation),
    });

    expect(replaceLocation).toHaveBeenCalledWith(canonicalLocation);
    expect(subscribe).not.toHaveBeenCalled();
    expect(replaceRoute).not.toHaveBeenCalled();
  });

  it.each([
    ["agent selection is unset", { selectedId: null }, true],
    ["the operator lacks admin access", { admin: false }, false],
    ["the initial connection stopped", { stopped: true }, false],
  ] as const)("decides synchronously when %s", async (_name, options, shouldRedirect) => {
    const { context, replace, request } = createConnectedContext(options);

    const onInitialDecision = vi.fn();
    const dispose = await startRedirect(context, onInitialDecision);

    expect(request).not.toHaveBeenCalled();
    expect(onInitialDecision).toHaveBeenCalledOnce();
    expect(replace).toHaveBeenCalledTimes(shouldRedirect ? 1 : 0);
    if (shouldRedirect) {
      expect(replace).toHaveBeenCalledWith("model-setup", { search: "?firstRun=1" });
    }
    dispose();
  });

  it("restores unfinished onboarding after its activation already configured the model", async () => {
    const { context, replace } = createConnectedContext({ modelConfigured: true });
    persistFirstRunActivationReceipt(context, candidate);

    const decision = createDeferred();
    const dispose = await startRedirect(context, decision.resolve);

    await decision.promise;
    expect(replace).toHaveBeenCalledWith("model-setup", { search: "?firstRun=1" });
    dispose();
  });
});

function tamperReceipt(patch: object) {
  const receipt = JSON.parse(localStorage.getItem(receiptKey)!);
  localStorage.setItem(receiptKey, JSON.stringify({ ...receipt, ...patch }));
}
it.each<[string, (context: ApplicationContext) => void]>([
  ["Gateway token", (ctx) => Object.assign(ctx.gateway.connection, { token: "replacement" })],
  ["Gateway URL", (ctx) => Object.assign(ctx.gateway.connection, { gatewayUrl: "wss://other" })],
  ["selected agent", (ctx) => Object.assign(ctx.agentSelection.state, { selectedId: "research" })],
  ["browser device identity", () => setDeviceKey("replacement")],
  ["role", () => tamperReceipt({ modelTarget: "utility" })],
  ["wizard", () => tamperReceipt({ wizard: { sessionId: "replacement", authChoice: "other" } })],
])("rejects a receipt after its %s changes", (_name, replace) => {
  const { context } = createConnectedContext();
  persistFirstRunActivationReceipt(context, {
    kind: "provider-auth",
    modelRef: "openai/expected",
    wizard: { sessionId: "original", authChoice: "custom-api-key", authKind: "secret" },
  });
  replace(context);
  expect([readReceipt(context), localStorage.getItem(receiptKey)]).toEqual([null, null]);
});

it("binds paired-device authentication when no explicit Gateway credential exists", () => {
  const { context } = createConnectedContext({ token: "", deviceToken: "paired-device-token" });
  persistFirstRunActivationReceipt(context, candidate);

  const persisted = localStorage.getItem(receiptKey) ?? "";
  expect(persisted).not.toContain("paired-device-token");
  expect(persisted).not.toContain(privateKey);
  expect(readReceipt(context)?.modelRef).toBe("openai/expected");
  context.gateway.snapshot.hello!.auth!.deviceToken = "replacement-device-token";

  expect([readReceipt(context), localStorage.getItem(receiptKey)]).toEqual([null, null]);
});

it("fails closed without durable storage, a persisted device key, or authenticated credentials", () => {
  const { context } = createConnectedContext({ token: "" });

  expect(persistFirstRunActivationReceipt(context, candidate)).toBeNull();

  context.gateway.connection.token = "gateway-auth-token";
  localStorage.removeItem(deviceKey);
  expect(persistFirstRunActivationReceipt(context, candidate)).toBeNull();

  const unavailable = () => {
    throw new Error("Browser storage disabled");
  };
  vi.stubGlobal("localStorage", {
    getItem: unavailable,
    setItem: unavailable,
    removeItem: unavailable,
  });
  expect(persistFirstRunActivationReceipt(context, candidate)).toBeNull();
  expect(readReceipt(context)).toBeNull();
  expect(() => clearFirstRunActivationReceipt()).not.toThrow();
});
