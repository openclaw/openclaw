// Release Candidate Checklist tests cover release candidate checklist script behavior.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  buildFullValidationDispatchFields,
  buildNpmPreflightDispatchFields,
  buildPublishCommand,
  candidateParallelsArgs,
  candidateParallelsShellCommand,
  githubApi,
  parseArgs,
  parseRunIdFromDispatchOutput,
  resolveArtifactName,
  requireRunIdFromDispatchOutput,
  validateFullManifest,
  validateWindowsSourceRelease,
} from "../../scripts/release-candidate-checklist.mjs";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), init);
}

async function withGithubApiTimeoutEnv<T>(value: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.env.OPENCLAW_RELEASE_CANDIDATE_GITHUB_API_TIMEOUT_MS;
  process.env.OPENCLAW_RELEASE_CANDIDATE_GITHUB_API_TIMEOUT_MS = value;
  try {
    return await fn();
  } finally {
    if (previous === undefined) {
      delete process.env.OPENCLAW_RELEASE_CANDIDATE_GITHUB_API_TIMEOUT_MS;
    } else {
      process.env.OPENCLAW_RELEASE_CANDIDATE_GITHUB_API_TIMEOUT_MS = previous;
    }
  }
}

describe("release candidate checklist", () => {
  it("preserves legacy defaults and keeps release validation depth independent", () => {
    const options = parseArgs([
      "--tag",
      "v2026.7.32",
      "--windows-node-tag",
      "v0.6.3",
      "--release-profile",
      "full",
    ]);

    expect(options).toMatchObject({
      policyMode: "legacy",
      releaseSelector: null,
      releaseClass: "daily",
      releaseProfile: "full",
      npmDistTag: "beta",
      publishEligible: true,
    });
  });

  it("normalizes only supported legacy npm tags and preserves corrections", () => {
    expect(
      parseArgs([
        "--tag",
        "v2026.7.34-2",
        "--windows-node-tag",
        "v0.6.3",
        "--npm-dist-tag",
        " latest ",
      ]),
    ).toMatchObject({
      releaseClass: "historical-correction",
      npmDistTag: "latest",
      publishEligible: true,
    });
    expect(() => parseArgs(["--tag", "v2026.7.1-beta.1", "--npm-dist-tag", "stable"])).toThrow(
      "--npm-dist-tag must be alpha, beta, or latest",
    );
  });

  it("enforces closed policy modes and selector mode constraints", () => {
    expect(() => parseArgs(["--tag", "v2026.7.1-beta.1", "--policy-mode", "required"])).toThrow(
      "--policy-mode must be legacy or strict",
    );
    expect(() => parseArgs(["--tag", "v2026.7.1-beta.1", "--release-selector", "preview"])).toThrow(
      "--release-selector must be alpha, beta, daily, or stable",
    );
    expect(() => parseArgs(["--tag", "v2026.7.1-beta.1", "--release-selector", "beta"])).toThrow(
      "--release-selector must be omitted in legacy policy mode",
    );
  });

  it.each(["--policy-mode", "--release-selector", "--npm-dist-tag"])(
    "does not consume another option as the %s value",
    (flag) => {
      expect(() => parseArgs(["--tag", "v2026.7.1-beta.1", flag, "--skip-parallels"])).toThrow(
        `${flag} requires a value`,
      );
    },
  );

  it("rejects new stable finals but preserves correction publication in legacy mode", () => {
    expect(() => parseArgs(["--tag", "v2026.7.33", "--windows-node-tag", "v0.6.3"])).toThrow(
      "legacy policy mode cannot publish stable release class stable-base",
    );
    expect(() => parseArgs(["--tag", "v2026.7.34", "--windows-node-tag", "v0.6.3"])).toThrow(
      "legacy policy mode cannot publish stable release class stable-patch",
    );
    expect(parseArgs(["--tag", "v2026.7.34-2", "--windows-node-tag", "v0.6.3"]).releaseClass).toBe(
      "historical-correction",
    );
  });

  it.each([
    ["v2026.7.1-alpha.2", "alpha", "alpha", "alpha"],
    ["v2026.7.1-beta.2", "beta", "beta", "beta"],
    ["v2026.7.32", "daily", "latest", "daily"],
  ] as const)(
    "accepts strict %s with matching selector and downstream tag",
    (tag, releaseSelector, npmDistTag, releaseClass) => {
      expect(
        parseArgs([
          "--tag",
          tag,
          "--policy-mode",
          "strict",
          "--release-selector",
          releaseSelector,
          "--npm-dist-tag",
          npmDistTag,
          "--release-profile",
          "full",
        ]),
      ).toMatchObject({
        policyMode: "strict",
        releaseSelector,
        releaseClass,
        releaseProfile: "full",
        npmDistTag,
        publishEligible: true,
      });
    },
  );

  it("requires strict selectors and exact downstream tags", () => {
    expect(() =>
      parseArgs(["--tag", "v2026.7.1-beta.2", "--policy-mode", "strict", "--npm-dist-tag", "beta"]),
    ).toThrow("--release-selector is required in strict policy mode");
    expect(() =>
      parseArgs([
        "--tag",
        "v2026.7.1-beta.2",
        "--policy-mode",
        "strict",
        "--release-selector",
        "daily",
        "--npm-dist-tag",
        "beta",
      ]),
    ).toThrow('Release selector "daily" does not match release class "beta"');
    expect(() =>
      parseArgs([
        "--tag",
        "v2026.7.32",
        "--policy-mode",
        "strict",
        "--release-selector",
        "daily",
        "--npm-dist-tag",
        "beta",
      ]),
    ).toThrow("strict daily publication requires --npm-dist-tag latest");
  });

  it("rejects numeric corrections at strict candidate ingress", () => {
    expect(() =>
      parseArgs([
        "--tag",
        "v2026.7.34-2",
        "--policy-mode",
        "strict",
        "--release-selector",
        "stable",
      ]),
    ).toThrow("Strict publication rejects numeric correction");
  });

  it("models strict stable as a nonpublishable policy-only preflight", () => {
    for (const npmDistTagArgs of [[], ["--npm-dist-tag", ""]]) {
      expect(
        parseArgs([
          "--tag",
          "v2026.7.33",
          "--windows-node-tag",
          "v0.6.3",
          "--policy-mode",
          "strict",
          "--release-selector",
          "stable",
          ...npmDistTagArgs,
        ]),
      ).toMatchObject({
        releaseClass: "stable-base",
        npmDistTag: null,
        publishEligible: false,
      });
    }
    expect(() =>
      parseArgs([
        "--tag",
        "v2026.7.33",
        "--windows-node-tag",
        "v0.6.3",
        "--policy-mode",
        "strict",
        "--release-selector",
        "stable",
        "--npm-dist-tag",
        "latest",
      ]),
    ).toThrow("strict stable policy preflight requires --npm-dist-tag to be omitted or empty");
  });

  it("propagates policy inputs unchanged into dispatch and publish fields", () => {
    const externalContractRevision = "a".repeat(40);
    const strictDaily = parseArgs([
      "--tag",
      "v2026.7.32",
      "--policy-mode",
      "strict",
      "--release-selector",
      "daily",
      "--npm-dist-tag",
      "latest",
      "--external-contract-revision",
      externalContractRevision,
    ]);

    expect(buildFullValidationDispatchFields(strictDaily)).toMatchObject({
      policy_mode: "strict",
      release_selector: "daily",
      external_contract_revision: externalContractRevision,
    });
    expect(buildNpmPreflightDispatchFields(strictDaily)).toMatchObject({
      policy_mode: "strict",
      release_selector: "daily",
      npm_dist_tag: "latest",
    });
    expect(buildPublishCommand({ ...strictDaily, workflowRef: "main" })).toContain(
      "'policy_mode=strict' '-f' 'release_selector=daily' '-f' 'npm_dist_tag=latest'",
    );

    const strictStable = parseArgs([
      "--tag",
      "v2026.7.33",
      "--windows-node-tag",
      "v0.6.3",
      "--policy-mode",
      "strict",
      "--release-selector",
      "stable",
    ]);
    expect(buildNpmPreflightDispatchFields(strictStable)).toEqual({
      tag: "v2026.7.33",
      preflight_only: "true",
      policy_mode: "strict",
      release_selector: "stable",
    });
    expect(() => buildPublishCommand({ ...strictStable, workflowRef: "main" })).toThrow(
      "strict stable policy preflight is nonpublishable",
    );
  });

  it("requires an exact external workflow revision before strict Full Validation dispatch", () => {
    const strictDaily = parseArgs([
      "--tag",
      "v2026.7.32",
      "--policy-mode",
      "strict",
      "--release-selector",
      "daily",
      "--npm-dist-tag",
      "latest",
    ]);
    expect(() => buildFullValidationDispatchFields(strictDaily)).toThrow(
      "strict Full Release Validation requires --external-contract-revision",
    );
    expect(() =>
      parseArgs([
        "--tag",
        "v2026.7.32",
        "--policy-mode",
        "strict",
        "--release-selector",
        "daily",
        "--npm-dist-tag",
        "latest",
        "--external-contract-revision",
        "ABC",
      ]),
    ).toThrow("--external-contract-revision must be 40 lowercase hexadecimal characters");
  });

  it("finishes policy-only stable candidates without deriving publish artifacts", () => {
    const source = readFileSync("scripts/release-candidate-checklist.mjs", "utf8");
    expect(source).toContain(
      "const publishCommand = options.publishEligible ? buildPublishCommand(options) : null",
    );
    expect(source).toContain("tarball: none (policy-only stable preflight)");
    expect(source).toContain(
      "policy-only stable preflight artifact must contain exactly three files",
    );
    expect(source).toContain("policy-only stable preflight complete; no publish command emitted");
  });

  it("infers validation profiles from candidate tags", () => {
    expect(parseArgs(["--tag", "v2026.5.14-beta.3"]).releaseProfile).toBe("beta");
    expect(parseArgs(["--tag", "v2026.5.14", "--windows-node-tag", "v0.6.3"]).releaseProfile).toBe(
      "stable",
    );
    expect(
      parseArgs([
        "--tag",
        "v2026.5.14",
        "--windows-node-tag",
        "v0.6.3",
        "--release-profile",
        "full",
      ]).releaseProfile,
    ).toBe("full");
  });

  it("runs Parallels against the exact prepared candidate tarball", () => {
    expect(candidateParallelsArgs(".artifacts/preflight/openclaw.tgz")).toEqual([
      "test:parallels:npm-update",
      "--",
      "--target-tarball",
      ".artifacts/preflight/openclaw.tgz",
      "--json",
    ]);
    expect(
      candidateParallelsShellCommand(
        ".artifacts/preflight/openclaw candidate.tgz",
        "/opt/homebrew/bin/gtimeout",
      ),
    ).toContain(
      "set -a; source \"$HOME/.profile\" >/dev/null 2>&1 || true; set +a; exec '/opt/homebrew/bin/gtimeout' --foreground 150m pnpm",
    );
    expect(
      candidateParallelsShellCommand(
        ".artifacts/preflight/openclaw candidate.tgz",
        "/opt/homebrew/bin/gtimeout",
      ),
    ).toContain("'--target-tarball' '.artifacts/preflight/openclaw candidate.tgz'");
  });

  it("requires run ids when dispatch is disabled", () => {
    expect(() => parseArgs(["--tag", "v2026.5.14-beta.3", "--skip-dispatch"])).toThrow(
      "--skip-dispatch requires --full-release-run and --npm-preflight-run",
    );
  });

  it("rejects duplicate release candidate CLI options", () => {
    const requiredArgs = ["--tag", "v2026.5.14-beta.3"];
    const duplicateOption = (
      flag: string,
      firstValue: string,
      secondValue: string,
      prefix = requiredArgs,
    ): [string, string[]] => [flag, [...prefix, flag, firstValue, flag, secondValue]];
    const duplicateFlag = (flag: string): [string, string[]] => [flag, [...requiredArgs, flag, flag]];
    const duplicateCases = [
      duplicateOption("--tag", "v2026.5.14-beta.3", "v2026.5.14-beta.4", []),
      duplicateOption("--workflow-ref", "release/a", "release/b"),
      duplicateOption("--repo", "openclaw/openclaw", "fork/openclaw"),
      duplicateOption("--full-release-run", "111", "222"),
      duplicateOption("--npm-preflight-run", "111", "222"),
      duplicateOption("--windows-node-tag", "v0.6.3", "v0.6.4"),
      duplicateFlag("--skip-dispatch"),
      duplicateFlag("--skip-local-generated-check"),
      duplicateFlag("--skip-parallels"),
      duplicateFlag("--skip-telegram"),
      duplicateOption("--telegram-provider-mode", "mock-openai", "live-frontier"),
      duplicateOption("--provider", "blacksmith-testbox", "crabbox"),
      duplicateOption("--mode", "fresh", "upgrade"),
      duplicateOption("--release-profile", "beta", "stable"),
      duplicateOption("--policy-mode", "legacy", "strict"),
      duplicateOption("--release-selector", "daily", "stable"),
      duplicateOption("--npm-dist-tag", "beta", "latest"),
      duplicateOption("--plugin-publish-scope", "all-publishable", "selected"),
      duplicateOption("--plugins", "telegram", "discord"),
      duplicateOption("--output-dir", ".artifacts/a", ".artifacts/b"),
    ] satisfies Array<[string, string[]]>;

    for (const [flag, args] of duplicateCases) {
      expect(() => parseArgs(args), flag).toThrow(`${flag} was provided more than once`);
    }
  });

  it("requires stable validation evidence to include soak and blocking performance", () => {
    const stableManifest = {
      workflowName: "Full Release Validation",
      targetSha: "candidate-sha",
      releaseProfile: "stable",
      rerunGroup: "all",
      runReleaseSoak: "true",
      controls: { performanceBlocking: true },
    };

    expect(() =>
      validateFullManifest(stableManifest, {
        targetSha: "candidate-sha",
        releaseProfile: "stable",
      }),
    ).not.toThrow();

    expect(() =>
      validateFullManifest(
        {
          ...stableManifest,
          runReleaseSoak: "false",
        },
        {
          targetSha: "candidate-sha",
          releaseProfile: "stable",
        },
      ),
    ).toThrow("runReleaseSoak=true");
    expect(() =>
      validateFullManifest(
        {
          ...stableManifest,
          controls: { performanceBlocking: false },
        },
        {
          targetSha: "candidate-sha",
          releaseProfile: "stable",
        },
      ),
    ).toThrow("blocking product performance");
  });

  it("stops parsing options after the argument terminator", () => {
    const options = parseArgs([
      "--tag",
      "v2026.5.14-beta.3",
      "--full-release-run",
      "111",
      "--npm-preflight-run",
      "222",
      "--skip-dispatch",
      "--",
      "--plugin-publish-scope",
      "selected",
    ]);

    expect(options.pluginPublishScope).toBe("all-publishable");
  });

  it("accepts package-manager argument separators before script options", () => {
    const options = parseArgs([
      "--",
      "--tag",
      "v2026.5.14-beta.3",
      "--full-release-run",
      "111",
      "--npm-preflight-run",
      "222",
      "--skip-dispatch",
      "--skip-parallels",
    ]);

    expect(options.tag).toBe("v2026.5.14-beta.3");
    expect(options.skipParallels).toBe(true);
  });

  it("builds the gated release publish command from green evidence inputs", () => {
    const options = {
      ...parseArgs([
        "--tag",
        "v2026.5.14-beta.3",
        "--workflow-ref",
        "release/2026.5.14",
        "--full-release-run",
        "111",
        "--npm-preflight-run",
        "222",
        "--skip-dispatch",
      ]),
      workflowRef: "release/2026.5.14",
    };

    expect(buildPublishCommand(options)).toContain("'full_release_validation_run_id=111'");
    expect(buildPublishCommand(options)).toContain("'preflight_run_id=222'");
    expect(buildPublishCommand(options)).toContain("'tag=v2026.5.14-beta.3'");
    expect(buildPublishCommand(options)).toContain("'plugin_publish_scope=all-publishable'");
    expect(buildPublishCommand(options)).not.toContain("windows_node_tag=");
  });

  it("requires and carries an exact Windows Node tag for stable release candidates", () => {
    expect(() => parseArgs(["--tag", "v2026.5.14"])).toThrow(
      "stable release candidates require --windows-node-tag",
    );
    expect(() => parseArgs(["--tag", "v2026.5.14", "--windows-node-tag", "latest"])).toThrow(
      "--windows-node-tag must be an explicit version tag, not latest",
    );

    const options = {
      ...parseArgs([
        "--tag",
        "v2026.5.14",
        "--windows-node-tag",
        "v0.6.3",
        "--workflow-ref",
        "release/2026.5.14",
      ]),
      workflowRef: "release/2026.5.14",
      windowsNodeInstallerDigests: JSON.stringify({
        "OpenClawCompanion-Setup-x64.exe": `sha256:${"a".repeat(64)}`,
        "OpenClawCompanion-Setup-arm64.exe": `sha256:${"b".repeat(64)}`,
      }),
    };

    expect(buildPublishCommand(options)).toContain("'windows_node_tag=v0.6.3'");
    expect(buildPublishCommand(options)).toContain(
      `'windows_node_installer_digests={"OpenClawCompanion-Setup-x64.exe":"sha256:${"a".repeat(64)}","OpenClawCompanion-Setup-arm64.exe":"sha256:${"b".repeat(64)}"}'`,
    );
  });

  it("validates the stable Windows source release and immutable installer digests", async () => {
    const assets = [
      {
        name: "OpenClawCompanion-Setup-x64.exe",
        digest: `sha256:${"a".repeat(64)}`,
      },
      {
        name: "OpenClawCompanion-Setup-arm64.exe",
        digest: `sha256:${"b".repeat(64)}`,
      },
    ];
    const fetchImpl = vi.fn(async () => {
      return jsonResponse({
        tag_name: "v0.6.3",
        draft: false,
        prerelease: false,
        html_url: "https://github.com/openclaw/openclaw-windows-node/releases/tag/v0.6.3",
        assets,
      });
    });

    await expect(
      validateWindowsSourceRelease("v0.6.3", {
        fetchImpl,
        timeoutMs: 1234,
        token: "test-token",
      }),
    ).resolves.toEqual({
      tag: "v0.6.3",
      url: "https://github.com/openclaw/openclaw-windows-node/releases/tag/v0.6.3",
      assets,
    });
  });

  it.each([
    [{ draft: true }, "must be published"],
    [{ prerelease: true }, "must not be a prerelease"],
    [{ tag_name: "v0.6.4" }, "Windows source release tag mismatch: expected v0.6.3, got v0.6.4"],
    [
      { assets: [] },
      "must contain exactly one required asset OpenClawCompanion-Setup-x64.exe; found 0",
    ],
    [
      {
        assets: [
          {
            name: "OpenClawCompanion-Setup-x64.exe",
            digest: `sha256:${"a".repeat(64)}`,
          },
          {
            name: "OpenClawCompanion-Setup-x64.exe",
            digest: `sha256:${"c".repeat(64)}`,
          },
          {
            name: "OpenClawCompanion-Setup-arm64.exe",
            digest: `sha256:${"b".repeat(64)}`,
          },
        ],
      },
      "must contain exactly one required asset OpenClawCompanion-Setup-x64.exe; found 2",
    ],
    [
      {
        assets: [
          { name: "OpenClawCompanion-Setup-x64.exe", digest: "" },
          { name: "OpenClawCompanion-Setup-arm64.exe", digest: `sha256:${"b".repeat(64)}` },
        ],
      },
      "asset OpenClawCompanion-Setup-x64.exe is missing its SHA-256 digest",
    ],
  ])("rejects an invalid stable Windows source release", async (override, message) => {
    const fetchImpl = vi.fn(async () => {
      return jsonResponse({
        tag_name: "v0.6.3",
        draft: false,
        prerelease: false,
        html_url: "https://github.com/openclaw/openclaw-windows-node/releases/tag/v0.6.3",
        assets: [
          {
            name: "OpenClawCompanion-Setup-x64.exe",
            digest: `sha256:${"a".repeat(64)}`,
          },
          {
            name: "OpenClawCompanion-Setup-arm64.exe",
            digest: `sha256:${"b".repeat(64)}`,
          },
        ],
        ...override,
      });
    });

    await expect(
      validateWindowsSourceRelease("v0.6.3", {
        fetchImpl,
        timeoutMs: 1234,
        token: "test-token",
      }),
    ).rejects.toThrow(message);
  });

  it("carries the Telegram proof run into the publish command when available", () => {
    const options = {
      ...parseArgs([
        "--tag",
        "v2026.5.14-beta.3",
        "--workflow-ref",
        "release/2026.5.14",
        "--full-release-run",
        "111",
        "--npm-preflight-run",
        "222",
        "--skip-dispatch",
      ]),
      workflowRef: "release/2026.5.14",
      npmTelegramRunId: "333",
    };

    expect(buildPublishCommand(options)).toContain("'npm_telegram_run_id=333'");
  });

  it("requires explicit plugin names for selected plugin publish scope", () => {
    expect(() =>
      parseArgs(["--tag", "v2026.5.14-beta.3", "--plugin-publish-scope", "selected"]),
    ).toThrow("--plugin-publish-scope selected requires --plugins");
  });

  it("rejects selected plugin publish scope for release candidates", () => {
    expect(() =>
      parseArgs([
        "--tag",
        "v2026.5.14-beta.3",
        "--plugin-publish-scope",
        "selected",
        "--plugins",
        "@openclaw/diffs",
      ]),
    ).toThrow("release candidates publish OpenClaw with --plugin-publish-scope all-publishable");
  });

  it("extracts a workflow run id from gh dispatch output", () => {
    expect(
      parseRunIdFromDispatchOutput(
        "https://github.com/openclaw/openclaw/actions/runs/25922042055\n",
      ),
    ).toBe("25922042055");
  });

  it("fails closed when gh dispatch output does not include the run url", () => {
    expect(() =>
      requireRunIdFromDispatchOutput(
        "Created workflow_dispatch event for full-release-validation.yml",
        "full-release-validation.yml",
      ),
    ).toThrow("refusing to guess from recent workflow_dispatch runs");
  });

  it("falls back to a single compatible artifact from the same run", () => {
    expect(
      resolveArtifactName(
        [{ name: "openclaw-npm-preflight-dba00", expired: false }],
        "openclaw-npm-preflight-v2026.5.16-beta.2",
        "openclaw-npm-preflight-",
      ),
    ).toBe("openclaw-npm-preflight-dba00");
  });

  it("bounds GitHub API requests with a timeout signal", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(init?.headers).toMatchObject({
        Accept: "application/vnd.github+json",
        Authorization: "Bearer test-token",
        "X-GitHub-Api-Version": "2022-11-28",
      });
      return jsonResponse({ workflow_runs: [] });
    });

    await expect(
      githubApi("repos/openclaw/openclaw/actions/runs", {
        fetchImpl,
        timeoutMs: 1234,
        token: "test-token",
      }),
    ).resolves.toEqual({ workflow_runs: [] });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.github.com/repos/openclaw/openclaw/actions/runs",
      expect.objectContaining({
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("uses a positive integer GitHub API timeout env", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return jsonResponse({ workflow_runs: [] });
    });

    await withGithubApiTimeoutEnv("2500", async () => {
      await expect(
        githubApi("repos/openclaw/openclaw/actions/runs", {
          fetchImpl,
          token: "test-token",
        }),
      ).resolves.toEqual({ workflow_runs: [] });
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it.each(["1e3", "10.5", "0", "soon"])(
    "rejects malformed GitHub API timeout env %s",
    async (raw) => {
      const fetchImpl = vi.fn();

      await withGithubApiTimeoutEnv(raw, async () => {
        await expect(
          githubApi("repos/openclaw/openclaw/actions/runs", {
            fetchImpl,
            token: "test-token",
          }),
        ).rejects.toThrow(
          "OPENCLAW_RELEASE_CANDIDATE_GITHUB_API_TIMEOUT_MS must be a positive integer",
        );
      });
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it("bounds GitHub API error bodies", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response("x".repeat(65), {
        headers: { "content-length": "65" },
        status: 500,
      });
    });

    await expect(
      githubApi("repos/openclaw/openclaw/actions/runs", {
        fetchImpl,
        maxBodyBytes: 64,
        timeoutMs: 1234,
        token: "test-token",
      }),
    ).rejects.toThrow(
      "GitHub API repos/openclaw/openclaw/actions/runs response body exceeded 64 bytes",
    );
  });

  it("keeps GitHub API timeouts active while reading response bodies", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(new ReadableStream<Uint8Array>({ start() {} }), {
        status: 200,
      });
    });

    await expect(
      githubApi("repos/openclaw/openclaw/actions/runs", {
        fetchImpl,
        timeoutMs: 25,
        token: "test-token",
      }),
    ).rejects.toThrow("GitHub API repos/openclaw/openclaw/actions/runs timed out after 25ms");
  });

  it("includes the GitHub API path when a request times out", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new DOMException("request timed out", "TimeoutError");
    });

    await expect(
      githubApi("repos/openclaw/openclaw/actions/runs/123/jobs", {
        fetchImpl,
        timeoutMs: 5,
        token: "test-token",
      }),
    ).rejects.toThrow(
      "GitHub API repos/openclaw/openclaw/actions/runs/123/jobs timed out after 5ms",
    );
  });
});
