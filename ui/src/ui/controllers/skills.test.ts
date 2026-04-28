import { describe, expect, it, vi } from "vitest";
import {
  installSkill,
  loadClawHubDetail,
  saveSkillApiKey,
  searchClawHub,
  setClawHubSearchQuery,
  updateSkillEnabled,
  type SkillsState,
} from "./skills.ts";

function createState(): { state: SkillsState; request: ReturnType<typeof vi.fn> } {
  const request = vi.fn();
  const state: SkillsState = {
    client: {
      request,
    } as unknown as SkillsState["client"],
    connected: true,
    skillsLoading: false,
    skillsReport: null,
    skillsError: null,
    skillsBusyKey: null,
    skillEdits: {},
    skillMessages: {},
    clawhubSearchQuery: "github",
    clawhubSearchResults: [
      {
        score: 0.9,
        slug: "github",
        displayName: "GitHub",
        summary: "Previous result",
        version: "1.0.0",
      },
    ],
    clawhubSearchLoading: false,
    clawhubSearchError: "old error",
    clawhubDetail: null,
    clawhubDetailSlug: null,
    clawhubDetailLoading: false,
    clawhubDetailError: null,
    clawhubInstallSlug: null,
    clawhubInstallMessage: null,
  };
  return { state, request };
}

function createDeferredRequestQueue(request: ReturnType<typeof vi.fn>) {
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

function mockSkillMutationRequests(request: ReturnType<typeof vi.fn>, installMessage?: string) {
  request.mockImplementation(async (method: string) => {
    if (method === "skills.install" && installMessage) {
      return { message: installMessage };
    }
    return {};
  });
}

describe("searchClawHub", () => {
  it("clears stale query state immediately when the input changes", () => {
    const { state } = createState();

    state.clawhubSearchLoading = true;
    state.clawhubInstallMessage = { kind: "success", text: "Installed github" };

    setClawHubSearchQuery(state, "github app");

    expect(state.clawhubSearchQuery).toBe("github app");
    expect(state.clawhubSearchResults).toBeNull();
    expect(state.clawhubSearchError).toBeNull();
    expect(state.clawhubSearchLoading).toBe(false);
    expect(state.clawhubInstallMessage).toBeNull();
  });

  it("clears stale results as soon as a new search starts", async () => {
    const { state, request } = createState();
    type SearchResponse = { results: SkillsState["clawhubSearchResults"] };
    let resolveRequest: (value: SearchResponse) => void = () => {
      throw new Error("expected search request promise to be pending");
    };
    request.mockImplementation(
      () =>
        new Promise<SearchResponse>((resolve) => {
          resolveRequest = resolve;
        }),
    );

    const pending = searchClawHub(state, "github");

    expect(state.clawhubSearchResults).toBeNull();
    expect(state.clawhubSearchLoading).toBe(true);
    expect(state.clawhubSearchError).toBeNull();

    resolveRequest({
      results: [
        {
          score: 0.95,
          slug: "github-new",
          displayName: "GitHub New",
          summary: "Fresh result",
          version: "2.0.0",
        },
      ],
    });
    await pending;

    expect(state.clawhubSearchResults).toEqual([
      {
        score: 0.95,
        slug: "github-new",
        displayName: "GitHub New",
        summary: "Fresh result",
        version: "2.0.0",
      },
    ]);
    expect(state.clawhubSearchLoading).toBe(false);
  });

  it("clears stale results when the query is emptied", async () => {
    const { state, request } = createState();

    await searchClawHub(state, "   ");

    expect(request).not.toHaveBeenCalled();
    expect(state.clawhubSearchResults).toBeNull();
    expect(state.clawhubSearchError).toBeNull();
    expect(state.clawhubSearchLoading).toBe(false);
  });

  it("ignores stale search responses after query changes", async () => {
    const { state, request } = createState();
    const queue = createDeferredRequestQueue(request);

    const pending = searchClawHub(state, "github");
    setClawHubSearchQuery(state, "gitlab");
    queue.resolveNext({
      results: [{ score: 1, slug: "github", displayName: "GitHub" }],
    });
    await pending;

    expect(state.clawhubSearchQuery).toBe("gitlab");
    expect(state.clawhubSearchResults).toBeNull();
    expect(state.clawhubSearchError).toBeNull();
    expect(state.clawhubSearchLoading).toBe(false);
  });
});

describe("loadClawHubDetail", () => {
  it("ignores stale detail responses after slug changes", async () => {
    const { state, request } = createState();
    const queue = createDeferredRequestQueue(request);

    const firstPending = loadClawHubDetail(state, "github");
    const secondPending = loadClawHubDetail(state, "gitlab");

    queue.resolveNext({
      skill: { slug: "github", displayName: "GitHub", createdAt: 1, updatedAt: 2 },
    });
    await firstPending;

    queue.resolveNext({
      skill: { slug: "gitlab", displayName: "GitLab", createdAt: 3, updatedAt: 4 },
    });
    await secondPending;

    expect(state.clawhubDetailLoading).toBe(false);
    expect(state.clawhubDetail?.skill?.slug).toBe("gitlab");
  });
});

describe("skill mutations", () => {
  it.each([
    {
      name: "updates skill enablement and records a success message",
      run: (state: SkillsState) => updateSkillEnabled(state, "github", true),
      expectedRequest: ["skills.update", { skillKey: "github", enabled: true }],
      expectedMessage: "Skill enabled",
    },
    {
      name: "saves API keys and reports success",
      run: async (state: SkillsState) => {
        state.skillEdits.github = "sk-test";
        await saveSkillApiKey(state, "github");
      },
      expectedRequest: ["skills.update", { skillKey: "github", apiKey: "sk-test" }],
      expectedMessage: "API key saved — stored in openclaw.json (skills.entries.github)",
    },
    {
      name: "installs skills and uses server success messages",
      run: (state: SkillsState) => installSkill(state, "github", "GitHub", "install-123", true),
      expectedRequest: [
        "skills.install",
        {
          name: "GitHub",
          installId: "install-123",
          dangerouslyForceUnsafeInstall: true,
          timeoutMs: 120000,
        },
      ],
      expectedMessage: "Installed from registry",
      installMessage: "Installed from registry",
    },
  ])("$name", async ({ run, expectedRequest, expectedMessage, installMessage }) => {
    const { state, request } = createState();
    mockSkillMutationRequests(request, installMessage);

    await run(state);

    const [method, params] = expectedRequest;
    expect(request).toHaveBeenCalledWith(method, params);
    expect(state.skillMessages.github).toEqual({ kind: "success", message: expectedMessage });
    expect(state.skillsBusyKey).toBeNull();
    expect(state.skillsError).toBeNull();
  });

  it("records errors from failed mutations", async () => {
    const { state, request } = createState();
    request.mockRejectedValue(new Error("skills update failed"));

    await updateSkillEnabled(state, "github", false);

    expect(state.skillsError).toBe("skills update failed");
    expect(state.skillMessages.github).toEqual({
      kind: "error",
      message: "skills update failed",
    });
    expect(state.skillsBusyKey).toBeNull();
  });
});
