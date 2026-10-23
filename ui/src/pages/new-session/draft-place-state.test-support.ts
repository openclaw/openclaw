import { vi } from "vitest";
import type { ModelCatalogEntry } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import type { DraftGatewayState } from "./draft-gateway-state.ts";
import { DraftPlaceBrowser } from "./draft-place-browser.ts";
import { DraftPlaceState } from "./draft-place-state.ts";
import type { NewSessionRouteData } from "./location.ts";
import type { NewSessionPreference } from "./preferences.ts";

export function createRepositoryFixture(
  options: {
    workspaceGit?: boolean;
    unavailable?: boolean;
    data?: NewSessionRouteData;
    models?: ModelCatalogEntry[];
    cloudProfiles?: DraftGatewayState["cloudProfiles"];
  } = {},
) {
  const changed = vi.fn();
  const persistPreference = vi.fn();
  const readPreference = vi.fn<() => NewSessionPreference>(() => ({ worktree: true }));
  const request = vi.fn<(method: string, params?: Record<string, unknown>) => Promise<unknown>>(
    async (method) =>
      method === "projects.checkoutOptions"
        ? { current: !options.unavailable, worktree: !options.unavailable }
        : method === "fs.listDir"
          ? { path: "/plain", entries: [] }
          : { repositoryStatus: options.unavailable ? "unavailable" : "not_git", branches: [] },
  );
  const context = {
    gateway: {
      connection: { gatewayUrl: "ws://gateway.example" },
      subscribe: () => () => undefined,
      subscribeEvents: () => () => undefined,
      snapshot: {
        phase: "connected",
        client: {
          request: (method: string, params?: Record<string, unknown>) =>
            method === "models.list"
              ? Promise.resolve({ models: options.models ?? [] })
              : request(method, params),
        },
        hello: { auth: { role: "operator", scopes: ["operator.admin"] } },
      },
    },
    agents: {
      subscribe: () => () => undefined,
      state: {
        agentsList: {
          defaultId: "main",
          agents: [
            { id: "main", workspace: "/workspace", workspaceGit: options.workspaceGit ?? false },
          ],
        },
      },
    },
    sessions: { subscribe: () => () => undefined, state: { result: null } },
    config: { subscribe: () => () => undefined, current: {} },
  } as unknown as ApplicationContext;
  const gateway = {
    cloudProfiles: options.cloudProfiles ?? [{ id: "aws", providerId: "crabbox" }],
    cloudProfilesReady: true,
    environments: [
      {
        id: "node:desktop",
        type: "node",
        status: "available",
        sessionHost: true,
        workerSlots: { total: 1, available: 1 },
      },
    ],
    persistPreference,
    readPreference,
  } as unknown as DraftGatewayState;
  const browser = new DraftPlaceBrowser(gateway, () => ({ context, isAdmin: true }), {
    changed,
    updateComplete: () => Promise.resolve(),
    onProjectMissing: vi.fn(),
    onSelectProject: vi.fn(),
    onApprovedListing: vi.fn(),
    activeElement: () => null,
  });
  const state = new DraftPlaceState(
    gateway,
    browser,
    () => ({ context, data: options.data, submitting: false, pendingPlacementSessionKey: "" }),
    { changed, onError: vi.fn(), onClearError: vi.fn() },
  );
  return {
    state,
    browser,
    context,
    gateway,
    persistPreference,
    readPreference,
    request,
    changed,
  };
}
