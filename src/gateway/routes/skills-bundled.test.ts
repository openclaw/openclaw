/**
 * Tests for GET /skills/bundled and GET /skills/bundled/:name
 *
 * Covers:
 *   (a) envelope shape from GET /skills/bundled
 *   (b) manifest entries match committed manifest.json
 *   (c) per-skill body from GET /skills/bundled/:name matches file on disk
 *   (d) auth is required (401 without bearer token)
 *   (e) unknown skill name returns 404
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// ── path helpers ──────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const SKILLS_DIR = path.join(REPO_ROOT, "skills");
const MANIFEST_PATH = path.join(SKILLS_DIR, "manifest.json");

// ── auth mock ─────────────────────────────────────────────────────────────────

const { authorizeGatewayBearerRequestOrReplyMock } = vi.hoisted(() => ({
  authorizeGatewayBearerRequestOrReplyMock: vi.fn<
    [{ req: IncomingMessage; res: ServerResponse; auth: unknown }],
    Promise<boolean>
  >(),
}));

vi.mock("../http-auth-helpers.js", () => ({
  authorizeGatewayBearerRequestOrReply: authorizeGatewayBearerRequestOrReplyMock,
}));

// Import after mocks are in place.
import { handleSkillsBundledRequest, resetManifestCache } from "./skills-bundled.js";

// ── helpers ───────────────────────────────────────────────────────────────────

type ResponseCapture = {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  res: ServerResponse;
};

function makeReq(method: string, url: string, opts?: { token?: string }): IncomingMessage {
  return {
    method,
    url,
    headers: opts?.token ? { authorization: `Bearer ${opts.token}` } : {},
    socket: { remoteAddress: "127.0.0.1" },
  } as IncomingMessage;
}

function makeRes(): ResponseCapture {
  const capture: ResponseCapture = {
    statusCode: 200,
    headers: {},
    body: "",
    res: null as unknown as ServerResponse,
  };
  const res = {
    get statusCode() {
      return capture.statusCode;
    },
    set statusCode(v: number) {
      capture.statusCode = v;
    },
    setHeader(name: string, value: string) {
      capture.headers[name.toLowerCase()] = value;
    },
    end(chunk?: string) {
      if (chunk != null) {
        capture.body += chunk;
      }
    },
  } as unknown as ServerResponse;
  capture.res = res;
  return capture;
}

function makeAuth() {
  return { password: "test-token" } as unknown as import("../auth.js").ResolvedGatewayAuth;
}

// ── tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  resetManifestCache();
  // Default: auth passes.
  authorizeGatewayBearerRequestOrReplyMock.mockResolvedValue(true);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("handleSkillsBundledRequest — path routing", () => {
  test("returns false for unrelated paths", async () => {
    const cap = makeRes();
    const handled = await handleSkillsBundledRequest(makeReq("GET", "/api/other"), cap.res, {
      auth: makeAuth(),
    });
    expect(handled).toBe(false);
  });

  test("returns false for /skills (not /skills/bundled)", async () => {
    const cap = makeRes();
    const handled = await handleSkillsBundledRequest(makeReq("GET", "/skills"), cap.res, {
      auth: makeAuth(),
    });
    expect(handled).toBe(false);
  });
});

describe("handleSkillsBundledRequest — auth", () => {
  test("(d) returns 401 when auth fails", async () => {
    authorizeGatewayBearerRequestOrReplyMock.mockImplementationOnce(
      async ({ res }: { res: ServerResponse; req: IncomingMessage; auth: unknown }) => {
        (res as unknown as { statusCode: number }).statusCode = 401;
        res.end(JSON.stringify({ error: { message: "Unauthorized" } }));
        return false;
      },
    );
    const cap = makeRes();
    const handled = await handleSkillsBundledRequest(makeReq("GET", "/skills/bundled"), cap.res, {
      auth: makeAuth(),
    });
    expect(handled).toBe(true);
    expect(cap.statusCode).toBe(401);
  });

  test("returns 405 for non-GET method (before auth check)", async () => {
    const cap = makeRes();
    const handled = await handleSkillsBundledRequest(makeReq("POST", "/skills/bundled"), cap.res, {
      auth: makeAuth(),
    });
    expect(handled).toBe(true);
    expect(cap.statusCode).toBe(405);
  });
});

describe("handleSkillsBundledRequest — GET /skills/bundled", () => {
  test("(a) returns envelope with required shape fields", async () => {
    vi.stubEnv("OPENCLAW_IMAGE_TAG", "v2026.05.24.1");
    vi.stubEnv("OPENCLAW_IMAGE_SHA", "sha256:abc123");
    vi.stubEnv("OPENCLAW_SOURCE_SHA", "deadbeef");

    const cap = makeRes();
    const handled = await handleSkillsBundledRequest(makeReq("GET", "/skills/bundled"), cap.res, {
      auth: makeAuth(),
    });

    expect(handled).toBe(true);
    expect(cap.statusCode).toBe(200);

    const envelope = JSON.parse(cap.body) as {
      imageTag: string;
      imageSha: string;
      sourceSha: string;
      generatedAt: string;
      skills: unknown[];
    };
    expect(envelope.imageTag).toBe("v2026.05.24.1");
    expect(envelope.imageSha).toBe("sha256:abc123");
    expect(envelope.sourceSha).toBe("deadbeef");
    expect(typeof envelope.generatedAt).toBe("string");
    expect(Array.isArray(envelope.skills)).toBe(true);
    expect(envelope.skills.length).toBeGreaterThan(0);
  });

  test("(b) manifest entries match committed manifest.json", async () => {
    const cap = makeRes();
    await handleSkillsBundledRequest(makeReq("GET", "/skills/bundled"), cap.res, {
      auth: makeAuth(),
    });

    const envelope = JSON.parse(cap.body) as { skills: unknown[] };

    if (!existsSync(MANIFEST_PATH)) {
      // Skip if manifest hasn't been generated yet (CI without pnpm skills:manifest).
      return;
    }
    const committed = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as unknown[];

    expect(envelope.skills).toEqual(committed);
  });

  test("(b) each manifest entry has required fields", async () => {
    const cap = makeRes();
    await handleSkillsBundledRequest(makeReq("GET", "/skills/bundled"), cap.res, {
      auth: makeAuth(),
    });

    const envelope = JSON.parse(cap.body) as {
      skills: Array<{
        name: string;
        description: string;
        emoji: string;
        requires: object;
        path: string;
        contentHash: string;
      }>;
    };

    for (const entry of envelope.skills) {
      expect(typeof entry.name).toBe("string");
      expect(entry.name.length).toBeGreaterThan(0);
      expect(typeof entry.description).toBe("string");
      expect(typeof entry.contentHash).toBe("string");
      expect(entry.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(typeof entry.path).toBe("string");
      expect(entry.path).toMatch(/^skills\//);
    }
  });

  test("(b) contentHash matches actual SKILL.md content on disk", async () => {
    if (!existsSync(MANIFEST_PATH)) {
      return;
    }
    const committed = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as Array<{
      name: string;
      contentHash: string;
      path: string;
    }>;

    for (const entry of committed) {
      const skillPath = path.join(REPO_ROOT, entry.path);
      if (!existsSync(skillPath)) {
        continue;
      }

      const raw = readFileSync(skillPath, "utf8");
      // Apply the same normalization as the generator.
      const normalized = normalizeContent(raw);
      const hash = "sha256:" + createHash("sha256").update(normalized, "utf8").digest("hex");
      expect(hash).toBe(entry.contentHash);
    }
  });
});

describe("handleSkillsBundledRequest — GET /skills/bundled/:name", () => {
  test("(c) returns SKILL.md body for known skill", async () => {
    if (!existsSync(MANIFEST_PATH)) {
      return;
    }
    const committed = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as Array<{ name: string }>;
    if (committed.length === 0) {
      return;
    }

    const skillName = committed[0].name;
    const cap = makeRes();
    const handled = await handleSkillsBundledRequest(
      makeReq("GET", `/skills/bundled/${skillName}`),
      cap.res,
      { auth: makeAuth() },
    );

    expect(handled).toBe(true);
    expect(cap.statusCode).toBe(200);
    expect(cap.headers["content-type"]).toMatch(/text\/markdown/);
    expect(cap.body.length).toBeGreaterThan(0);
  });

  test("(c) body matches file on disk for rain skill", async () => {
    const rainPath = path.join(SKILLS_DIR, "rain", "SKILL.md");
    if (!existsSync(rainPath) || !existsSync(MANIFEST_PATH)) {
      return;
    }
    const committed = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as Array<{ name: string }>;
    if (!committed.find((e) => e.name === "rain")) {
      return;
    }

    const cap = makeRes();
    await handleSkillsBundledRequest(makeReq("GET", "/skills/bundled/rain"), cap.res, {
      auth: makeAuth(),
    });

    expect(cap.statusCode).toBe(200);
    const diskContent = readFileSync(rainPath, "utf8");
    expect(cap.body).toBe(diskContent);
  });

  test("(e) returns 404 for unknown skill name", async () => {
    const cap = makeRes();
    const handled = await handleSkillsBundledRequest(
      makeReq("GET", "/skills/bundled/nonexistent-skill-xyz"),
      cap.res,
      { auth: makeAuth() },
    );

    expect(handled).toBe(true);
    expect(cap.statusCode).toBe(404);
    const body = JSON.parse(cap.body) as { error: { type: string } };
    expect(body.error.type).toBe("not_found");
  });

  test("(e) path-traversal via ../ is neutralized by URL normalization", async () => {
    // The URL constructor normalizes /skills/bundled/../../../etc → /etc,
    // so the handler never matches the /skills/bundled prefix and returns false.
    // This is the correct security outcome: the request falls through to the
    // 404 handler rather than being served by this handler at all.
    const cap = makeRes();
    const handled = await handleSkillsBundledRequest(
      makeReq("GET", "/skills/bundled/../../../etc"),
      cap.res,
      { auth: makeAuth() },
    );

    // Path normalizes away from /skills/bundled — handler does not claim it.
    expect(handled).toBe(false);
  });

  test("(e) returns 404 for extra path segments after the skill name", async () => {
    // /skills/bundled/:name takes exactly one path segment. Anything with
    // extra segments must 404 even when the leading segment names a real
    // canonical skill — otherwise a client bug (duplicated path, trailing
    // slash, etc.) would silently succeed against the wrong route.
    const cases = [
      "/skills/bundled/rain/", // trailing slash on real skill
      "/skills/bundled/rain/anything", // extra segment on real skill
      "/skills/bundled/rain/a/b/c", // deep extra segments on real skill
      "/skills/bundled/foo/bar", // extras with non-existent leading name
    ];

    for (const url of cases) {
      const cap = makeRes();
      const handled = await handleSkillsBundledRequest(makeReq("GET", url), cap.res, {
        auth: makeAuth(),
      });
      expect(handled).toBe(true);
      expect(cap.statusCode).toBe(404);
      const body = JSON.parse(cap.body) as { error: { type: string } };
      expect(body.error.type).toBe("not_found");
    }
  });
});

// ── normalization helper (mirrors the generator) ──────────────────────────────

function normalizeContent(raw: string): string {
  const lines = raw
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd());
  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines.join("\n") + "\n";
}
