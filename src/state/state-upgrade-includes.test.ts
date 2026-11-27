import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  cliCleanupRetirementEntrypoints,
  doctorOutputEntrypoints,
} from "../cli/cli-entrypoint.test-support.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { spawnNodeEvalSync } from "../test-utils/node-process.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
const registrar = resolveRuntimeWorkerUrl(doctorOutputEntrypoints.maintenance);
const moduleUrl = (relative: string) => JSON.stringify(new URL(relative, registrar).href);

it("repairs an included legacy config without flattening and restores both authored files", () => {
  const root = fs.realpathSync(dirs.make("state-upgrade-includes-"));
  // Reuse the prepared native graph and executable cleanup owner, not cold source loaders.
  const result = spawnNodeEvalSync(
    String.raw`
      import assert from "node:assert/strict";
      import fs from "node:fs";
      import path from "node:path";
      import { runInNewContext } from "node:vm";
      import { upgradeStateDirectory } from ${moduleUrl("../../state/state-upgrade.js")};
      import { acquireGatewayLock } from ${moduleUrl("../../infra/gateway-lock.js")};
      import { checkRelease } from ${moduleUrl("../../update/check-release.js")};
      import { createTrialPending, resolvePrefix, writeTrial } from ${moduleUrl("../../update/store.js")};
      import { LEGACY_ROLLBACK_SOURCE } from ${moduleUrl("../../update/legacy-rollback-source.js")};
      import { resolveRuntimeServiceBuildId, VERSION } from ${moduleUrl("../../version.js")};
      import { withCliCommandCleanup, withCliProcessScope } from ${JSON.stringify(resolveRuntimeWorkerUrl(cliCleanupRetirementEntrypoints.scope).href)};
      import { closeCliResources } from ${JSON.stringify(resolveRuntimeWorkerUrl(cliCleanupRetirementEntrypoints.cleanup).href)};
      await withCliProcessScope(() => withCliCommandCleanup(false, async cleanup => {
      try {
      const env = process.env;
      const stateDir = env.OPENCLAW_STATE_DIR;
      const configPath = env.OPENCLAW_CONFIG_PATH;
      const includePath = path.join(stateDir, "diagnostics.json");
      const rootBytes = '{\n  "diagnostics": { "$include": "diagnostics.json" }\n}\n';
      const includeBytes = '{\n  "otel": { "protocol": "grpc" }\n}\n';
      fs.writeFileSync(configPath, rootBytes);
      fs.writeFileSync(includePath, includeBytes);
      const admission = await checkRelease({ env, configPath });
      assert.equal(admission.ok, true, admission.reason);
      assert.equal(fs.readFileSync(configPath, "utf8"), rootBytes);
      assert.equal(fs.readFileSync(includePath, "utf8"), includeBytes);
      const prefix = resolvePrefix(env);
      const target = path.join(prefix, "releases", "include-candidate", "openclaw");
      fs.mkdirSync(target, { recursive: true });
      const pending = await createTrialPending({
        runId: "include-repair", target, previous: stateDir, version: VERSION,
      }, prefix);
      await writeTrial({ ...pending, phase: "trial" }, prefix);
      const lock = await acquireGatewayLock({ env, role: "sqlite-maintenance", allowInTests: true });
      try {
        assert.deepEqual(await lock?.run(() =>
          upgradeStateDirectory({ env, log: { info() {}, warn() {} } }),
        ), { status: "upgraded" });
      } finally {
        await lock?.release();
      }
      assert.equal(fs.readFileSync(configPath, "utf8"), rootBytes);
      assert.deepEqual(JSON.parse(fs.readFileSync(includePath, "utf8")), { otel: {} });
      const manifest = JSON.parse(fs.readFileSync(path.join(path.dirname(target), ".restore"), "utf8"));
      assert.deepEqual(manifest.files.filter(file => file.preimage !== null).map(file => file.live).sort(),
        [configPath, includePath].sort());
      const suffix = ".pre-" + (resolveRuntimeServiceBuildId() ?? VERSION);
      assert.equal(fs.readFileSync(configPath + suffix, "utf8"), rootBytes);
      assert.equal(fs.readFileSync(includePath + suffix, "utf8"), includeBytes);
      runInNewContext(LEGACY_ROLLBACK_SOURCE + "\nrestoreState(collectPreserved(stateDir,suffix,0,4,[]),suffix);", {
        fs, path, stateDir, suffix,
      });
      assert.equal(fs.readFileSync(configPath, "utf8"), rootBytes);
      assert.equal(fs.readFileSync(includePath, "utf8"), includeBytes);
      // Trial.config can cover an external root, but a frozen launcher cannot
      // discover that root's sibling include. Refuse before imaging or writing.
      const separateState = path.join(stateDir, "separate-state");
      fs.mkdirSync(separateState);
      const externalEnv = { ...env, OPENCLAW_STATE_DIR: separateState };
      const externalAdmission = await checkRelease({ env: externalEnv, configPath });
      assert.equal(externalAdmission.ok, false);
      assert.match(externalAdmission.reason, /cannot restore changed included config/);
      const externalPrefix = resolvePrefix(externalEnv);
      const externalTarget = path.join(externalPrefix, "releases", "include-candidate", "openclaw");
      fs.mkdirSync(externalTarget, { recursive: true });
      const externalPending = await createTrialPending({
        runId: "external-include-repair", target: externalTarget, previous: separateState, version: VERSION,
      }, externalPrefix);
      await writeTrial({ ...externalPending, phase: "trial" }, externalPrefix);
      const externalLock = await acquireGatewayLock({
        env: externalEnv, role: "sqlite-maintenance", allowInTests: true,
      });
      try {
        const refused = await externalLock?.run(() =>
          upgradeStateDirectory({ env: externalEnv, log: { info() {}, warn() {} } }),
        );
        assert.equal(refused.status, "refused");
        assert.match(refused.reason, /cannot restore changed included config/);
      } finally {
        await externalLock?.release();
      }
      assert.equal(fs.readFileSync(configPath, "utf8"), rootBytes);
      assert.equal(fs.readFileSync(includePath, "utf8"), includeBytes);
      assert.equal(fs.existsSync(path.join(path.dirname(externalTarget), ".restore")), false);
      assert.equal(fs.existsSync(configPath + suffix), false);
      assert.equal(fs.existsSync(includePath + suffix), false);
      } finally {
        await closeCliResources(cleanup);
        await cleanup?.pluginResources?.release();
      }
      }));
    `,
    {
      timeout: 30_000,
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        HOME: root,
        USERPROFILE: root,
        OPENCLAW_STATE_DIR: root,
        OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
        XDG_CACHE_HOME: path.join(root, "cache"),
        JITI_FS_CACHE: "0",
      },
    },
  );
  expect(result.status, result.stderr || result.error?.message).toBe(0);
}, 40_000);
