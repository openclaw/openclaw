import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function runNodeScript(script: string) {
  return spawnSync(process.execPath, ["-e", script], {
    cwd: repoRoot,
    encoding: "utf8",
    env: process.env,
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
    const result = runNodeScript(`
      const { Gaxios } = require("gaxios");

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
    `);

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
