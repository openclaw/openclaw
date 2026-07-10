// OpenClaw NPM Publish tests cover publish wrapper argument safety.
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const scriptPath = "scripts/openclaw-npm-publish.sh";
const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function runPublishWrapper(
  args: string[],
  env: NodeJS.ProcessEnv = {},
  cwd: string = process.cwd(),
) {
  return spawnSync("bash", [scriptPath, ...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      OPENCLAW_NPM_EXPECTED_PACKAGE_NAME: "openclaw",
      ...env,
    },
  });
}

function makeReleaseCheckout(root: string, version: string): string {
  const checkout = path.join(root, "checkout");
  const scriptsDir = path.join(checkout, "scripts");
  mkdirSync(scriptsDir, { recursive: true });
  writeFileSync(path.join(checkout, "package.json"), JSON.stringify({ version }), "utf8");
  copyFileSync(scriptPath, path.join(checkout, scriptPath));
  copyFileSync(
    "scripts/openclaw-npm-extended-stable-release.mjs",
    path.join(checkout, "scripts/openclaw-npm-extended-stable-release.mjs"),
  );
  mkdirSync(path.join(scriptsDir, "lib"));
  copyFileSync(
    "scripts/lib/npm-publish-plan.mjs",
    path.join(checkout, "scripts/lib/npm-publish-plan.mjs"),
  );
  return checkout;
}

function makePackageTarball(root: string, packageJson?: string): string {
  const packageDir = path.join(root, "package");
  const tarball = path.join(root, "openclaw.tgz");
  mkdirSync(packageDir);
  if (packageJson === undefined) {
    writeFileSync(path.join(packageDir, "README.md"), "missing package metadata", "utf8");
  } else {
    writeFileSync(path.join(packageDir, "package.json"), packageJson, "utf8");
  }
  execFileSync("tar", ["-czf", tarball, "-C", root, "package"]);
  return tarball;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("openclaw npm publish wrapper", () => {
  it("prints help without resolving release metadata", () => {
    const result = runPublishWrapper(["--help"]);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(
      "usage: bash scripts/openclaw-npm-publish.sh (--validate package.tgz | --publish [package.tgz])",
    );
    expect(result.stderr).toBe("");
  });

  it("rejects missing publish mode before resolving release metadata", () => {
    const result = runPublishWrapper([]);

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe(
      "usage: bash scripts/openclaw-npm-publish.sh (--validate package.tgz | --publish [package.tgz])",
    );
  });

  it("requires a tarball in validation mode", () => {
    const result = runPublishWrapper(["--validate"]);

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe("error: npm publish validation requires a package tarball");
  });

  it("rejects option-like publish targets before npm publish", () => {
    const result = runPublishWrapper(["--publish", "--tag"]);

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe("error: unexpected npm publish target option: --tag");
  });

  it("rejects extra publish arguments before npm publish", () => {
    const tempRoot = makeTempDir("openclaw-npm-publish-");
    const tarball = path.join(tempRoot, "openclaw.tgz");
    writeFileSync(tarball, "placeholder", "utf8");

    const result = runPublishWrapper(["--publish", tarball, "extra"]);

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe("error: unexpected npm publish argument: extra");
  });

  it.each(["beta", "latest"])("publishes the prepared tarball to the %s dist-tag", (distTag) => {
    const tempRoot = makeTempDir("openclaw-npm-publish-");
    const binDir = path.join(tempRoot, "bin");
    const packageVersion = distTag === "beta" ? "2026.5.32-beta.1" : "2026.5.32";
    const checkout = makeReleaseCheckout(tempRoot, packageVersion);
    const tarball = makePackageTarball(
      tempRoot,
      JSON.stringify({ name: "openclaw", version: packageVersion }),
    );
    const npmLog = path.join(tempRoot, "npm.log");
    mkdirSync(binDir);
    writeFileSync(path.join(binDir, "npm"), `#!/bin/sh\nprintf '%s\\n' "$*" > "${npmLog}"\n`, {
      mode: 0o755,
    });

    const result = runPublishWrapper(
      ["--publish", tarball],
      {
        OPENCLAW_NPM_PUBLISH_TAG: distTag,
        PATH: `${binDir}:${process.env.PATH}`,
      },
      checkout,
    );

    expect(result.status).toBe(0);
    expect(readFileSync(npmLog, "utf8")).toContain(
      `publish ${tarball} --access public --tag ${distTag} --provenance --registry=https://registry.npmjs.org/ --@openclaw:registry=https://registry.npmjs.org/`,
    );
    expect(result.stdout).toContain(`Resolved publish tag: ${distTag}`);
  });

  it("validates the exact publish target without invoking npm", () => {
    const tempRoot = makeTempDir("openclaw-npm-publish-validate-");
    const binDir = path.join(tempRoot, "bin");
    const packageVersion = "2026.7.1-beta.3";
    const checkout = makeReleaseCheckout(tempRoot, packageVersion);
    const npmLog = path.join(tempRoot, "npm.log");
    mkdirSync(binDir);
    writeFileSync(
      path.join(binDir, "npm"),
      `#!/bin/sh\nprintf '%s\\n' "$*" > "${npmLog}"\nexit 99\n`,
      { mode: 0o755 },
    );
    const tarball = makePackageTarball(
      tempRoot,
      JSON.stringify({ name: "openclaw", version: packageVersion }),
    );

    const result = runPublishWrapper(
      ["--validate", tarball],
      {
        OPENCLAW_NPM_PUBLISH_TAG: "beta",
        PATH: `${binDir}:${process.env.PATH}`,
      },
      checkout,
    );

    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(npmLog)).toBe(false);
    expect(result.stdout).toContain("Validated npm publish target without mutation.");
  });

  it("resolves publish policy from the trusted wrapper instead of the target checkout", () => {
    const tempRoot = makeTempDir("openclaw-npm-publish-trusted-");
    const targetRoot = path.join(tempRoot, "target");
    const targetScripts = path.join(targetRoot, "scripts");
    const binDir = path.join(tempRoot, "bin");
    const marker = path.join(tempRoot, "target-script-ran");
    const npmLog = path.join(tempRoot, "npm.log");
    const packageVersion = "2026.7.1-beta.3";
    mkdirSync(targetScripts, { recursive: true });
    mkdirSync(binDir);
    writeFileSync(
      path.join(targetRoot, "package.json"),
      JSON.stringify({ version: packageVersion }),
    );
    writeFileSync(
      path.join(targetScripts, "openclaw-npm-extended-stable-release.mjs"),
      `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "ran"); process.exit(99);\n`,
    );
    writeFileSync(path.join(binDir, "npm"), `#!/bin/sh\nprintf '%s\\n' "$*" > "${npmLog}"\n`, {
      mode: 0o755,
    });
    const tarball = makePackageTarball(
      tempRoot,
      JSON.stringify({ name: "openclaw", version: packageVersion }),
    );

    const result = spawnSync("bash", [path.resolve(scriptPath), "--publish", tarball], {
      cwd: targetRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        OPENCLAW_NPM_EXPECTED_PACKAGE_NAME: "openclaw",
        OPENCLAW_NPM_PUBLISH_TAG: "beta",
        PATH: `${binDir}:${process.env.PATH}`,
      },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(marker)).toBe(false);
    expect(readFileSync(npmLog, "utf8")).toContain(
      `publish ${tarball} --access public --tag beta --provenance --registry=https://registry.npmjs.org/ --@openclaw:registry=https://registry.npmjs.org/`,
    );
  });

  it("requires the expected package name before publishing a tarball", () => {
    const tempRoot = makeTempDir("openclaw-npm-publish-");
    const packageVersion = JSON.parse(readFileSync("package.json", "utf8")).version as string;
    const tarball = makePackageTarball(
      tempRoot,
      JSON.stringify({ name: "openclaw", version: packageVersion }),
    );
    const result = runPublishWrapper(["--publish", tarball], {
      OPENCLAW_NPM_EXPECTED_PACKAGE_NAME: "",
      OPENCLAW_NPM_PUBLISH_TAG: "beta",
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      "OPENCLAW_NPM_EXPECTED_PACKAGE_NAME must be openclaw or @openclaw/ai",
    );
  });

  it("rejects a tarball whose package name differs from the approved package", () => {
    const tempRoot = makeTempDir("openclaw-npm-publish-");
    const packageVersion = JSON.parse(readFileSync("package.json", "utf8")).version as string;
    const tarball = makePackageTarball(
      tempRoot,
      JSON.stringify({ name: "@openclaw/ai", version: packageVersion }),
    );
    const result = runPublishWrapper(["--publish", tarball], {
      OPENCLAW_NPM_PUBLISH_TAG: "beta",
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      "npm publish tarball package name mismatch: expected openclaw, got @openclaw/ai",
    );
  });

  it("rejects target-controlled npm publish configuration", () => {
    const tempRoot = makeTempDir("openclaw-npm-publish-");
    const packageVersion = JSON.parse(readFileSync("package.json", "utf8")).version as string;
    const tarball = makePackageTarball(
      tempRoot,
      JSON.stringify({
        name: "openclaw",
        version: packageVersion,
        publishConfig: { registry: "https://attacker.example/" },
      }),
    );
    const result = runPublishWrapper(["--publish", tarball], {
      OPENCLAW_NPM_PUBLISH_TAG: "beta",
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("npm publish tarball publishConfig is not allowed");
  });

  it("allows the AI package's exact public-access publish configuration", () => {
    const tempRoot = makeTempDir("openclaw-npm-publish-");
    const binDir = path.join(tempRoot, "bin");
    const packageVersion = "2026.7.1-beta.3";
    const checkout = makeReleaseCheckout(tempRoot, packageVersion);
    const npmLog = path.join(tempRoot, "npm.log");
    mkdirSync(binDir);
    writeFileSync(path.join(binDir, "npm"), `#!/bin/sh\nprintf '%s\\n' "$*" > "${npmLog}"\n`, {
      mode: 0o755,
    });
    const tarball = makePackageTarball(
      tempRoot,
      JSON.stringify({
        name: "@openclaw/ai",
        version: packageVersion,
        publishConfig: { access: "public" },
      }),
    );

    const result = runPublishWrapper(
      ["--publish", tarball],
      {
        OPENCLAW_NPM_EXPECTED_PACKAGE_NAME: "@openclaw/ai",
        OPENCLAW_NPM_PUBLISH_TAG: "beta",
        PATH: `${binDir}:${process.env.PATH}`,
      },
      checkout,
    );

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(npmLog, "utf8")).toContain(
      `publish ${tarball} --access public --tag beta --provenance --registry=https://registry.npmjs.org/ --@openclaw:registry=https://registry.npmjs.org/`,
    );
  });

  it("requires the AI package's exact public-access publish configuration", () => {
    const tempRoot = makeTempDir("openclaw-npm-publish-");
    const packageVersion = JSON.parse(readFileSync("package.json", "utf8")).version as string;
    const tarball = makePackageTarball(
      tempRoot,
      JSON.stringify({
        name: "@openclaw/ai",
        version: packageVersion,
      }),
    );

    const result = runPublishWrapper(["--validate", tarball], {
      OPENCLAW_NPM_EXPECTED_PACKAGE_NAME: "@openclaw/ai",
      OPENCLAW_NPM_PUBLISH_TAG: "beta",
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      "npm publish tarball publishConfig may only contain access=public",
    );
  });

  it("rejects a tarball whose package version differs from the checkout", () => {
    const tempRoot = makeTempDir("openclaw-npm-publish-");
    const packageVersion = JSON.parse(readFileSync("package.json", "utf8")).version as string;
    const tarballVersion = `${packageVersion}-mismatch`;
    const tarball = makePackageTarball(
      tempRoot,
      JSON.stringify({ name: "openclaw", version: tarballVersion }),
    );
    const result = runPublishWrapper(["--publish", tarball], {
      OPENCLAW_NPM_PUBLISH_TAG: "beta",
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      `npm publish tarball version mismatch: expected ${packageVersion}, got ${tarballVersion}`,
    );
  });

  it.each([
    ["missing package.json", undefined, "missing a readable package/package.json"],
    ["malformed package.json", "{not-json", "package/package.json is malformed"],
    ["missing version", JSON.stringify({ name: "openclaw" }), "has no valid version"],
  ])("rejects a tarball with %s", (_label, packageJson, expectedError) => {
    const tempRoot = makeTempDir("openclaw-npm-publish-");
    const tarball = makePackageTarball(tempRoot, packageJson);
    const result = runPublishWrapper(["--publish", tarball], {
      OPENCLAW_NPM_PUBLISH_TAG: "beta",
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(expectedError);
  });

  it("rejects publishing the current pre-.33 final version to extended-stable", () => {
    const tempRoot = makeTempDir("openclaw-npm-publish-");
    const checkout = makeReleaseCheckout(tempRoot, "2026.5.32");
    const result = runPublishWrapper(
      ["--publish"],
      {
        OPENCLAW_NPM_PUBLISH_TAG: "extended-stable",
      },
      checkout,
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "Extended-stable npm publication requires release patch 33 or above",
    );
  });

  it("publishes a pre-.33 final version to extended-stable with the explicit bypass", () => {
    const tempRoot = makeTempDir("openclaw-npm-publish-");
    const binDir = path.join(tempRoot, "bin");
    const checkout = makeReleaseCheckout(tempRoot, "2026.5.32");
    const npmLog = path.join(tempRoot, "npm.log");
    mkdirSync(binDir);
    writeFileSync(path.join(binDir, "npm"), `#!/bin/sh\nprintf '%s\\n' "$*" > "${npmLog}"\n`, {
      mode: 0o755,
    });

    const result = runPublishWrapper(
      ["--publish"],
      {
        BYPASS_EXTENDED_STABLE_GUARD: "true",
        OPENCLAW_NPM_PUBLISH_TAG: "extended-stable",
        PATH: `${binDir}:${process.env.PATH}`,
      },
      checkout,
    );

    expect(result.status).toBe(0);
    expect(readFileSync(npmLog, "utf8")).toContain(
      "publish --access public --tag extended-stable --provenance",
    );
    expect(result.stdout).toContain("Resolved publish tag: extended-stable");
  });

  it.each([
    ["malformed bypass", "extended-stable", "sometimes", 'must be "true" or "false"'],
    [
      "non-extended-stable bypass",
      "beta",
      "true",
      "only be used with the extended-stable npm dist-tag",
    ],
  ])("rejects %s before npm publish", (_label, distTag, bypass, expectedError) => {
    const result = runPublishWrapper(["--publish"], {
      BYPASS_EXTENDED_STABLE_GUARD: bypass,
      OPENCLAW_NPM_PUBLISH_TAG: distTag,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(expectedError);
  });

  it("rejects unknown requested dist-tags instead of falling back to beta", () => {
    const result = runPublishWrapper(["--publish"], {
      OPENCLAW_NPM_PUBLISH_TAG: "nightly",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Unsupported npm dist-tag "nightly"');
  });
});
