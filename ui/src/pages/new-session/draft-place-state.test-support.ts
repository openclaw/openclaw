import { vi } from "vitest";
import type { ModelCatalogEntry } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import type { DraftGatewayState } from "./draft-gateway-state.ts";
import { DraftPlaceBrowser } from "./draft-place-browser.ts";
import { DraftPlaceState } from "./draft-place-state.ts";
import type { NewSessionRouteData } from "./location.ts";
import type { NewSessionPreference } from "./preferences.ts";
import { TestReactiveControllerHost } from "./reactive-controller-host.test-support.ts";

export function createRepositoryFixture(
  options: {
    workspaceGit?: boolean;
    unavailable?: boolean;
    data?: NewSessionRouteData;
    models?: ModelCatalogEntry[];
    cloudProfiles?: DraftGatewayState["cloudProfiles"];
  } = {},
) {
  const requestUpdate = vi.fn();
  const persistPreference = vi.fn();
  const readPreference = vi.fn<() => NewSessionPreference>(() => ({ worktree: true }));
  const request = vi.fn<(method: string) => Promise<unknown>>(async (method) =>
    method === "fs.listDir"
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
          request: async (method: string) =>
            method === "models.list" ? { models: options.models ?? [] } : request(method),
        },
        hello: { auth: { role: "operator", scopes: ["operator.admin"] } },
      },
    },
    agents: {
      state: {
        agentsList: {
          defaultId: "main",
          agents: [
            { id: "main", workspace: "/workspace", workspaceGit: options.workspaceGit ?? false },
          ],
        },
      },
    },
    sessions: { state: { result: null } },
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
  const browser = new DraftPlaceBrowser(
    new TestReactiveControllerHost(),
    gateway,
    () => ({ context, isAdmin: true }),
    {
      requestUpdate,
      onProjectMissing: vi.fn(),
      onSelectProject: vi.fn(),
      onApprovedListing: vi.fn(),
      querySelector: () => null,
      activeElement: () => null,
      body: () => null,
    },
  );
  const state = new DraftPlaceState(
    gateway,
    browser,
    () => ({ context, data: options.data, submitting: false, pendingPlacementSessionKey: "" }),
    { requestUpdate, onError: vi.fn(), onClearError: vi.fn() },
  );
  return { state, browser, context, persistPreference, readPreference, request, requestUpdate };
}
