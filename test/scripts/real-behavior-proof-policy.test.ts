// PR Context And Evidence Policy tests cover GitHub PR-body policy behavior.
import { readFileSync } from "node:fs";
import { toErrorObject as toLintErrorObject } from "@openclaw/normalization-core/error-coercion";
import { describe, expect, it, vi } from "vitest";
import {
  NEEDS_PR_CONTEXT_LABEL,
  PROOF_OVERRIDE_LABEL,
  evaluatePullRequestContext,
  isMaintainerTeamMember,
  labelsForPullRequestContext,
  readBoundedGitHubApiJson,
} from "../../scripts/github/real-behavior-proof-policy.mjs";

const blankTemplateBody = readFileSync(
  new URL("../../.github/pull_request_template.md", import.meta.url),
  "utf8",
);

function externalPr(body: string, overrides: Record<string, unknown> = {}) {
  return {
    body,
    author_association: "CONTRIBUTOR",
    user: {
      login: "external-contributor",
      type: "User",
    },
    labels: [],
    ...overrides,
  };
}

function proofBody(evidence: string, overrides: Record<string, string> = {}) {
  const fields = {
    problem: "The gateway dropped the configured Discord channel during startup.",
    evidence,
    ...overrides,
  };
  return [
    "## What Problem This Solves",
    "",
    fields.problem,
    "",
    "## Evidence",
    "",
    fields.evidence,
  ].join("\n");
}

function stalledResponse() {
  let keepAlive: ReturnType<typeof setTimeout> | undefined;
  const reader = {
    read: () =>
      new Promise<ReadableStreamReadResult<Uint8Array>>(() => {
        keepAlive = setTimeout(() => {}, 10_000);
      }),
    cancel: vi.fn(() => {
      if (keepAlive) {
        clearTimeout(keepAlive);
      }
      return Promise.resolve();
    }),
    releaseLock: vi.fn(),
  };
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    body: {
      getReader: () => reader,
    },
  };
}

function contentLengthResponse(contentLength: number) {
  const cancel = vi.fn(() => Promise.resolve());
  return {
    headers: new Headers({ "content-length": String(contentLength) }),
    body: { cancel },
    cancel,
  };
}

function chunkedResponse(chunks: Uint8Array[]) {
  const cancel = vi.fn(() => Promise.resolve());
  const read = vi.fn();
  for (const chunk of chunks) {
    read.mockResolvedValueOnce({ done: false, value: chunk });
  }
  read.mockResolvedValueOnce({ done: true, value: undefined });
  return {
    headers: new Headers(),
    body: {
      getReader: () => ({
        read,
        cancel,
        releaseLock: vi.fn(),
      }),
    },
  };
}

describe("real-behavior-proof-policy", () => {
  it("passes CRLF-formatted external PRs with screenshot proof", () => {
    const evaluation = evaluatePullRequestContext({
      pullRequest: externalPr(
        proofBody("![after](https://github.com/user-attachments/assets/gateway-ready)").replace(
          /\n/g,
          "\r\n",
        ),
      ),
    });

    expect(evaluation.status).toBe("passed");
    expect(labelsForPullRequestContext(evaluation)).toEqual([]);
  });

  it("does not accept the untouched current template", () => {
    const evaluation = evaluatePullRequestContext({
      pullRequest: externalPr(blankTemplateBody),
    });

    expect(evaluation.status).toBe("missing");
    expect(evaluation.missingSections).toEqual(["What Problem This Solves", "Evidence"]);
  });

  it("accepts nested Markdown headings inside Evidence", () => {
    const evaluation = evaluatePullRequestContext({
      pullRequest: externalPr(
        proofBody(["### Focused tests", "", "`pnpm test` passed."].join("\n")),
      ),
    });

    expect(evaluation.status).toBe("passed");
  });

  it("does not accept legacy fields hidden by HTML comments", () => {
    const evaluation = evaluatePullRequestContext({
      pullRequest: externalPr(
        [
          "## Real behavior proof",
          "",
          "<!--",
          "Behavior addressed: The gateway dropped the configured Discord channel during startup.",
          "Evidence after fix: pnpm test passed.",
          "-->",
        ].join("\n"),
      ),
    });

    expect(evaluation.status).toBe("missing");
    expect(evaluation.missingSections).toEqual(["What Problem This Solves", "Evidence"]);
  });

  it("accepts legacy behavior fields while open PRs still use the old template", () => {
    const evaluation = evaluatePullRequestContext({
      pullRequest: externalPr(
        [
          "## Real behavior proof",
          "",
          "- Behavior addressed: The gateway dropped the configured Discord channel during startup.",
          "- Real environment tested: macOS 15.4, Node 24, local OpenClaw gateway.",
          "- Exact steps or command run after this patch: pnpm openclaw gateway restart",
          "- Evidence after fix: ![after](https://github.com/user-attachments/assets/gateway-ready)",
          "- Observed result after fix: The gateway stayed connected and Discord reported ready.",
          "- What was not tested: No known gaps.",
        ].join("\n"),
      ),
    });

    expect(evaluation.status).toBe("passed");
  });

  it("accepts Markdown headings copied inside fenced evidence", () => {
    const body = proofBody(
      [
        "Terminal transcript:",
        "```text",
        "compiled system prompt:",
        "```js",
        "console.log('not a closing fence')",
        "## Real behavior proof",
        "Behavior addressed: copied prompt content, not a PR proof section.",
        "## TOOLS.md",
        "Observed result: ```",
        "Observed result: not tested",
        "What was not tested: copied template text",
        "not tested",
        "openclaw gateway status",
        "discord ready",
        "```",
      ].join("\n"),
    );
    const evaluation = evaluatePullRequestContext({
      pullRequest: externalPr(body),
    });

    expect(evaluation.status).toBe("passed");
    expect(labelsForPullRequestContext(evaluation)).toEqual([]);
  });

  it("uses the latest Evidence section when duplicates exist", () => {
    const validProof = proofBody(
      [
        "Terminal transcript:",
        "```text",
        "$ openclaw doctor --non-interactive",
        "Discord external plugin is installed without explicit trust.",
        "Add plugins.entries.discord.enabled=true to trust it.",
        "```",
      ].join("\n"),
    );
    const testEvidence = proofBody("Focused tests passed: 2 files, 36 tests.");

    const laterValid = evaluatePullRequestContext({
      pullRequest: externalPr(
        [testEvidence, "## Summary", "- Keep the detailed proof below.", validProof].join("\n\n"),
      ),
    });
    const laterInvalid = evaluatePullRequestContext({
      pullRequest: externalPr(
        [validProof, "## Evidence", "<!-- Add the most useful validation evidence. -->"].join(
          "\n\n",
        ),
      ),
    });

    expect(laterValid.status).toBe("passed");
    expect(labelsForPullRequestContext(laterValid)).toEqual([]);
    expect(laterInvalid.status).toBe("missing");
    expect(laterInvalid.missingSections).toEqual(["Evidence"]);
  });

  it("fails external PRs that say the changed behavior was not tested", () => {
    const evaluation = evaluatePullRequestContext({
      pullRequest: externalPr(proofBody("not tested")),
    });

    expect(evaluation.status).toBe("missing");
    expect(labelsForPullRequestContext(evaluation)).toEqual([NEEDS_PR_CONTEXT_LABEL]);
  });

  it("skips maintainer and bot PRs but requires context from external PRs", () => {
    expect(
      evaluatePullRequestContext({
        pullRequest: externalPr("", { author_association: "MEMBER" }),
      }).status,
    ).toBe("skipped");
    expect(
      evaluatePullRequestContext({
        pullRequest: externalPr("", {
          user: {
            login: "renovate[bot]",
            type: "Bot",
          },
        }),
      }).status,
    ).toBe("skipped");
    expect(
      evaluatePullRequestContext({
        pullRequest: externalPr("", { labels: [{ name: PROOF_OVERRIDE_LABEL }] }),
      }).status,
    ).toBe("missing");
  });
});

describe("isMaintainerTeamMember", () => {
  function jsonResponse(status: number, body: unknown = {}) {
    return new Response(JSON.stringify(body), { status });
  }

  it("returns true for active members", async () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse(200, { state: "active" }));
    const result = await isMaintainerTeamMember({
      token: "tok",
      org: "openclaw",
      login: "private-maint",
      fetch,
    });

    expect(result).toBe(true);
    expect(fetch).toHaveBeenCalledWith(
      "https://api.github.com/orgs/openclaw/teams/maintainer/memberships/private-maint",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer tok",
          Accept: "application/vnd.github+json",
        }),
      }),
    );
  });

  it("returns false for non-active membership states", async () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse(200, { state: "pending" }));
    expect(await isMaintainerTeamMember({ token: "t", org: "o", login: "u", fetch })).toBe(false);
  });

  it("cancels 404 membership response bodies", async () => {
    let canceled = false;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          canceled = true;
        },
      }),
      { status: 404 },
    );
    const fetch = vi.fn().mockResolvedValue(response);

    expect(await isMaintainerTeamMember({ token: "t", org: "o", login: "u", fetch })).toBe(false);
    expect(canceled).toBe(true);
  });

  it("returns false when the token, org, or login is missing", async () => {
    const fetch = vi.fn();
    expect(await isMaintainerTeamMember({ org: "o", login: "u", fetch })).toBe(false);
    expect(await isMaintainerTeamMember({ token: "t", login: "u", fetch })).toBe(false);
    expect(await isMaintainerTeamMember({ token: "t", org: "o", fetch })).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("cancels unexpected HTTP error response bodies", async () => {
    let canceled = false;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          canceled = true;
        },
      }),
      { status: 500 },
    );
    const fetch = vi.fn().mockResolvedValue(response);

    await expect(
      isMaintainerTeamMember({ token: "t", org: "o", login: "u", fetch }),
    ).rejects.toThrow(/500/);
    expect(canceled).toBe(true);
  });

  it("aborts stalled membership fetches", async () => {
    const fetch = vi.fn((_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(toLintErrorObject(init.signal?.reason, "Non-Error rejection")),
        );
      });
    });

    await expect(
      isMaintainerTeamMember({
        fetch: fetch as typeof globalThis.fetch,
        login: "u",
        org: "o",
        timeoutMs: 5,
        token: "t",
      }),
    ).rejects.toMatchObject({
      code: "ETIMEDOUT",
      message: "maintainer membership lookup for u timed out after 5ms",
    });
  });

  it("times out stalled membership response bodies", async () => {
    const fetch = vi.fn().mockResolvedValue(stalledResponse());

    await expect(
      isMaintainerTeamMember({
        fetch: fetch as typeof globalThis.fetch,
        login: "u",
        org: "o",
        timeoutMs: 5,
        token: "t",
      }),
    ).rejects.toThrow(/maintainer membership response for u timed out after 5ms/);
  });
});

describe("readBoundedGitHubApiJson", () => {
  it("rejects oversized JSON bodies by content length", async () => {
    const response = contentLengthResponse(1025);

    await expect(
      readBoundedGitHubApiJson(response as unknown as Response, "GitHub API", 1024),
    ).rejects.toMatchObject({
      code: "ETOOBIG",
      message: "GitHub API response body exceeded 1024 bytes",
    });
    expect(response.cancel).toHaveBeenCalled();
  });

  it("rejects oversized streamed JSON bodies", async () => {
    const encoder = new TextEncoder();
    const response = chunkedResponse([
      encoder.encode('{"body":"'),
      encoder.encode("x".repeat(1024)),
      encoder.encode('"}'),
    ]);

    await expect(
      readBoundedGitHubApiJson(response as unknown as Response, "GitHub API", 1024),
    ).rejects.toMatchObject({
      code: "ETOOBIG",
      message: "GitHub API response body exceeded 1024 bytes",
    });
  });
});
