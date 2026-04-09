import { describe, expect, it, vi } from "vitest";
import {
  installSkill,
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
});

describe("skill mutations", () => {
  it("updates skill enablement and records a success message", async () => {
    const { state, request } = createState();
    request.mockImplementation(async (method: string) => {
      if (method === "skills.status") {
        return {};
      }
      return {};
    });

    await updateSkillEnabled(state, "github", true);

    expect(request).toHaveBeenCalledWith("skills.update", { skillKey: "github", enabled: true });
    expect(state.skillMessages.github).toEqual({ kind: "success", message: "Skill enabled" });
    expect(state.skillsBusyKey).toBeNull();
    expect(state.skillsError).toBeNull();
  });

  it("saves API keys and reports success", async () => {
    const { state, request } = createState();
    state.skillEdits.github = "sk-test";
    request.mockImplementation(async (method: string) => {
      if (method === "skills.status") {
        return {};
      }
      return {};
    });

    await saveSkillApiKey(state, "github");

    expect(request).toHaveBeenCalledWith("skills.update", {
      skillKey: "github",
      apiKey: "sk-test",
    });
    expect(state.skillMessages.github).toEqual({
      kind: "success",
      message: "API key saved — stored in openclaw.json (skills.entries.github)",
    });
    expect(state.skillsBusyKey).toBeNull();
  });

  it("installs skills and uses server success messages", async () => {
    const { state, request } = createState();
    request.mockImplementation(async (method: string) => {
      if (method === "skills.install") {
        return { message: "Installed from registry" };
      }
      if (method === "skills.status") {
        return {};
      }
      return {};
    });

    await installSkill(state, "github", "GitHub", "install-123", true);

    expect(request).toHaveBeenCalledWith("skills.install", {
      name: "GitHub",
      installId: "install-123",
      dangerouslyForceUnsafeInstall: true,
      timeoutMs: 120000,
    });
    expect(state.skillMessages.github).toEqual({
      kind: "success",
      message: "Installed from registry",
    });
    expect(state.skillsBusyKey).toBeNull();
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
