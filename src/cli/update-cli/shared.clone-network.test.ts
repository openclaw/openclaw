import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as backoff from "../../infra/backoff.js";
import { reserveTestPortListener } from "../../test-utils/port-claims.js";
import { ensureGitCheckout } from "./shared.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it("clones through native Git after two truncated HTTP pack responses", async () => {
  const root = dirs.make("update-clone-http-");
  const source = path.join(root, "repository.git");
  const destination = path.join(root, "checkout");
  const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8" });
  git("init", "--quiet", source);
  await fs.writeFile(path.join(source, "fixture.txt"), "complete clone payload\n");
  git("-C", source, "add", "fixture.txt");
  git(
    "-C",
    source,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.com",
    "commit",
    "--quiet",
    "-m",
    "fixture",
  );
  const sha = git("-C", source, "rev-parse", "HEAD").trim();
  let packs = 0;
  const reservation = await reserveTestPortListener({
    offsets: [0],
    createListener: () =>
      createServer((request, response) => {
        void (async () => {
          const url = new URL(request.url ?? "/", "http://localhost");
          const chunks: Buffer[] = [];
          for await (const chunk of request) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
          }
          const input = Buffer.concat(chunks);
          const cgi = execFileSync("git", ["http-backend"], {
            input,
            env: {
              ...process.env,
              GIT_PROJECT_ROOT: root,
              GIT_HTTP_EXPORT_ALL: "1",
              REQUEST_METHOD: request.method,
              PATH_INFO: url.pathname,
              QUERY_STRING: url.search.slice(1),
              CONTENT_TYPE: request.headers["content-type"],
              CONTENT_LENGTH: String(input.length),
            },
          });
          const split = cgi.indexOf("\r\n\r\n");
          const headers = cgi.subarray(0, split).toString("utf8");
          const body = cgi.subarray(split + 4);
          const type = /^Content-Type: (.+)$/imu.exec(headers)?.[1]?.trim();
          response.writeHead(200, {
            "Content-Type": type ?? "application/octet-stream",
            "Content-Length": body.length,
            Connection: "close",
          });
          response.end(
            url.pathname.endsWith("/git-upload-pack") && ++packs <= 2
              ? body.subarray(0, Math.max(0, body.length - 32))
              : body,
          );
        })().catch((error: unknown) => {
          response.destroy(error instanceof Error ? error : new Error(String(error)));
        });
      }),
  });
  const wait = vi.spyOn(backoff, "sleepWithAbort").mockResolvedValue();
  try {
    const result = await ensureGitCheckout({
      dir: destination,
      timeoutMs: 30_000,
      env: {
        ...process.env,
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: `url.http://127.0.0.1:${reservation.claim.port}/repository.git.insteadOf`,
        GIT_CONFIG_VALUE_0: "https://github.com/openclaw/openclaw.git",
        GIT_TERMINAL_PROMPT: "0",
      },
    });
    expect(result.step?.exitCode, result.step?.stderrTail ?? undefined).toBe(0);
    expect(packs).toBe(3);
    expect(wait.mock.calls.map(([delay]) => delay)).toEqual([1_000, 5_000]);
    expect(git("-C", destination, "rev-parse", "HEAD").trim()).toBe(sha);
    expect(await fs.readFile(path.join(destination, "fixture.txt"), "utf8")).toBe(
      "complete clone payload\n",
    );
    expect((await fs.readdir(root)).toSorted()).toEqual(["checkout", "repository.git"]);
  } finally {
    await reservation.releaseListener();
    await reservation.claim.release();
  }
});
