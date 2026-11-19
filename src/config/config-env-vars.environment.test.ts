import { execFileSync } from "node:child_process";
import { it } from "vitest";
import { nativeProcessTestEntrypoints } from "../infra/native-process-runtime.test-support.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";

const owner = resolveRuntimeWorkerUrl(nativeProcessTestEntrypoints.configEnvVars);

it("preserves read ownership, snapshots and rollback across a SHARE_ENV worker", () => {
  execFileSync(
    process.execPath,
    [
      ...resolveRuntimeWorkerArgv(owner).slice(0, -1),
      "--input-type=module",
      "--eval",
      `
        import assert from 'node:assert/strict';
        import { once } from 'node:events';
        import { Worker, SHARE_ENV } from 'node:worker_threads';
        const { applyConfigEnvVars, createConfigRuntimeEnvBase, cloneEnvWithPlatformSemantics,
          snapshotEnv, restoreEnvChangesIfUnchanged, resetPublishedConfigRuntimeEnv,
          prepareConfigRuntimeEnv, getPublishedConfigRuntimeEnvState,
          withConfigReadEnvChanges, captureConfigReadEnvMutation } =
          await import(${JSON.stringify(owner.href)});
        const key = 'OPENCLAW_TEST_ENV_OWNERSHIP';
        delete process.env[key];
        const cfg = { env: { vars: { [key]: 'owned' } } };
        const before = snapshotEnv(process.env);
        applyConfigEnvVars(cfg);
        const after = snapshotEnv(process.env);
        const publishedKey = key + '_PUBLISHED';
        delete process.env[publishedKey];
        const publishedConfig = { env: { vars: { [publishedKey]: 'published' } } };
        prepareConfigRuntimeEnv({ previousConfig: {}, nextConfig: publishedConfig }).publish().commit();
        const retained = process.env;
        await withConfigReadEnvChanges(retained, async (restore) => {
          await once(new Worker('', { eval: true, env: SHARE_ENV }), 'exit');
          // Exercise stock Bun's replacement on runtimes whose worker keeps identity.
          if (process.env === retained) process.env = { ...process.env };
          const scopeKey = key + '_SCOPE';
          const scoped = { env: { vars: { [scopeKey]: 'candidate' } } };
          const custom = {};
          captureConfigReadEnvMutation(process.env, () => applyConfigEnvVars(scoped));
          captureConfigReadEnvMutation(custom, () => applyConfigEnvVars(scoped, custom));
          restore();
          assert.equal(process.env[scopeKey], undefined);
          assert.equal(custom[scopeKey], 'candidate');
        });
        assert.equal(getPublishedConfigRuntimeEnvState().ownedEnv[publishedKey], 'published');
        assert.equal(createConfigRuntimeEnvBase(publishedConfig)[publishedKey], undefined);
        assert.equal(createConfigRuntimeEnvBase(cfg)[key], undefined);
        assert.equal(createConfigRuntimeEnvBase(cfg, retained)[key], undefined);
        assert.equal(createConfigRuntimeEnvBase(cfg, cloneEnvWithPlatformSemantics(process.env))[key], undefined);
        assert.equal(createConfigRuntimeEnvBase(cfg, { ...process.env })[key], 'owned');
        restoreEnvChangesIfUnchanged({ env: process.env, before, after });
        assert.equal(process.env[key], undefined);
        applyConfigEnvVars(cfg);
        const ownedSnapshot = snapshotEnv(process.env);
        process.env[key] = 'external';
        restoreEnvChangesIfUnchanged({ env: process.env, before, after: ownedSnapshot });
        assert.equal(process.env[key], 'external');
        process.env[key] = 'owned';
        resetPublishedConfigRuntimeEnv();
        assert.equal(createConfigRuntimeEnvBase(cfg, retained)[key], 'owned');
        delete process.env[key];
        const publication = prepareConfigRuntimeEnv({ previousConfig: {}, nextConfig: cfg }).publish();
        assert.equal(getPublishedConfigRuntimeEnvState().ownedEnv[key], 'owned');
        assert.equal(createConfigRuntimeEnvBase(cfg)[key], undefined);
        publication();
        assert.equal(process.env[key], undefined);
      `,
    ],
    { stdio: "pipe", timeout: 10_000 },
  );
});
