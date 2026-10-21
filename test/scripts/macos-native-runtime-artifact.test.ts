import { afterEach, describe, expect, it, vi } from "vitest";
import { waitForNativeRuntime } from "../../scripts/macos-native-runtime-artifact.mjs";

vi.mock("node:timers/promises", () => ({ setTimeout: async () => {} }));

const revision = "a".repeat(40);
const name = `macos-native-runtime-${revision}-2`;
const env = {
  GITHUB_API_URL: "https://api.github.invalid",
  GITHUB_REPOSITORY: "fixture/repo",
  GITHUB_RUN_ID: "123",
  GITHUB_RUN_ATTEMPT: "2",
  GH_TOKEN: "fixture-token",
};

afterEach(() => vi.unstubAllGlobals());

describe("native runtime publication barrier", () => {
  it("waits for this run's exact checkout and attempt, not the producer's remaining checks", async () => {
    const requests: string[] = [];
    const fetch = vi.fn(async (url: string) => {
      requests.push(url);
      if (url.includes("/jobs?")) {
        return Response.json({ jobs: [{ name: "build-artifacts", status: "in_progress" }] });
      }
      return Response.json({
        artifacts: [
          { name: `macos-native-runtime-${revision}-1`, id: 11, expired: false },
          ...(requests.length === 1 ? [] : [{ name, id: 42, expired: false }]),
        ],
      });
    });
    vi.stubGlobal("fetch", fetch);
    expect(await waitForNativeRuntime(revision, env)).toBe("42");
    expect(requests).toEqual([
      `${env.GITHUB_API_URL}/repos/fixture/repo/actions/runs/123/artifacts?name=${name}&per_page=100`,
      `${env.GITHUB_API_URL}/repos/fixture/repo/actions/runs/123/jobs?filter=latest&per_page=100&page=1`,
      `${env.GITHUB_API_URL}/repos/fixture/repo/actions/runs/123/artifacts?name=${name}&per_page=100`,
    ]);
  });

  it("retains a successful producer's exact artifact when only failed jobs are rerun", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        Response.json(
          url.includes("/jobs?")
            ? {
                jobs: [
                  {
                    name: "build-artifacts",
                    status: "completed",
                    conclusion: "success",
                    run_attempt: 1,
                  },
                ],
              }
            : {
                artifacts: url.includes(`name=macos-native-runtime-${revision}-1&`)
                  ? [{ name: `macos-native-runtime-${revision}-1`, id: 11, expired: false }]
                  : [],
              },
        ),
      ),
    );
    expect(await waitForNativeRuntime(revision, env)).toBe("11");
  });

  it.each(["failure", "cancelled", "success"])(
    "fails instead of hanging when the producer ends with %s and no artifact",
    async (conclusion) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) =>
          Response.json(
            url.includes("/artifacts?")
              ? { artifacts: [] }
              : {
                  jobs: [{ name: "build-artifacts", status: "completed", conclusion }],
                },
          ),
        ),
      );
      await expect(waitForNativeRuntime(revision, env)).rejects.toThrow(
        `Linux build finished without the native runtime (${conclusion})`,
      );
    },
  );

  it("does not accept expired artifacts or retry failed API requests", async () => {
    const fetch = vi.fn(async () =>
      Response.json({ artifacts: [{ name, id: 42, expired: true }] }),
    );
    vi.stubGlobal("fetch", fetch);
    await expect(waitForNativeRuntime(revision, env)).rejects.toThrow(
      "Native runtime artifact expired",
    );
    fetch.mockResolvedValue(new Response(null, { status: 403 }));
    await expect(waitForNativeRuntime(revision, env)).rejects.toThrow("HTTP 403");
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
