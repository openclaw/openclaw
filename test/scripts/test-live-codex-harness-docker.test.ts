import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT_PATH = path.resolve(
  import.meta.dirname,
  "../../scripts/test-live-codex-harness-docker.sh",
);

describe("scripts/test-live-codex-harness-docker.sh", () => {
  it("mounts cache and npm tool dirs outside the bind-mounted Docker home", () => {
    const script = fs.readFileSync(SCRIPT_PATH, "utf8");

    expect(script).toContain('DOCKER_CACHE_CONTAINER_DIR="/tmp/openclaw-cache"');
    expect(script).toContain('DOCKER_CLI_TOOLS_CONTAINER_DIR="/tmp/openclaw-npm-global"');
    expect(script).toContain('-e XDG_CACHE_HOME="$DOCKER_CACHE_CONTAINER_DIR"');
    expect(script).toContain('-e NPM_CONFIG_PREFIX="$DOCKER_CLI_TOOLS_CONTAINER_DIR"');
    expect(script).toContain('-v "$CACHE_HOME_DIR":"$DOCKER_CACHE_CONTAINER_DIR"');
    expect(script).toContain('-v "$CLI_TOOLS_DIR":"$DOCKER_CLI_TOOLS_CONTAINER_DIR"');
    expect(script).not.toContain('-v "$CACHE_HOME_DIR":/home/node/.cache');
    expect(script).not.toContain('-v "$CLI_TOOLS_DIR":/home/node/.npm-global');
  });
});
