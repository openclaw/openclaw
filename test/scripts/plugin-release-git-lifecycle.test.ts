import { expect, it } from "vitest";
import { runCiGitStep } from "./ci-git-owner.test-support.js";

// Plugin publication jobs run on Ubuntu. Native Job Object and POSIX owner
// behavior stays in the shared ci-platform-checkout suites.
const posixIt = it.skipIf(process.platform === "win32");
const sha = "a".repeat(40);
const workflowSha = "b".repeat(40);
const releaseTag = "v2026.8.1";
const alphaBranch = "tideclaw/alpha/2026-08-30-1200Z";
const packageDir = "extensions/fixture";
const packageJson = '{"name":"@openclaw/fixture","version":"2026.8.33"}\n';
const monthlyBranch = "extended-stable/2026.8.33";
const mainMiss = { "merge-base --is-ancestor HEAD origin/main": { code: 1 } };
const releaseMiss = {
  ...mainMiss,
  "for-each-ref --format=%(refname) refs/remotes/origin/release": { code: 0, output: "" },
};
const protectedReleaseEnv = {
  RELEASE_PUBLISH_RUN_ATTEMPT: "2",
  RELEASE_PUBLISH_RUN_ID: "123",
  RELEASE_TAG: releaseTag,
  TARGET_SHA: sha,
  WORKFLOW_REF: "refs/tags/release-publish/abcdef123456-2",
  WORKFLOW_SHA: workflowSha,
};
const preflightEnv = {
  PREFLIGHT_ONLY: "true",
  NPM_DIST_TAG: "extended-stable",
  PUBLISH_SCOPE: "all-publishable",
  SOURCE_REF: sha,
};

type PluginMode = keyof typeof modes;
type RunOptions = Partial<Parameters<typeof runCiGitStep>[0]>;

function modeConfig(
  registry: "npm" | "clawhub",
  step: string,
  env: Record<string, string> = {},
  job = `preview_plugins_${registry}`,
) {
  return { workflow: { file: `.github/workflows/plugin-${registry}-release.yml`, job, step }, env };
}

const modes = {
  "clawhub-resolve": modeConfig("clawhub", "Resolve checked-out ref", {
    RELEASE_TAG: "",
    TARGET_REF: "",
  }),
  "clawhub-oidc": modeConfig("clawhub", "Validate OIDC source matches workflow ref", {
    DRY_RUN: "false",
    RELEASE_PUBLISH_RUN_ATTEMPT: "",
    RELEASE_PUBLISH_RUN_ID: "",
    RELEASE_TAG: "",
    TARGET_SHA: sha,
    WORKFLOW_REF: "refs/heads/main",
    WORKFLOW_SHA: sha,
  }),
  "clawhub-trust": modeConfig("clawhub", "Validate ref is on a trusted publish branch", {
    TRUSTED_PUBLISH_BRANCH: "main",
  }),
  "npm-resolve": modeConfig("npm", "Resolve checked-out ref"),
  "npm-trust": modeConfig("npm", "Validate ref is on a trusted publish branch", {
    RELEASE_CANDIDATE_BRANCH: "",
    NPM_DIST_TAG: "default",
    PREFLIGHT_ONLY: "false",
    // Ancestry cases isolate Git policy; tag admission is asserted with it enabled.
    REQUIRE_NPM_PUBLISH_ENVIRONMENT: "false",
    PREPARED_ARTIFACT: "",
    PUBLISH_SCOPE: "selected",
    RELEASE_PLUGINS: "",
    RELEASE_PUBLISH_RUN_ATTEMPT: "",
    RELEASE_PUBLISH_RUN_ID: "",
    SOURCE_REF: sha,
    TRUSTED_PUBLISHER_PREFLIGHT: "false",
    WORKFLOW_REF: "refs/heads/main",
    WORKFLOW_SHA: workflowSha,
  }),
  "npm-preflight-read": modeConfig(
    "npm",
    "Read exact npm preflight source package",
    { EXTENSION_ID: "fixture", PACKAGE_DIR: packageDir, SOURCE_SHA: sha },
    "verify_plugin_npm_preflight",
  ),
  "npm-publish-read": modeConfig(
    "npm",
    "Read exact npm publication source package",
    { EXTENSION_ID: "fixture", PACKAGE_DIR: packageDir, TARGET_SHA: sha },
    "publish_plugins_npm",
  ),
};

function pluginRun(signal: AbortSignal, mode: PluginMode, options: RunOptions = {}) {
  const selected = modes[mode];
  return runCiGitStep({
    signal,
    workflow: selected.workflow,
    fetchResults: [],
    ...options,
    env: { ...selected.env, ...options.env },
    revisions: { HEAD: sha, ...options.revisions },
  });
}

function gitCommands(report: Awaited<ReturnType<typeof pluginRun>>) {
  return report.commands.filter(({ tool }) => tool === "git").map(({ args }) => args);
}

posixIt.for([
  ["clawhub-resolve", `sha=${sha}\n`],
  ["npm-resolve", `sha=${sha}\n`],
  ["clawhub-trust", ""],
  ["npm-trust", ""],
] as const)(
  "%s succeeds and publishes its expected output",
  { timeout: 55_000 },
  async ([mode, output], { signal }) => {
    const report = await pluginRun(signal, mode);
    expect(report.code, report.output).toBe(0);
    expect(report.githubOutput).toBe(output);
  },
);

posixIt.for(
  (["npm-preflight-read", "npm-publish-read"] as const).flatMap((mode) =>
    [0, 23].map((code) => ({ mode, code })),
  ),
)(
  "$mode admits exact source bytes only after a successful show (exit $code)",
  { timeout: 55_000 },
  async ({ mode, code }, { signal }) => {
    const output = code ? "{partial" : packageJson;
    const report = await pluginRun(signal, mode, {
      commandResults: { [`show ${sha}:${packageDir}/package.json`]: { code, output } },
    });
    expect(report, report.output).toMatchObject({
      code,
      pluginSourcePackage: code ? "" : packageJson,
    });
  },
);

posixIt.for([1, 125, 143])(
  "ClawHub resolves origin fallback after safely drained ordinary local probe failure %s",
  { timeout: 55_000 },
  async (code, { signal }) => {
    const report = await pluginRun(signal, "clawhub-resolve", {
      env: { TARGET_REF: "release/fixture" },
      commandResults: {
        "rev-parse --verify --quiet release/fixture^{commit}": { code, output: "" },
      },
      revisions: { "origin/release/fixture^{commit}": sha },
    });
    expect(report.code, report.output).toBe(0);
    expect(report.githubOutput).toBe(`sha=${sha}\n`);
  },
);

posixIt(
  "ClawHub release tags retain their second bounded fetch",
  async ({ signal }) => {
    const report = await pluginRun(signal, "clawhub-resolve", {
      env: { RELEASE_TAG: releaseTag },
    });
    expect(report.code, report.output).toBe(0);
    expect(report.fetches).toHaveLength(2);
  },
  55_000,
);

posixIt.for([0, 1, 125])(
  "ClawHub protected tooling binds the exact peeled tag (lookup exit %s)",
  { timeout: 55_000 },
  async (code, { signal }) => {
    const report = await pluginRun(signal, "clawhub-oidc", {
      env: protectedReleaseEnv,
      ...(code
        ? { commandResults: { [`rev-parse ${releaseTag}^{commit}`]: { code } } }
        : { revisions: { [`${releaseTag}^{commit}`]: sha } }),
    });
    expect(report.code, report.output).toBe(code ? 1 : 0);
    expect(report.output).toContain(
      code
        ? "Plugin ClawHub OIDC publish target is not bound to protected tooling and the exact release tag."
        : "Protected release tooling is publishing the exact immutable release tag target.",
    );
  },
);

posixIt.for(["clawhub-trust", "npm-trust"] as const)(
  "%s accepts a release branch only after successful enumeration",
  { timeout: 55_000 },
  async (mode, { signal }) => {
    const ref = "refs/remotes/origin/release/2026.8.1";
    const report = await pluginRun(signal, mode, {
      commandResults: {
        ...mainMiss,
        "for-each-ref --format=%(refname) refs/remotes/origin/release": {
          code: 0,
          output: `${ref}\n`,
        },
        [`merge-base --is-ancestor HEAD ${ref}`]: { code: 0 },
      },
    });
    expect(report.code, report.output).toBe(0);
  },
);

posixIt.for([false, true])(
  "npm-trust rejects retired alpha ancestry (preflight=%s)",
  { timeout: 55_000 },
  async (preflight, { signal }) => {
    const report = await pluginRun(signal, "npm-trust", {
      env: {
        WORKFLOW_REF: `refs/heads/${alphaBranch}`,
        ...(preflight ? { PREFLIGHT_ONLY: "true", SOURCE_REF: sha } : {}),
      },
      ...(preflight ? { revisions: { [`${sha}^{commit}`]: sha } } : {}),
      commandResults: releaseMiss,
    });
    expect(report.code, report.output).toBe(1);
    expect(report.output).toContain(
      preflight
        ? "Plugin npm preflight target must be reachable from main or release/*."
        : "Plugin npm publishes must target a commit reachable from main or release/*.",
    );
    if (preflight) {
      expect(report.fetches).toHaveLength(1);
      expect(report.output).not.toContain("matching Tideclaw alpha branch");
    } else {
      expect(report.fetches.some(({ args }) => args.join(" ").includes(alphaBranch))).toBe(false);
    }
  },
);

posixIt(
  "clawhub-trust rejects a retired Tideclaw alpha branch before ancestry admission",
  async ({ signal }) => {
    const report = await pluginRun(signal, "clawhub-trust", {
      env: { TRUSTED_PUBLISH_BRANCH: alphaBranch },
      commandResults: {
        ...releaseMiss,
        [`merge-base --is-ancestor HEAD refs/remotes/origin/${alphaBranch}`]: { code: 0 },
      },
    });
    expect(report.code, report.output).toBe(1);
    expect(report.output).toContain("Alpha releases are retired;");
    expect(report.fetches).toEqual([]);
  },
  55_000,
);

posixIt.for([
  ["canonical branch", `refs/heads/${monthlyBranch}`, sha, 0],
  ["main branch", "refs/heads/main", sha, 0],
  ["moved canonical tip", "refs/heads/main", "c".repeat(40), 1],
  ["untrusted workflow branch", "refs/heads/topic", sha, 1],
  ["same-name main tag", "refs/tags/main", sha, 1],
] as const)(
  "npm extended-stable preflight: %s",
  { timeout: 55_000 },
  async ([_name, workflowRef, branchSha, code], { signal }) => {
    const branch = monthlyBranch;
    const report = await pluginRun(signal, "npm-trust", {
      env: { ...preflightEnv, WORKFLOW_REF: workflowRef },
      revisions: {
        [`${sha}^{commit}`]: sha,
        ...(code === 0 ? { [`refs/heads/${branch}`]: sha } : {}),
        [`refs/remotes/origin/${branch}`]: branchSha,
      },
    });
    expect(report.code, report.output).toBe(code);
    if (code !== 0) {
      expect(report.output).toContain("Extended-stable plugin");
    }
  },
);

const candidateAdmissionCases: Array<{
  name: string;
  env?: RunOptions["env"];
  commands?: RunOptions["commandResults"];
  code?: number;
  message?: string;
}> = [
  { name: "qualified protected tooling", code: 0 },
  {
    name: "wrong candidate month",
    env: { RELEASE_CANDIDATE_BRANCH: "extended-stable/2026.7.33" },
    message: "release_candidate_branch must be extended-stable/2026.8.33",
  },
  {
    name: "mutable main tooling",
    env: { WORKFLOW_REF: "refs/heads/main" },
    message: "require a protected release-publish/<sha12>-<n> tooling tag",
  },
  {
    name: "tooling outside main",
    commands: { [`merge-base --is-ancestor ${workflowSha} origin/main`]: { code: 1 } },
    message: "workflow revision is not reachable from current main",
  },
  {
    name: "candidate outside monthly branch",
    commands: {
      [`merge-base --is-ancestor HEAD refs/remotes/origin/${monthlyBranch}`]: { code: 1 },
    },
    message: "target must be reachable from extended-stable/2026.8.33",
  },
  {
    name: "tooling ancestry Git failure",
    commands: { [`merge-base --is-ancestor ${workflowSha} origin/main`]: { code: 23 } },
    code: 23,
  },
  {
    name: "preflight candidate override",
    env: { PREFLIGHT_ONLY: "true", REQUIRE_NPM_PUBLISH_ENVIRONMENT: "false" },
    message: "preflight must not include release_candidate_branch",
  },
  {
    name: "non-extended candidate override",
    env: { NPM_DIST_TAG: "default" },
    message: "release_candidate_branch is only valid for extended-stable publication",
  },
];

posixIt.for(candidateAdmissionCases)(
  "npm canonical candidate admission: $name",
  { timeout: 55_000 },
  async ({ env, commands = {}, code = 1, message }, { signal }) => {
    const report = await pluginRun(signal, "npm-trust", {
      env: {
        NPM_DIST_TAG: "extended-stable",
        PUBLISH_SCOPE: "all-publishable",
        RELEASE_CANDIDATE_BRANCH: "extended-stable/2026.8.33",
        REQUIRE_NPM_PUBLISH_ENVIRONMENT: "true",
        WORKFLOW_REF: `refs/tags/release-publish/${workflowSha.slice(0, 12)}-123`,
        ...env,
      },
      revisions: { [`${sha}^{commit}`]: sha },
      commandResults: commands,
    });
    expect(report.code, report.output).toBe(code);
    if (message) {
      expect(report.output).toContain(message);
    }
  },
);

posixIt.for(
  (["clawhub-trust", "npm-trust"] as const).flatMap((mode) =>
    ["merge-base", "for-each-ref"].map((operation) => ({ mode, operation })),
  ),
)(
  "$mode treats $operation failure as terminal",
  { timeout: 55_000 },
  async ({ mode, operation }, { signal }) => {
    const report = await pluginRun(signal, mode, {
      commandResults:
        operation === "merge-base"
          ? { "merge-base --is-ancestor HEAD origin/main": { code: 23 } }
          : {
              ...mainMiss,
              "for-each-ref --format=%(refname) refs/remotes/origin/release": { code: 23 },
            },
    });
    expect(report.code, report.output).toBe(23);
    expect(gitCommands(report).at(-1)?.[0]).toBe(operation);
  },
);

function terminalCase(
  mode: PluginMode,
  operation: string,
  options: Pick<RunOptions, "env" | "commandResults" | "revisions"> = {},
  match = `^${operation} `,
) {
  return { mode, operation, match, ...options };
}
// The shared ci-git-owner suite owns unhandled Git/setup failures. These sites
// catch GitFailure themselves, so prove owner-fatal failures cannot enter recovery.
const terminalCases = [
  terminalCase(
    "clawhub-resolve",
    "rev-parse",
    {
      env: { TARGET_REF: "release/fixture" },
      revisions: { "origin/release/fixture^{commit}": sha },
    },
    "^rev-parse --verify --quiet ",
  ),
  terminalCase("clawhub-oidc", "rev-parse", {
    env: {
      ...protectedReleaseEnv,
      RELEASE_PUBLISH_RUN_ATTEMPT: "1",
      RELEASE_PUBLISH_RUN_ID: "1",
      WORKFLOW_REF: "refs/tags/release-publish/abcdef123456-1",
    },
  }),
  terminalCase("clawhub-trust", "merge-base"),
  terminalCase("npm-trust", "merge-base"),
];

posixIt.for(
  terminalCases.flatMap((entry) =>
    (["cleanup-failure", "cancel"] as const).map((failure) =>
      Object.assign({}, entry, { failure }),
    ),
  ),
)(
  "$mode $operation $failure fences every later Git/output/consumer boundary",
  { timeout: 55_000 },
  async ({ commandResults, env, failure, match, mode, operation, revisions }, { signal }) => {
    const report = await pluginRun(signal, mode, {
      commandResults,
      env,
      revisions,
      gitFault: { match, code: failure },
    });
    expect(report.code, report.output).toBe(failure === "cancel" ? 143 : 125);
    expect(gitCommands(report).at(-1)?.[0]).toBe(operation);
    expect(
      gitCommands(report).filter((args) => new RegExp(match).test(args.join(" "))),
    ).toHaveLength(1);
    expect(report.githubOutput).toBe("");
    expect(report.commands.some(({ tool }) => ["node", "pnpm"].includes(tool))).toBe(false);
  },
);
