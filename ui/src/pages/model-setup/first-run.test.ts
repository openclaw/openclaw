import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { routeIdFromPath } from "../../app-routes.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { persistFirstRunActivationReceipt } from "./first-run-activation-receipt.ts";
import { isDefaultChatLanding, startModelSetupFirstRunRedirectAfterLocation } from "./first-run.ts";

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

function createConnectedContext(
  options: {
    selectedId?: string | null;
    modelConfigured?: boolean;
    admin?: boolean;
    stopped?: boolean;
  } = {},
) {
  const request = vi.fn();
  const replace = vi.fn();
  const subscribe = vi.fn(() => () => undefined);
  const snapshot = {
    phase: options.stopped ? "stopped" : "connected",
    client: options.stopped ? null : { request },
    hello: options.stopped
      ? null
      : {
          auth: {
            role: "operator",
            scopes: [options.admin === false ? "operator.read" : "operator.admin"],
          },
          features: { methods: ["openclaw.setup.detect"] },
          snapshot: {
            sessionDefaults: {
              defaultAgentId: "main",
              modelConfigured: options.modelConfigured ?? false,
            },
          },
        },
  };
  const context = {
    gateway: {
      snapshot,
      connection: {
        gatewayUrl: "wss://gateway.example",
        token: "gateway-auth-token",
        password: "",
        bootstrapToken: "",
      },
      subscribe,
    },
    agentSelection: {
      state: { selectedId: options.selectedId === undefined ? "main" : options.selectedId },
    },
    replace,
  } as unknown as ApplicationContext;
  return { context, replace, request, subscribe };
}

describe("model setup first-run redirect", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
    localStorage.setItem(
      "openclaw-device-identity-v1",
      JSON.stringify({ version: 1, privateKey: "durable-device-private-key-for-testing" }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("recognizes default chat landings without accepting session deep links", () => {
    const cases = [
      ["/", "", "", "", true],
      ["/chat", "", "", "", true],
      ["/chat", "?session=agent%3Amain%3Amain", "", "", false],
      ["/chat", "", "#session=agent%3Amain%3Amain", "", false],
      ["/chat/main", "", "", "", true],
      ["/chat/main/", "", "", "", true],
      ["/openclaw/chat/main", "", "", "/openclaw", true],
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
    persistFirstRunActivationReceipt(context, {
      kind: "openai-api-key",
      modelRef: "openai/expected",
    });

    const decision = createDeferred();
    const dispose = await startRedirect(context, decision.resolve);

    await decision.promise;
    expect(replace).toHaveBeenCalledWith("model-setup", { search: "?firstRun=1" });
    dispose();
  });
});
