import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, expect, it } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";

// Exercise the native host graph used by loaded plugins, rather than a transformed copy.
const requireHost = createRequire(import.meta.url);
const { createEmbeddedRunHandle } = requireHost(
  "../agents/embedded-agent-runner/runs.test-support.ts",
) as typeof import("../agents/embedded-agent-runner/runs.test-support.js");
const { admitted, attempt } = requireHost(
  "../agents/harness/tool-authority.runtime.test-support.ts",
) as typeof import("../agents/harness/tool-authority.runtime.test-support.js");
const { withPreparedEmbeddedRunToolAuthority } = requireHost(
  "../agents/harness/tool-authority.runtime.ts",
) as typeof import("../agents/harness/tool-authority.runtime.js");
const { resolveControllerNativeAttempt } = requireHost(
  "../sessions/session-controller.state.ts",
) as typeof import("../sessions/session-controller.state.js");
const { createPluginModuleLoader } = requireHost(
  "./loader-module-runtime.ts",
) as typeof import("./loader-module-runtime.js");
const { resetPluginCache } = requireHost("./plugin-cache.ts") as typeof import("./plugin-cache.js");

const tempDirs = createTempDirTracker();
afterEach(() => {
  resetPluginCache();
  tempDirs.cleanup();
});

it.each(["cjs", "mjs"])(
  "preserves host admission through a compiled %s harness",
  async (format) => {
    const file = path.join(tempDirs.make("harness-host-admission-"), `index.${format}`);
    fs.writeFileSync(
      file,
      `${
        format === "cjs"
          ? 'const { setActiveEmbeddedRun } = require("openclaw/plugin-sdk/agent-harness-runtime");'
          : 'import { setActiveEmbeddedRun } from "openclaw/plugin-sdk/agent-harness-runtime";'
      }
${format === "cjs" ? "exports.register = async function" : "export async function register"}(params, handle) {
  await Promise.resolve();
  return setActiveEmbeddedRun(params.sessionId, handle, params.sessionKey, params.sessionFile, params.agentId);
};`,
    );
    const { register } = createPluginModuleLoader({})(file) as {
      register: (
        params: typeof attempt,
        handle: ReturnType<typeof createEmbeddedRunHandle>,
      ) => Promise<(() => void) | undefined>;
    };
    const handle = createEmbeddedRunHandle({ runId: attempt.runId });
    await expect(register(attempt, handle)).rejects.toMatchObject({
      code: "SESSION_CONTROLLER_ADMISSION_REQUIRED",
    });
    await admitted(async ({ admittedRunContext }) =>
      withPreparedEmbeddedRunToolAuthority(
        { admittedRunContext },
        attempt,
        undefined,
        async (prepared) => {
          handle.toolAuthorityFingerprint = prepared.toolAuthorityFingerprint;
          const cleanup = expectDefined(
            await register(prepared, handle),
            "admitted native cleanup",
          );
          try {
            expect(resolveControllerNativeAttempt(attempt.sessionId)).toBe(handle);
          } finally {
            cleanup();
          }
          expect(resolveControllerNativeAttempt(attempt.sessionId)).toBeUndefined();
        },
      ),
    );
  },
);
