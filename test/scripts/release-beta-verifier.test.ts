// Release Beta Verifier tests cover release beta verifier script behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchStatusWithRetry,
  parseNpmViewFields,
  parseReleaseVerifyBetaArgs,
  readBoundedJsonResponse,
  runNpmViewWithRetry,
} from "../../scripts/lib/release-beta-verifier.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("parseReleaseVerifyBetaArgs", () => {
  it("defaults beta verification to the matching tag and repo", () => {
    expect(parseReleaseVerifyBetaArgs(["2026.5.10-beta.3"])).toEqual({
      version: "2026.5.10-beta.3",
      tag: "v2026.5.10-beta.3",
      distTag: "beta",
      repo: "openclaw/openclaw",
      registry: "https://clawhub.ai",
      workflowRef: undefined,
      clawHubWorkflowRef: undefined,
      pluginSelection: [],
      evidenceOut: undefined,
      skipPostpublish: false,
      skipGitHubRelease: false,
      skipClawHub: false,
      rerunFailedClawHub: false,
      workflowRuns: {},
    });
  });

  it("parses child run IDs and repair flags", () => {
    expect(
      parseReleaseVerifyBetaArgs([
        "--",
        "2026.5.10-beta.3",
        "--workflow-ref",
        "release/2026.5.10",
        "--clawhub-workflow-ref",
        "v2026.5.10-beta.3",
        "--plugins",
        "@openclaw/plugin-a,@openclaw/plugin-b",
        "--full-release-validation-run",
        "10",
        "--openclaw-npm-run",
        "11",
        "--plugin-npm-run",
        "22",
        "--plugin-clawhub-run",
        "33",
        "--plugin-clawhub-bootstrap-run",
        "34",
        "--npm-telegram-run",
        "44",
        "--evidence-out",
        ".artifacts/release-evidence.json",
        "--skip-postpublish",
        "--skip-github-release",
        "--skip-clawhub",
        "--rerun-failed-clawhub",
      ]),
    ).toEqual({
      version: "2026.5.10-beta.3",
      tag: "v2026.5.10-beta.3",
      distTag: "beta",
      repo: "openclaw/openclaw",
      registry: "https://clawhub.ai",
      workflowRef: "release/2026.5.10",
      clawHubWorkflowRef: "v2026.5.10-beta.3",
      pluginSelection: ["@openclaw/plugin-a", "@openclaw/plugin-b"],
      evidenceOut: ".artifacts/release-evidence.json",
      skipPostpublish: true,
      skipGitHubRelease: true,
      skipClawHub: true,
      rerunFailedClawHub: true,
      workflowRuns: {
        fullReleaseValidation: "10",
        openclawNpm: "11",
        pluginNpm: "22",
        pluginClawHub: "33",
        pluginClawHubBootstrap: "34",
        npmTelegram: "44",
      },
    });
  });
});

describe("parseNpmViewFields", () => {
  it("accepts keyed npm view JSON", () => {
    expect(
      parseNpmViewFields(
        JSON.stringify({
          version: "2026.5.10-beta.3",
          "dist-tags.beta": "2026.5.10-beta.3",
          "dist.integrity": "sha512-test",
          "dist.tarball": "https://registry.example/openclaw.tgz",
        }),
        "beta",
      ),
    ).toEqual({
      version: "2026.5.10-beta.3",
      distTagVersion: "2026.5.10-beta.3",
      integrity: "sha512-test",
      tarball: "https://registry.example/openclaw.tgz",
    });
  });

  it("accepts nested npm view JSON", () => {
    expect(
      parseNpmViewFields(
        JSON.stringify({
          version: "2026.5.10-beta.3",
          "dist-tags": { beta: "2026.5.10-beta.3" },
          dist: {
            integrity: "sha512-test",
            tarball: "https://registry.example/openclaw.tgz",
          },
        }),
        "beta",
      ),
    ).toEqual({
      version: "2026.5.10-beta.3",
      distTagVersion: "2026.5.10-beta.3",
      integrity: "sha512-test",
      tarball: "https://registry.example/openclaw.tgz",
    });
  });
});

describe("runNpmViewWithRetry", () => {
  it("retries transient registry failures with online metadata reads", async () => {
    const calls: string[][] = [];
    const delays: number[] = [];

    await expect(
      runNpmViewWithRetry(["view", "openclaw@2026.5.10-beta.3", "version", "--json"], {
        attempts: 3,
        delay: async (delayMs) => {
          delays.push(delayMs);
        },
        run: (args) => {
          calls.push(args);
          if (calls.length < 3) {
            throw new Error("npm registry has not propagated the release yet");
          }
          return '"2026.5.10-beta.3"';
        },
      }),
    ).resolves.toBe('"2026.5.10-beta.3"');

    expect(calls).toHaveLength(3);
    expect(calls.every((args) => args.at(-1) === "--prefer-online")).toBe(true);
    expect(delays).toEqual([1000, 2000]);
  });
});

describe("fetchStatusWithRetry", () => {
  it("cancels retryable and returned GET response bodies", async () => {
    vi.useFakeTimers();
    const canceled: string[] = [];
    const responses = [
      new Response(
        new ReadableStream<Uint8Array>({
          cancel() {
            canceled.push("retry");
          },
        }),
        { status: 500 },
      ),
      new Response(
        new ReadableStream<Uint8Array>({
          cancel() {
            canceled.push("final");
          },
        }),
        { status: 200 },
      ),
    ];
    const fetchImpl = vi.fn(async () => {
      const response = responses.shift();
      if (!response) {
        throw new Error("unexpected fetch call");
      }
      return response;
    });
    vi.stubGlobal("fetch", fetchImpl);

    const status = fetchStatusWithRetry("https://clawhub.test/api/v1/package", "GET");
    await vi.advanceTimersByTimeAsync(1000);

    await expect(status).resolves.toBe(200);
    expect(canceled).toEqual(["retry", "final"]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("readBoundedJsonResponse", () => {
  it("parses JSON bodies within the release verifier limit", async () => {
    await expect(
      readBoundedJsonResponse(new Response('{"ok":true}'), "ClawHub package", 64),
    ).resolves.toEqual({ ok: true });
  });

  it("rejects oversized JSON bodies by content length", async () => {
    await expect(
      readBoundedJsonResponse(
        new Response("{}", { headers: { "content-length": "65" } }),
        "ClawHub package",
        64,
      ),
    ).rejects.toThrow("ClawHub package response body exceeded 64 bytes.");
  });

  it("rejects oversized streamed JSON bodies", async () => {
    await expect(
      readBoundedJsonResponse(new Response('{"padding":"too-large"}'), "ClawHub package", 8),
    ).rejects.toThrow("ClawHub package response body exceeded 8 bytes.");
  });

  it("keeps ClawHub request timeouts active while reading JSON bodies", async () => {
    let canceled = false;
    const abortController = new AbortController();
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"partial":'));
        },
        cancel() {
          canceled = true;
        },
      }),
    );

    const json = readBoundedJsonResponse(response, "ClawHub package", 64, {
      signal: abortController.signal,
    });

    await new Promise((resolveDelay) => {
      setTimeout(resolveDelay, 0);
    });
    abortController.abort(new Error("ClawHub body timed out"));

    await expect(json).rejects.toThrow("ClawHub body timed out");
    expect(canceled).toBe(true);
  });
});
