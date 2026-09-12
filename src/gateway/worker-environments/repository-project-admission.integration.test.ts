import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { prepareRepositoryWorkerProjectSource } from "./repository-project-admission.js";

const directories = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it("admits public source without a native CLI and fences later configured identity state", async () => {
  const root = directories.make("repository-no-native-cli-");
  const nativeConfig = path.join(root, "native");
  const emptyPath = path.join(root, "bin");
  await fs.mkdir(nativeConfig);
  await fs.mkdir(emptyPath);
  vi.stubEnv("PATH", emptyPath);
  vi.stubEnv("GH_CONFIG_DIR", nativeConfig);
  vi.stubEnv("GH_TOKEN", undefined);
  vi.stubEnv("GITHUB_TOKEN", undefined);
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
  const commit = "a".repeat(40);
  const tree = "b".repeat(40);
  const repositoryUrl = "https://github.com/acme/public-project.git";
  const config = { agents: { list: [{ id: "public-source", workspace: root }] } };
  // Only HTTP is substituted: identity selection, missing CLI execution,
  // configuration absence and durable agent ownership use their real owners.
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const request = new Request(input, init);
    expect(request.method).toBe("GET");
    expect(request.headers.has("authorization")).toBe(false);
    const pathname = new URL(request.url).pathname;
    let body: unknown;
    if (pathname === "/repos/acme/public-project") {
      body = {
        node_id: "R_public_fixture",
        clone_url: repositoryUrl,
        private: false,
        default_branch: "main",
      };
    } else if (pathname.startsWith("/repos/acme/public-project/commits/")) {
      body = { sha: commit, commit: { tree: { sha: tree } } };
    } else if (pathname === `/repos/acme/public-project/git/commits/${commit}`) {
      body = { sha: commit, tree: { sha: tree } };
    } else if (pathname === `/repos/acme/public-project/git/trees/${tree}`) {
      body = { sha: tree, truncated: false, tree: [] };
    } else {
      throw new Error("Unexpected public metadata request");
    }
    return new Response(JSON.stringify(body));
  });
  vi.stubGlobal("fetch", fetchMock);

  const admitted = await prepareRepositoryWorkerProjectSource({
    repository: { agentId: "public-source", url: repositoryUrl },
    namespace: "public-source-test",
    getConfig: () => config,
    assertCurrent: () => {},
  });

  expect(admitted.project.baseCommit).toBe(commit);
  expect(admitted.project.source.owner.identity).toEqual({ source: "anonymous" });
  await expect(admitted.revalidate()).resolves.toBeUndefined();
  const reopened = await prepareRepositoryWorkerProjectSource({
    expected: admitted.project,
    namespace: "public-source-test",
    getConfig: () => config,
    assertCurrent: () => {},
  });
  expect(reopened.project).toEqual(admitted.project);
  expect(admitted).not.toHaveProperty("readGitToken");
  expect(fetchMock).toHaveBeenCalled();
  await fs.writeFile(path.join(nativeConfig, "config.yml"), "{}\n");
  fetchMock.mockClear();
  await expect(admitted.revalidate()).rejects.toThrow("credential is unavailable");
  expect(fetchMock).not.toHaveBeenCalled();
});
