import { createRoot } from "solid-js";
import { onTestFinished } from "vitest";
import { createDraftFixture } from "./draft-submission-flow.test-support.ts";
import { createNewSessionTitle } from "./draft-title.ts";
import type { NewSessionRouteData } from "./location.ts";

const DEFAULT_PREPARED_TITLE = "Repair naming";

export function createDraftTitleFixture(
  request = async (_method: string, _params?: unknown): Promise<unknown> => ({
    title: DEFAULT_PREPARED_TITLE,
  }),
  data?: NewSessionRouteData,
  requestOther = async (method: string, _params?: unknown): Promise<unknown> =>
    method === "models.list" ? { models: [] } : {},
) {
  const fixture = createDraftFixture({
    data,
    methods: ["sessions.create", "sessions.title.prepare", "worktrees.branches"],
    scopes: ["operator.read", "operator.write", "operator.admin"],
    agents: [
      {
        id: "main",
        workspace: "/workspace",
        workspaceGit: true,
        model: { primary: "test/primary" },
      },
    ],
    request: async (method, params) =>
      method === "sessions.title.prepare"
        ? request(method, params)
        : method === "worktrees.branches"
          ? { repositoryStatus: "git", branches: [], defaultBranch: "main" }
          : requestOther(method, params),
    modelCatalog: (params) => requestOther("models.list", params),
    takePreparedTitle: () => titles.takePreparedTitle(),
  });
  let titles!: ReturnType<typeof createNewSessionTitle>;
  const disposeTitles = createRoot((dispose) => {
    titles = createNewSessionTitle(() => {
      return {
        context: fixture.context,
        data,
        place: fixture.place,
        submission: fixture.flow,
        dictating: false,
      };
    });
    return dispose;
  });
  const synchronizeTitles = () => titles.synchronize();
  synchronizeTitles();
  onTestFinished(() => {
    disposeTitles();
    fixture.flow.disconnect();
  });
  return { ...fixture, titles, synchronizeTitles, disposeTitles };
}
