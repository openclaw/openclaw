// Plugin NPM Publish tests cover publish wrapper argument safety.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const scriptPath = "scripts/plugin-npm-publish.sh";

function runPluginPublishWrapper(args: string[]) {
  return spawnSync("bash", [scriptPath, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
}

describe("plugin npm publish wrapper", () => {
  it("prints help before package or npm checks", () => {
    const result = runPluginPublishWrapper(["--help"]);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(
      "usage: bash scripts/plugin-npm-publish.sh [--dry-run|--pack-dry-run|--publish] [--candidate-tag <tag>] <package-dir>",
    );
    expect(result.stderr).toBe("");
  });

  it("rejects missing mode before package checks", () => {
    const result = runPluginPublishWrapper([]);

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe(
      "usage: bash scripts/plugin-npm-publish.sh [--dry-run|--pack-dry-run|--publish] [--candidate-tag <tag>] <package-dir>",
    );
  });

  it("rejects option-like package dirs before package checks", () => {
    const result = runPluginPublishWrapper(["--dry-run", "--wat"]);

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe("unexpected plugin npm package-dir option: --wat");
  });

  it("rejects extra arguments before package checks", () => {
    const result = runPluginPublishWrapper(["--dry-run", "extensions/telegram", "extra"]);

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe("unexpected plugin npm publish argument: extra");
  });

  it("rejects a candidate tag not derived from plugin id and exact version", () => {
    const result = runPluginPublishWrapper([
      "--dry-run",
      "--candidate-tag",
      "extended-stable-plugin-candidate-slack-2000-1-33",
      "extensions/slack",
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("candidate tag mismatch: expected");
  });

  it("requires OIDC trusted publishing and no token for candidate publication", () => {
    const version = (JSON.parse(readFileSync("package.json", "utf8")) as { version: string })
      .version;
    const result = spawnSync(
      "bash",
      [
        scriptPath,
        "--publish",
        "--candidate-tag",
        `extended-stable-plugin-candidate-slack-${version.replaceAll(".", "-")}`,
        "extensions/slack",
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          NODE_AUTH_TOKEN: "",
          NPM_TOKEN: "",
          OPENCLAW_NPM_PUBLISH_AUTH_MODE: "",
        },
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("requires GitHub OIDC trusted publishing");
  });
});
