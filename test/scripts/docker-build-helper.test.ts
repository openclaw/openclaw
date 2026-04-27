import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const HELPER_PATH = "scripts/lib/docker-build.sh";
const DOCKER_ALL_SCHEDULER_PATH = "scripts/test-docker-all.mjs";
const DOCKER_E2E_SCENARIOS_PATH = "scripts/lib/docker-e2e-scenarios.mjs";
const INSTALL_E2E_RUNNER_PATH = "scripts/docker/install-sh-e2e/run.sh";
const OPENAI_WEB_SEARCH_MINIMAL_E2E_PATH = "scripts/e2e/openai-web-search-minimal-docker.sh";
const CENTRALIZED_BUILD_SCRIPTS = [
  "scripts/docker/setup.sh",
  "scripts/e2e/browser-cdp-snapshot-docker.sh",
  "scripts/e2e/qr-import-docker.sh",
  "scripts/lib/docker-e2e-image.sh",
  "scripts/sandbox-browser-setup.sh",
  "scripts/sandbox-common-setup.sh",
  "scripts/sandbox-setup.sh",
  "scripts/test-cleanup-docker.sh",
  "scripts/test-install-sh-docker.sh",
  "scripts/test-install-sh-e2e-docker.sh",
  "scripts/test-live-build-docker.sh",
] as const;

describe("docker build helper", () => {
  it("forces BuildKit for centralized Docker builds", () => {
    const helper = readFileSync(HELPER_PATH, "utf8");

    expect(helper).toContain("DOCKER_BUILDKIT=1");
    expect(helper).toContain("docker_build_exec()");
    expect(helper).toContain("docker_build_run()");
    expect(helper).toContain("docker buildx build --load");
  });

  it("keeps shell-script Docker builds behind the helper", () => {
    for (const path of CENTRALIZED_BUILD_SCRIPTS) {
      const script = readFileSync(path, "utf8");

      expect(script, path).toMatch(/docker-build\.sh|docker-e2e-image\.sh/);
      expect(script, path).not.toMatch(/\bdocker build\b/);
      expect(script, path).not.toMatch(/run_logged\s+\S+\s+docker\s+build/);
    }
  });

  it("preserves pnpm lookup paths for scheduled Docker child lanes", () => {
    const scheduler = readFileSync(DOCKER_ALL_SCHEDULER_PATH, "utf8");

    expect(scheduler).toContain("env.PNPM_HOME");
    expect(scheduler).toContain("env.npm_execpath ? path.dirname(env.npm_execpath)");
    expect(scheduler).toContain("path.dirname(process.execPath)");
    expect(scheduler).toContain("env.PATH = [...new Set(pathEntries)].join(path.delimiter)");
    expect(scheduler).toContain("withResolvedPnpmCommand");
    expect(scheduler).toContain("OPENCLAW_DOCKER_ALL_PNPM_COMMAND");
  });

  it("runs release installer E2E against the npm beta tag", () => {
    const scenarios = readFileSync(DOCKER_E2E_SCENARIOS_PATH, "utf8");

    expect(scenarios).toContain(
      '"OPENCLAW_INSTALL_TAG=beta OPENCLAW_E2E_MODELS=both pnpm test:install:e2e"',
    );
  });

  it("passes installer tag env to bash, not curl", () => {
    const runner = readFileSync(INSTALL_E2E_RUNNER_PATH, "utf8");

    expect(runner).toContain('curl -fsSL "$INSTALL_URL" | OPENCLAW_BETA=1 bash');
    expect(runner).toContain('curl -fsSL "$INSTALL_URL" | OPENCLAW_VERSION="$INSTALL_TAG" bash');
    expect(runner).not.toContain('OPENCLAW_BETA=1 curl -fsSL "$INSTALL_URL" | bash');
    expect(runner).not.toContain(
      'OPENCLAW_VERSION="$INSTALL_TAG" curl -fsSL "$INSTALL_URL" | bash',
    );
  });

  it("keeps installer E2E agent turns out of the interactive bootstrap ritual", () => {
    const runner = readFileSync(INSTALL_E2E_RUNNER_PATH, "utf8");

    expect(runner).toContain('rm -f "$workspace/BOOTSTRAP.md"');
    expect(runner.indexOf('rm -f "$workspace/BOOTSTRAP.md"')).toBeLessThan(
      runner.indexOf('echo "==> Agent turns ($profile)"'),
    );
  });

  it("keeps installer E2E tool smokes in isolated sessions", () => {
    const runner = readFileSync(INSTALL_E2E_RUNNER_PATH, "utf8");

    expect(runner).toContain('SESSION_ID_PREFIX="e2e-tools-${profile}"');
    expect(runner).toContain('TURN1_SESSION_ID="${SESSION_ID_PREFIX}-read-proof"');
    expect(runner).toContain('TURN3_SESSION_ID="${SESSION_ID_PREFIX}-exec-hostname"');
    expect(runner).toContain('TURN4_SESSION_ID="${SESSION_ID_PREFIX}-image-write"');
  });

  it("keeps OpenAI web search smoke on one gateway agent connection", () => {
    const runner = readFileSync(OPENAI_WEB_SEARCH_MINIMAL_E2E_PATH, "utf8");

    expect(runner).toContain('"--expect-final"');
    expect(runner).toContain('[...gatewayArgs, "agent", "--params"');
    expect(runner).not.toContain('"agent.wait"');
  });
});
