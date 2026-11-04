import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// pnpm's isolated linker only links a package's direct dependencies into its own node_modules.
// gaxios is a dependency of google-auth-library (which extensions/google declares directly), and
// the failing chain (#38327) runs inside gaxios's own dependency dir: Gaxios.#getFetch →
// `await import("node-fetch")` → node-fetch's node-domexception → the CJS→ESM translator crash.
// Anchoring a createRequire at google-auth-library's real path reproduces that exact resolution.
const googlePackageDir = path.resolve(repoRoot, "extensions/google");
const googleAuthAnchor = path.join(
  realpathSync(path.join(googlePackageDir, "node_modules/google-auth-library")),
  "package.json",
);

function runNodeScript(script: string, cwd = googlePackageDir, extraEnv: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, ["-e", script], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...extraEnv },
  });
}

function formatChildFailure(result: ReturnType<typeof runNodeScript>) {
  return [
    `status=${result.status ?? "null"}`,
    result.error ? `error=${result.error.message}` : null,
    result.stdout ? `stdout:\n${result.stdout}` : null,
    result.stderr ? `stderr:\n${result.stderr}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

describe("google auth import regression", () => {
  it("loads gaxios fetch dependencies for data urls", () => {
    const result = runNodeScript(
      `
      const { createRequire } = require("node:module");
      const req = createRequire(process.env.GAXIOS_ANCHOR);
      const { Gaxios } = req("gaxios");

      (async () => {
        const client = new Gaxios();
        const response = await client.request({
          url: "data:text/plain,ok",
          responseType: "text",
          retry: false,
        });
        console.log(JSON.stringify({ status: response.status, data: response.data }));
      })().catch(error => {
        console.error(error?.stack ?? String(error));
        process.exit(1);
      });
    `,
      googlePackageDir,
      { GAXIOS_ANCHOR: googleAuthAnchor },
    );

    expect(result.status, formatChildFailure(result)).toBe(0);
    expect(result.stdout).toContain('"data":"ok"');
  });

  it("imports google-auth-library without loader crashes", () => {
    const result = runNodeScript(`
      const { JWT } = require("google-auth-library");
      const client = new JWT({
        email: "test@example.com",
        key: "-----BEGIN PRIVATE KEY-----\\ninvalid\\n-----END PRIVATE KEY-----\\n",
        scopes: ["https://www.googleapis.com/auth/cloud-platform"],
      });
      console.log(typeof client.getRequestHeaders);
    `);

    expect(result.status, formatChildFailure(result)).toBe(0);
    expect(result.stdout.trim()).toBe("function");
  });
});
