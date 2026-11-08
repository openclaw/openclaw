import { execFileSync } from "node:child_process";
import { it } from "vitest";
import { nativeProcessTestEntrypoints } from "./native-process-runtime.test-support.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";

const owner = resolveRuntimeWorkerUrl(nativeProcessTestEntrypoints.fsSafeEnv);

it("retires derived native modes after the first SHARE_ENV worker", () => {
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
        const { normalizeFsSafeNativeEnv, fsSafeEnvInput, clearFsSafeEnvFallback } =
          await import(${JSON.stringify(owner.href)});
        for (const key of ['FS_SAFE_NATIVE_MODE', 'OPENCLAW_FS_SAFE_NATIVE_MODE',
                          'FS_SAFE_PYTHON_MODE', 'OPENCLAW_FS_SAFE_PYTHON_MODE']) delete process.env[key];
        process.env.FS_SAFE_PYTHON_MODE = 'off';
        normalizeFsSafeNativeEnv();
        const { getFsSafeNativeConfig } = await import('@openclaw/fs-safe/config');
        assert.equal(getFsSafeNativeConfig().mode, 'off');
        const retained = process.env;
        await once(new Worker('', { eval: true, env: SHARE_ENV }), 'exit');
        assert.equal(fsSafeEnvInput(process.env).OPENCLAW_FS_SAFE_NATIVE_MODE, undefined);
        assert.equal(fsSafeEnvInput(retained).OPENCLAW_FS_SAFE_NATIVE_MODE, undefined);
        const custom = { ...process.env };
        assert.equal(fsSafeEnvInput(custom).OPENCLAW_FS_SAFE_NATIVE_MODE, 'off');
        delete process.env.FS_SAFE_PYTHON_MODE;
        normalizeFsSafeNativeEnv();
        assert.equal(process.env.OPENCLAW_FS_SAFE_NATIVE_MODE, undefined);
        assert.equal(getFsSafeNativeConfig().mode, 'auto');
        process.env.FS_SAFE_PYTHON_MODE = 'require';
        normalizeFsSafeNativeEnv();
        process.env.OPENCLAW_FS_SAFE_NATIVE_MODE = 'off';
        clearFsSafeEnvFallback(process.env);
        assert.equal(process.env.OPENCLAW_FS_SAFE_NATIVE_MODE, 'off');
      `,
    ],
    { stdio: "pipe", timeout: 10_000 },
  );
});
