import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPluginNpmPublicationReadback } from "../../scripts/plugin-npm-publication-readback.mjs";
import { scriptProcessEntrypoints } from "../../scripts/script-process-runtime.test-support.js";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "../../src/infra/runtime-worker-url.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import {
  createNpmPublicationReadbackFixture,
  packageName,
  sourceSha,
  version,
  workflowSha,
} from "./plugin-npm-publication-readback.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("full parent publication verifier entrypoint", () => {
  it.each([
    "none",
    "no-publish",
    "missing-tarball",
    "conflicting-bytes",
    "missing-receipt",
    "missing-planned-job",
    "prior-missing-tarball",
    "prior-conflicting-bytes",
    "prior-archive-identity",
  ])("gates release success on qualified plugin readback: %s", async (fault) => {
    const root = tempDirs.make("parent-publish-cli-");
    const fixture = await createNpmPublicationReadbackFixture(
      root,
      fault.startsWith("prior-") ? "prior-deferred" : "direct",
      fault.replace(/^prior-/u, ""),
    );
    const readback = await createPluginNpmPublicationReadback(fixture.options).catch(
      () => undefined,
    );
    await readback?.verify(packageName, version, "beta").catch(() => undefined);
    writeFileSync(join(root, "gh-responses.json"), JSON.stringify(fixture.ghResponses));
    writeFileSync(join(root, "transfers.json"), JSON.stringify(fixture.transferResponses));
    writeFileSync(join(root, "package.json"), JSON.stringify({ version }));
    const bin = join(root, "bin");
    mkdirSync(bin);
    const ghScript = `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "api") {
  const replies = JSON.parse(fs.readFileSync(process.env.GH_FIXTURE, "utf8"));
  if (!replies[args[1]]) throw new Error("Unexpected GitHub request: " + args.join(" "));
  console.log(replies[args[1]]);
} else if (args[0] === "run" && args[1] === "view" && args[2] === "${fixture.options.runId}") {
  console.log(JSON.stringify({ workflowName:"Plugin NPM Release", headBranch:"main", event:"workflow_dispatch", status:"completed", conclusion:"success", jobs:[] }));
} else { throw new Error("Unexpected GitHub command: " + args.join(" ")); }
`;
    const npmScript = `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] !== "view") throw new Error("Unexpected npm mutation");
console.log(JSON.stringify(args[2] === "dist-tags" ? {beta:${JSON.stringify(version)}} : {
  version:${JSON.stringify(version)}, "dist-tags.beta":${JSON.stringify(version)},
  "dist.integrity":"sha512-core-fixture", "dist.tarball":"https://registry.npmjs.org/openclaw/-/core.tgz"
}));
`;
    writeFileSync(join(bin, "gh"), ghScript, { mode: 0o755 });
    writeFileSync(join(bin, "npm"), npmScript, { mode: 0o755 });
    writeFileSync(
      join(bin, "git"),
      `#!/bin/sh\n[ "$*" = 'rev-parse HEAD' ] || exit 99\nprintf '%s\\n' '${sourceSha}'\n`,
      { mode: 0o755 },
    );
    const preload = join(root, "fetch.mjs");
    writeFileSync(
      preload,
      `import fs from "node:fs";
const replies = JSON.parse(fs.readFileSync(process.env.TRANSFER_FIXTURE, "utf8"));
globalThis.fetch = async (url) => {
  const reply = replies[url];
  if (!reply) throw new Error("Unexpected network request: " + url);
  return new Response(Buffer.from(reply.bytes, "base64"), {status:reply.status});
};
`,
    );
    const result = spawnSync(
      process.execPath,
      [
        ...resolveRuntimeWorkerArgv(
          resolveRuntimeWorkerUrl(scriptProcessEntrypoints.releaseVerifyPublish),
        ).slice(0, -1),
        "--import",
        preload,
        ...resolveRuntimeWorkerArgv(
          resolveRuntimeWorkerUrl(scriptProcessEntrypoints.releaseVerifyPublish),
        ).slice(-1),
        version,
        "--release-sha",
        sourceSha,
        "--workflow-ref",
        "main",
        "--plugin-npm-run",
        String(fixture.options.runId),
        "--skip-postpublish",
        "--skip-github-release",
        "--skip-clawhub",
        "--evidence-out",
        "parent-evidence.json",
      ],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 30_000,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          GITHUB_WORKFLOW_SHA: workflowSha,
          GH_TOKEN: "synthetic-token",
          GH_FIXTURE: join(root, "gh-responses.json"),
          TRANSFER_FIXTURE: join(root, "transfers.json"),
        },
      },
    );
    const succeeded = fault === "none" || fault === "no-publish";
    expect(result.status, result.stderr).toBe(succeeded ? 0 : 1);
    const evidencePath = join(root, "parent-evidence.json");
    expect(existsSync(evidencePath)).toBe(succeeded);
    if (fault === "none") {
      expect(
        JSON.parse(readFileSync(evidencePath, "utf8")).pluginNpmPublicationReadbacks,
      ).toMatchObject([
        {
          packageName,
          sourceSha,
          workflowSha,
          childRunId: 200,
          childRunAttempt: 2,
          producerRunId: 200,
          producerRunAttempt: 2,
          artifactId: 41,
        },
      ]);
    } else if (fault === "no-publish") {
      expect(
        JSON.parse(readFileSync(evidencePath, "utf8")).pluginNpmPublicationReadbacks,
      ).toMatchObject([{ packageName, verification: "published-registry" }]);
    } else {
      expect(result.stderr).toContain(
        fault === "missing-planned-job"
          ? "planned candidate"
          : fault === "missing-receipt"
            ? "Expected one consumed"
            : fault.endsWith("missing-tarball")
              ? "HTTP 404"
              : fault === "prior-archive-identity"
                ? "archive package identity"
                : "bytes differ",
      );
    }
  });

  it.each([true, false])("routes full publication=%s to its owning verifier", (fullPublication) => {
    const root = tempDirs.make("parent-verifier-route-");
    const argsLog = join(root, "args");
    const script = `set -euo pipefail
source "$HELPER"
write_clawhub_runtime_state() { printf '%s\\n' '{"verifierArgs":["--skip-clawhub"]}' > "$1"; }
node() { printf '%s\\n' "$@" > "$ARGS_LOG"; return 79; }
plugin_npm_run_id=200
openclaw_npm_run_id=""
clawhub_workflow_ref=main
bootstrap_plugins=""
verify_published_release
`;
    const result = spawnSync("bash", ["-c", script], {
      encoding: "utf8",
      env: {
        ...process.env,
        HELPER: resolve("scripts/lib/release-publish-children.sh"),
        ARGS_LOG: argsLog,
        GITHUB_REF: "refs/heads/main",
        PARENT_WORKFLOW_SHA: workflowSha,
        RELEASE_TAG: `v${version}`,
        POSTPUBLISH_EVIDENCE_DIR: join(root, "evidence"),
        GITHUB_REPOSITORY: "openclaw/openclaw",
        TARGET_SHA: sourceSha,
        CHILD_WORKFLOW_REF: "main",
        RELEASE_NPM_DIST_TAG: "beta",
        RUNNER_TEMP: root,
        PLUGINS: "",
        NPM_TELEGRAM_RUN_ID: "",
        GITHUB_WORKSPACE: root,
        PUBLISH_OPENCLAW_NPM: String(fullPublication),
      },
    });
    expect(result.status, result.stderr).toBe(79);
    const args = readFileSync(argsLog, "utf8").split("\n");
    expect(args[2]).toBe(
      join(
        root,
        ".release-harness/scripts",
        fullPublication ? "release-verify-publish.ts" : "release-verify-beta.ts",
      ),
    );
  });
});
