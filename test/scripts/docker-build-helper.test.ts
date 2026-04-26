import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const HELPER_PATH = "scripts/lib/docker-build.sh";
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
});
