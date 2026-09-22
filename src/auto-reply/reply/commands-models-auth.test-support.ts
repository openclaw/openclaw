import { vi } from "vitest";
import type { ModelAuthAvailabilityEvaluation } from "../../agents/model-auth-availability.js";
import type { ModelCatalogEntry } from "../../agents/model-catalog.types.js";

const modelProviderAuthMocks = vi.hoisted(() => {
  const state = {
    authenticatedProviders: new Set(["anthropic", "google", "openai"]),
    availabilityUnknown: false,
    unavailableReason: "missing-auth" as ModelAuthAvailabilityEvaluation["unavailableReason"],
    createProviderAuthChecker: vi.fn(),
    runtimeChoices: new Map<string, string[] | undefined>(),
    selectedRoute: undefined as
      | {
          api: "openai-responses" | "openai-chatgpt-responses";
          baseUrl: string;
          authRequirement: "api-key" | "subscription";
          requestTransportOverrides: "none" | "present";
        }
      | undefined,
  };
  state.createProviderAuthChecker.mockImplementation(() => {
    type AuthRef = {
      api?: string | null;
      baseUrl?: unknown;
      observedRoutes?: readonly { api?: string | null; baseUrl?: unknown }[];
    };
    const hasConflictingRoute = (ref?: AuthRef) => {
      const routes = ref?.observedRoutes ?? [];
      return [ref, ...routes].some(
        (route) =>
          route?.api === "openai-chatgpt-responses" &&
          route.baseUrl === "https://api.openai.com/v1",
      );
    };
    const checker = vi.fn((provider: string, ref?: AuthRef) => {
      return state.authenticatedProviders.has(provider) && !hasConflictingRoute(ref);
    });
    return Object.assign(checker, {
      evaluateModelAuth: vi.fn(async (provider: string, ref?: AuthRef) => {
        const incompatible = hasConflictingRoute(ref);
        return {
          availability: state.availabilityUnknown ? undefined : checker(provider, ref),
          unavailableReason:
            state.availabilityUnknown || checker(provider, ref)
              ? undefined
              : state.unavailableReason,
          routeResolution: incompatible
            ? {
                kind: "incompatible" as const,
                code: "conflicting-route-facts",
                message: "Conflicting OpenAI route facts.",
              }
            : state.selectedRoute
              ? { kind: "routes" as const, routes: [state.selectedRoute] as const }
              : null,
          ...(state.selectedRoute ? { selectedRoute: state.selectedRoute } : {}),
        };
      }),
    });
  });
  return state;
});

vi.mock("../../agents/model-provider-auth.js", () => ({
  createProviderAuthChecker: modelProviderAuthMocks.createProviderAuthChecker,
}));

vi.mock("../../agents/model-catalog-decisions.js", () => ({
  createModelCatalogDecisions: (
    params: import("../../agents/model-catalog-decisions.js").ModelCatalogDecisionParams,
  ) => {
    const checker = modelProviderAuthMocks.createProviderAuthChecker({
      ...params,
      allowPreparedRuntimeAuth: true,
      allowPluginSyntheticAuth: false,
      discoverExternalCliAuth: false,
    });
    return {
      snapshot: params.snapshot,
      authStore: params.preparedAuthStore,
      evaluateEntry: (entry: ModelCatalogEntry, variants: ModelCatalogEntry[] = [entry]) =>
        checker.evaluateModelAuth(entry.provider, {
          modelId: entry.id,
          observedRoutes: variants.map(({ api, baseUrl }) => ({ api, baseUrl })),
        }),
      evaluateNative: (_entry: ModelCatalogEntry, host: unknown) => host,
      runtimeChoices: async (entry: ModelCatalogEntry) =>
        modelProviderAuthMocks.runtimeChoices.get(entry.provider + "/" + entry.id),
      isCurrent: params.isCurrent,
    };
  },
}));

export { modelProviderAuthMocks };
