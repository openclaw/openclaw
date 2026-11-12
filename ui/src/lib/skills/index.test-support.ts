import { expectDefined } from "@openclaw/normalization-core";
import { vi } from "vitest";
import type { SkillsState } from "./index.ts";

export type TestRequest = (method: string, payload?: unknown) => Promise<unknown>;

export function createDeferredRequestQueue(request: ReturnType<typeof vi.fn<TestRequest>>) {
  const resolvers: Array<(value: unknown) => void> = [];
  request.mockImplementation(
    () =>
      new Promise((resolve) => {
        resolvers.push(resolve);
      }),
  );
  return {
    resolveNext(value: unknown) {
      resolvers.shift()?.(value);
    },
  };
}

export function createSkillsState(): {
  state: SkillsState;
  request: ReturnType<typeof vi.fn<TestRequest>>;
} {
  const request = vi.fn<TestRequest>();
  const state: SkillsState = {
    // SAFETY: These owner tests only exercise the browser client request transport.
    client: {
      request,
    } as unknown as SkillsState["client"],
    connected: true,
    runtimeConfig: {
      runExternalMutation: async (task) => {
        try {
          return {
            ok: true,
            value: await task(expectDefined(state.client, "connected skill mutation client")),
            refresh: { ok: true },
          };
        } catch (error) {
          return {
            ok: false,
            reason: "error",
            error: error instanceof Error ? error.message : String(error),
          };
        }
      },
    },
    skillsAgentId: "main",
    skillsAgentRevision: 0,
    skillsLoading: false,
    skillsReport: null,
    skillsError: null,
    skillsFilter: "",
    skillsStatusFilter: "all",
    skillsDetailKey: null,
    skillsDetailTab: "overview",
    skillOperation: null,
    skillEdits: {},
    skillMessages: {},
    clawhubSearchQuery: "github",
    clawhubSearchResults: [
      {
        score: 0.9,
        registry: "https://clawhub.ai",
        slug: "github",
        installRef: "@openclaw/github",
        displayName: "GitHub",
        summary: "Previous result",
        version: "1.0.0",
      },
    ],
    clawhubSearchLoading: false,
    clawhubSearchError: "old error",
    clawhubIconUrls: {},
    clawhubDetail: null,
    clawhubDetailRef: null,
    clawhubDetailLoading: false,
    clawhubDetailError: null,
    clawhubInstallMessage: null,
    clawhubVerdicts: {},
    clawhubVerdictsLoading: false,
    clawhubVerdictsError: null,
    skillCardContents: {},
    skillCardContentKeys: {},
    skillCardLoadingKey: null,
    skillCardErrors: {},
  };
  return { state, request };
}
