import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const PUBLISH_SCRIPT = "scripts/plugin-npm-publish.sh";
const WORKFLOW = ".github/workflows/plugin-npm-release.yml";

function writePackage(packageDir: string, version: string) {
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(
    join(packageDir, "package.json"),
    `${JSON.stringify({ name: "@openclaw/test-plugin", version }, null, 2)}\n`,
  );
}

function writeFakeNpm(binDir: string, record: string) {
  mkdirSync(binDir, { recursive: true });
  process.env.OPENCLAW_PLUGIN_NPM_MANIFEST_OVERLAY_NPM = join(binDir, "npm");
  process.env.OPENCLAW_TEST_NPM_RECORD = record;
  writeFileSync(
    join(binDir, "npm"),
    `#!/usr/bin/env bash
set -euo pipefail
: "\${OPENCLAW_TEST_NPM_RECORD:?}"
case "\${1:-}" in
  view)
    exit 1
    ;;
  publish)
    if [[ -n "\${NPM_TOKEN:-}" || -n "\${NODE_AUTH_TOKEN:-}" || -n "\${NPM_CONFIG_USERCONFIG:-}" ]]; then
      echo "trusted publish subprocess received npm auth env" >&2
      env | sort > "\${OPENCLAW_TEST_NPM_RECORD}"
      exit 66
    fi
    printf '%s\n' "publish token env absent" > "\${OPENCLAW_TEST_NPM_RECORD}"
    ;;
  dist-tag)
    if [[ -z "\${NPM_CONFIG_USERCONFIG:-}" ]]; then
      echo "dist-tag mirror missing npm userconfig" >&2
      exit 67
    fi
    echo "dist-tag \${*}" >> "\${OPENCLAW_TEST_NPM_RECORD}"
    ;;
  install)
    if [[ "\${*}" != "install --package-lock-only --ignore-scripts --no-audit --no-fund" ]]; then
      echo "unexpected npm install command: \${*}" >&2
      exit 64
    fi
    ;;
  shrinkwrap)
    if [[ "\${*}" != "shrinkwrap --ignore-scripts --no-audit --no-fund" ]]; then
      echo "unexpected npm shrinkwrap command: \${*}" >&2
      exit 64
    fi
    node --input-type=module <<'NODE'
import { readFileSync, writeFileSync } from "node:fs";
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
writeFileSync(
  "npm-shrinkwrap.json",
  JSON.stringify({ lockfileVersion: 3, packages: { "": pkg } }, null, 2) + "\\n",
);
NODE
    ;;
  *)
    echo "unexpected npm command: \${*}" >&2
    exit 64
    ;;
esac
`,
    { mode: 0o755 },
  );
}

type Fixture = { root: string; binDir: string; packageDir: string; record: string };

function writeFixtureShrinkwrap({ binDir, packageDir, record }: Fixture) {
  const result = spawnSync(
    "node",
    ["scripts/generate-npm-shrinkwrap.mjs", "--package-dir", packageDir],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        OPENCLAW_TEST_NPM_RECORD: record,
      },
    },
  );
  expect(
    result.status,
    `${result.stdout}
${result.stderr}`,
  ).toBe(0);
}

function withFixture(testBody: (fixture: Fixture) => void) {
  const root = mkdtempSync(join(tmpdir(), "openclaw-plugin-npm-token-boundary-"));
  try {
    const binDir = join(root, "bin");
    const packageDir = join(root, "package");
    const record = join(root, "record.txt");
    writeFakeNpm(binDir, record);
    testBody({ root, binDir, packageDir, record });
    delete process.env.OPENCLAW_PLUGIN_NPM_MANIFEST_OVERLAY_NPM;
    delete process.env.OPENCLAW_TEST_NPM_RECORD;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("plugin npm trusted-publishing token boundary", () => {
  it("keeps npm auth env out of the trusted-publishing package publish subprocess", () => {
    withFixture((fixture) => {
      const { binDir, packageDir, record } = fixture;
      writePackage(packageDir, "2026.4.1-beta.1");
      writeFixtureShrinkwrap(fixture);

      const result = spawnSync("bash", [PUBLISH_SCRIPT, "--publish-package", packageDir], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
          OPENCLAW_NPM_PUBLISH_AUTH_MODE: "trusted-publisher",
          OPENCLAW_PLUGIN_NPM_RUNTIME_BUILD: "0",
          OPENCLAW_TEST_NPM_RECORD: record,
          NODE_AUTH_TOKEN: "node-auth-secret",
          NPM_CONFIG_USERCONFIG: "/tmp/should-not-leak-to-publish",
          NPM_TOKEN: "npm-secret",
        },
      });

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(readFileSync(record, "utf8")).toBe("publish token env absent\n");
    });
  });

  it("refuses stable package publish before mirror auth availability is confirmed", () => {
    withFixture(({ binDir, packageDir, record }) => {
      writePackage(packageDir, "2026.4.1");

      const result = spawnSync("bash", [PUBLISH_SCRIPT, "--publish-package", packageDir], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
          OPENCLAW_NPM_PUBLISH_AUTH_MODE: "trusted-publisher",
          OPENCLAW_PLUGIN_NPM_RUNTIME_BUILD: "0",
          OPENCLAW_TEST_NPM_RECORD: record,
        },
      });

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(1);
      expect(result.stderr).toContain(
        "requires confirmed npm auth availability before package publish",
      );
      expect(existsSync(record) ? readFileSync(record, "utf8") : "").toBe("");
    });
  });

  it("allows stable trusted-publisher package publish with only mirror auth availability", () => {
    withFixture((fixture) => {
      const { binDir, packageDir, record } = fixture;
      writePackage(packageDir, "2026.4.1");
      writeFixtureShrinkwrap(fixture);

      const result = spawnSync("bash", [PUBLISH_SCRIPT, "--publish-package", packageDir], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
          OPENCLAW_NPM_DIST_TAG_MIRROR_AUTH_AVAILABLE: "1",
          OPENCLAW_NPM_PUBLISH_AUTH_MODE: "trusted-publisher",
          OPENCLAW_PLUGIN_NPM_RUNTIME_BUILD: "0",
          OPENCLAW_TEST_NPM_RECORD: record,
        },
      });

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(readFileSync(record, "utf8")).toBe("publish token env absent\n");
    });
  });

  it("runs dist-tag mirroring as a separate npm-authenticated path", () => {
    withFixture(({ binDir, packageDir, record }) => {
      writePackage(packageDir, "2026.4.1");

      const result = spawnSync("bash", [PUBLISH_SCRIPT, "--mirror-dist-tags", packageDir], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
          OPENCLAW_TEST_NPM_RECORD: record,
          NPM_TOKEN: "npm-secret",
        },
      });

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(readFileSync(record, "utf8")).toContain(
        "dist-tag dist-tag add @openclaw/test-plugin@2026.4.1 beta",
      );
    });
  });

  it("does not expose NPM_TOKEN on the trusted-publishing workflow step", () => {
    const workflow = readFileSync(WORKFLOW, "utf8");
    const publishStep =
      workflow.match(
        /- name: Publish package with npm trusted publishing[\s\S]*?(?=\n\s*- name: Mirror stable-release npm dist-tags)/,
      )?.[0] ?? "";
    const mirrorStep =
      workflow.match(
        /- name: Mirror stable-release npm dist-tags[\s\S]*?(?=\n\s*- name: Verify published runtime)/,
      )?.[0] ?? "";

    expect(publishStep).not.toBe("");
    expect(publishStep).not.toContain("NPM_TOKEN: ${{ secrets.NPM_TOKEN }}");
    expect(publishStep).toContain("--publish-package");
    expect(publishStep).toContain("OPENCLAW_NPM_DIST_TAG_MIRROR_AUTH_AVAILABLE");
    expect(mirrorStep).not.toBe("");
    expect(mirrorStep).toContain("NPM_TOKEN");
    expect(mirrorStep).toContain("--mirror-dist-tags");
  });
});
