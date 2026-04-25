import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { withServer } from "../helpers/http-test-server.js";
import { createScriptTestHarness } from "../scripts/test-helpers.js";

const scriptPath = path.join(process.cwd(), ".github", "scripts", "secret-scanning-response.mjs");
const { createTempDir } = createScriptTestHarness();
const execFileAsync = promisify(execFile);

async function runScript(env: Record<string, string>, cwd: string): Promise<string> {
  const result = await execFileAsync(process.execPath, [scriptPath], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      ...env,
    },
    timeout: 10_000,
  });
  return result.stdout;
}

describe("secret-scanning response workflow script", () => {
  it("posts one generic notification and pings the content author", async () => {
    const tempDir = createTempDir("openclaw-secret-scan-response-");
    const eventPath = path.join(tempDir, "event.json");
    fs.writeFileSync(eventPath, JSON.stringify({ alert: { number: 7 } }), "utf8");

    const requests = [] as Array<{ method: string; pathname: string; body: string }>;

    await withServer(
      async (req, res) => {
        const url = new URL(req.url || "/", "http://127.0.0.1");
        const chunks = [] as Buffer[];
        for await (const chunk of req) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        const body = Buffer.concat(chunks).toString("utf8");
        requests.push({ method: req.method || "GET", pathname: url.pathname, body });

        res.setHeader("content-type", "application/json");

        if (
          req.method === "GET" &&
          url.pathname === "/repos/openclaw/openclaw/secret-scanning/alerts/7"
        ) {
          res.end(JSON.stringify({ number: 7, state: "open" }));
          return;
        }

        if (
          req.method === "GET" &&
          url.pathname === "/repos/openclaw/openclaw/secret-scanning/alerts/7/locations"
        ) {
          res.end(
            JSON.stringify([
              {
                type: "issue_comment",
                details: {
                  issue_comment_url: "/repos/openclaw/openclaw/issues/comments/2001",
                },
              },
              {
                type: "issue_comment",
                details: {
                  issue_comment_url: "/repos/openclaw/openclaw/issues/comments/2001",
                },
              },
            ]),
          );
          return;
        }

        if (
          req.method === "GET" &&
          url.pathname === "/repos/openclaw/openclaw/issues/comments/2001"
        ) {
          res.end(
            JSON.stringify({
              html_url: "https://github.com/openclaw/openclaw/issues/55#issuecomment-2001",
              user: { login: "reporter" },
            }),
          );
          return;
        }

        if (
          req.method === "GET" &&
          url.pathname === "/repos/openclaw/openclaw/issues/55/comments"
        ) {
          res.end(JSON.stringify([]));
          return;
        }

        if (
          req.method === "POST" &&
          url.pathname === "/repos/openclaw/openclaw/issues/55/comments"
        ) {
          res.end(JSON.stringify({ id: 3001 }));
          return;
        }

        res.statusCode = 404;
        res.end(JSON.stringify({ message: `Unhandled ${req.method} ${url.pathname}` }));
      },
      async (baseUrl) => {
        await runScript(
          {
            GITHUB_TOKEN: "test-token",
            GITHUB_EVENT_PATH: eventPath,
            GITHUB_REPOSITORY: "openclaw/openclaw",
            SECRET_SCANNING_API_BASE_URL: baseUrl,
          },
          tempDir,
        );
      },
    );

    const postRequests = requests.filter(
      (request) =>
        request.method === "POST" &&
        request.pathname === "/repos/openclaw/openclaw/issues/55/comments",
    );
    expect(postRequests).toHaveLength(1);

    const payload = JSON.parse(postRequests[0].body) as { body: string };
    expect(payload.body).toContain("<!-- barnacle-secret-scan:7 -->");
    expect(payload.body).toContain("@reporter");
    expect(payload.body).toContain("passwords, tokens, API keys");
  });

  it("skips posting when the alert marker is already present", async () => {
    const tempDir = createTempDir("openclaw-secret-scan-response-");
    const eventPath = path.join(tempDir, "event.json");
    fs.writeFileSync(eventPath, JSON.stringify({ alert: { number: 8 } }), "utf8");

    const requests = [] as Array<{ method: string; pathname: string; body: string }>;

    await withServer(
      async (req, res) => {
        const url = new URL(req.url || "/", "http://127.0.0.1");
        const chunks = [] as Buffer[];
        for await (const chunk of req) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        const body = Buffer.concat(chunks).toString("utf8");
        requests.push({ method: req.method || "GET", pathname: url.pathname, body });

        res.setHeader("content-type", "application/json");

        if (
          req.method === "GET" &&
          url.pathname === "/repos/openclaw/openclaw/secret-scanning/alerts/8"
        ) {
          res.end(JSON.stringify({ number: 8, state: "open" }));
          return;
        }

        if (
          req.method === "GET" &&
          url.pathname === "/repos/openclaw/openclaw/secret-scanning/alerts/8/locations"
        ) {
          res.end(
            JSON.stringify([
              {
                type: "pull_request_body",
                details: {
                  pull_request_url: "/repos/openclaw/openclaw/pulls/91",
                },
              },
            ]),
          );
          return;
        }

        if (req.method === "GET" && url.pathname === "/repos/openclaw/openclaw/pulls/91") {
          res.end(JSON.stringify({ number: 91, user: { login: "author" } }));
          return;
        }

        if (
          req.method === "GET" &&
          url.pathname === "/repos/openclaw/openclaw/issues/91/comments"
        ) {
          res.end(JSON.stringify([{ body: "<!-- barnacle-secret-scan:8 --> existing notice" }]));
          return;
        }

        res.statusCode = 404;
        res.end(JSON.stringify({ message: `Unhandled ${req.method} ${url.pathname}` }));
      },
      async (baseUrl) => {
        await runScript(
          {
            GITHUB_TOKEN: "test-token",
            GITHUB_EVENT_PATH: eventPath,
            GITHUB_REPOSITORY: "openclaw/openclaw",
            SECRET_SCANNING_API_BASE_URL: baseUrl,
          },
          tempDir,
        );
      },
    );

    const postRequests = requests.filter((request) => request.method === "POST");
    expect(postRequests).toHaveLength(0);
  });
});
