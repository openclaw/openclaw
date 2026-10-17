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

function evaluate(body: string, overrides: Record<string, unknown> = {}) {
  return evaluatePullRequestContext({
    pullRequest: {
      body,
      author_association: "CONTRIBUTOR",
      user: { login: "external-contributor", type: "User" },
      labels: [],
      ...overrides,
    },
  });
}

function proofBody(evidence: string) {
  return `## What Problem This Solves\n\nThe gateway dropped the configured Discord channel during startup.\n\n## Evidence\n\n${evidence}`;
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
  return { ok: true, status: 200, headers: new Headers(), body: { getReader: () => reader } };
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
    body: { getReader: () => ({ read, cancel, releaseLock: vi.fn() }) },
  };
}

describe("real-behavior-proof-policy", () => {
  it("passes CRLF-formatted external PRs with screenshot proof", () => {
    const evaluation = evaluate(
      proofBody("![after](https://github.com/user-attachments/assets/gateway-ready)").replace(
        /\n/g,
        "\r\n",
      ),
    );
    expect(evaluation.status).toBe("passed");
    expect(labelsForPullRequestContext(evaluation)).toEqual([]);
  });

  it("requires authored problem content instead of template comments", () => {
    const evaluation = evaluatePullRequestContext({
      pullRequest: externalPr(
        proofBody("![after](https://github.com/user-attachments/assets/gateway-ready)").replace(
          "The gateway dropped the configured Discord channel during startup.",
          "<!-- Describe the concrete user, product, or operational problem. -->",
        ),
      ),
    });

    expect(evaluation.status).toBe("missing");
    expect(evaluation.missingSections).toEqual(["What Problem This Solves"]);
  });

  it("does not accept the untouched current template", () => {
    expect(evaluate(blankTemplateBody)).toMatchObject({
      status: "missing",
      missingSections: ["What Problem This Solves", "Evidence"],
    });
  });

  it("does not accept sections hidden by an unclosed HTML comment", () => {
    const evaluation = evaluatePullRequestContext({
      pullRequest: externalPr(`<!--\n${proofBody("pnpm test passed.")}`),
    });

    expect(evaluation.status).toBe("missing");
    expect(evaluation.missingSections).toEqual(["What Problem This Solves", "Evidence"]);
  });

  it("accepts literal HTML comments inside fenced evidence", () => {
    const evaluation = evaluatePullRequestContext({
      pullRequest: externalPr(
        proofBody(["```html", "<!-- captured fragment", "<p>ready</p>", "```"].join("\n")),
      ),
    });

    expect(evaluation.status).toBe("passed");
  });

  it("accepts nested Markdown headings inside Evidence", () => {
    expect(evaluate(proofBody("### Focused tests\n\n`pnpm test` passed.")).status).toBe("passed");
  });

  it("rejects Markdown separators as context and evidence", () => {
    const evaluation = evaluatePullRequestContext({
      pullRequest: externalPr(proofBody("---", { problem: "***" })),
    });

    expect(evaluation.status).toBe("missing");
    expect(evaluation.missingSections).toEqual(["What Problem This Solves", "Evidence"]);
  });

  it("does not accept legacy fields hidden by HTML comments", () => {
    const evaluation = evaluate(
      [
        "## Real behavior proof",
        "",
        "<!--",
        "Behavior addressed: The gateway dropped the configured Discord channel during startup.",
        "Evidence after fix: pnpm test passed.",
        "-->",
      ].join("\n"),
    );
    expect(evaluation.status).toBe("missing");
    expect(evaluation.missingSections).toEqual(["What Problem This Solves", "Evidence"]);
  });

  it("accepts legacy behavior fields while open PRs still use the old template", () => {
    const evaluation = evaluate(
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
    );
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
    const evaluation = evaluate(body);
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

    const laterValid = evaluate(
      [testEvidence, "## Summary", "- Keep the detailed proof below.", validProof].join("\n\n"),
    );
    const laterInvalid = evaluate(
      [validProof, "## Evidence", "<!-- Add the most useful validation evidence. -->"].join("\n\n"),
    );

    expect(laterValid.status).toBe("passed");
    expect(labelsForPullRequestContext(laterValid)).toEqual([]);
    expect(laterInvalid.status).toBe("missing");
    expect(laterInvalid.missingSections).toEqual(["Evidence"]);
  });

  it("accepts source PR proof when explicit gaps live in out-of-scope follow-ups", () => {
    const body = [
      "## What Problem This Solves",
      "",
      "Cron validation downgraded Google Gemini 3 low thinking to off.",
      "",
      "## Evidence",
      "",
      "- Real environment tested: Local macOS source checkout, Node v24.8.0, OpenClaw 2026.5.21 (c8a35c4), local `openclaw` shim pointed at the freshly built checkout. No channel credentials or provider API keys were used.",
      "- Exact steps or command run after this patch:",
      "  1. Built the local checkout with `node --import tsx scripts/build-all.mts`.",
      "  2. Updated `/Users/example/.local/bin/openclaw` to run this checkout's `openclaw.mjs` and verified `/Users/example/.local/bin/openclaw --version`.",
      "  3. Ran a redacted behavior probe for the reported cron validation decision with `provider=google`, `model=gemini-3-flash-preview`, `configuredThinkingDefault=low`, and `catalogReasoning=false`.",
      '- Evidence after fix: `.artifacts/behavior-85156/after-installed.json` from the local checkout recorded `lowSupported: true` and `fallbackFromLow: "low"`.',
      "- Observed result after fix:",
      "  - `levels: off, minimal, low, medium, adaptive, high`",
      "  - `lowSupported: true`",
      "  - `fallbackFromLow: low`",
      "  - `local command version: OpenClaw 2026.5.21 (c8a35c4)`",
      "",
      "## Out-of-scope Follow-ups",
      "- No live systemd cron schedule is added in this PR.",
      "- No real Google provider request is sent in this PR.",
      "- No catalog refresh or provider model-list behavior is changed in this PR.",
      "- No channel, gateway allowlist, credential, or auth-profile behavior is changed in this PR.",
    ].join("\n");
    const evaluation = evaluatePullRequestContext({
      pullRequest: externalPr(body),
    });

    expect(evaluation.status).toBe("passed");
    expect(labelsForPullRequestContext(evaluation)).toEqual([]);
  });

  it("fails external PRs that say the changed behavior was not tested", () => {
    const evaluation = evaluate(proofBody("not tested"));
    expect(evaluation.status).toBe("missing");
    expect(labelsForPullRequestContext(evaluation)).toEqual([NEEDS_PR_CONTEXT_LABEL]);
  });

  it("skips maintainer and bot PRs but requires context from external PRs", () => {
    expect(evaluate("", { author_association: "MEMBER" }).status).toBe("skipped");
    expect(evaluate("", { user: { login: "renovate[bot]", type: "Bot" } }).status).toBe("skipped");
    expect(evaluate("", { labels: [{ name: PROOF_OVERRIDE_LABEL }] }).status).toBe("missing");
  });
});

describe("isMaintainerTeamMember", () => {
  function membership(fetch: typeof globalThis.fetch, timeoutMs?: number) {
    return isMaintainerTeamMember({ token: "t", org: "o", login: "u", fetch, timeoutMs });
  }

  function cancellableResponse(status: number) {
    const cancel = vi.fn();
    return {
      response: new Response(new ReadableStream<Uint8Array>({ cancel }), { status }),
      cancel,
    };
  }

  it("returns true for active members", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ state: "active" }));
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
    const fetch = vi.fn().mockResolvedValue(Response.json({ state: "pending" }));
    expect(await membership(fetch)).toBe(false);
  });

  it("cancels 404 membership response bodies", async () => {
    const { response, cancel } = cancellableResponse(404);
    expect(await membership(vi.fn().mockResolvedValue(response))).toBe(false);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("returns false when the token, org, or login is missing", async () => {
    const fetch = vi.fn();
    expect(await isMaintainerTeamMember({ org: "o", login: "u", fetch })).toBe(false);
    expect(await isMaintainerTeamMember({ token: "t", login: "u", fetch })).toBe(false);
    expect(await isMaintainerTeamMember({ token: "t", org: "o", fetch })).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("cancels unexpected HTTP error response bodies", async () => {
    const { response, cancel } = cancellableResponse(500);
    await expect(membership(vi.fn().mockResolvedValue(response))).rejects.toThrow(/500/);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("aborts stalled membership fetches", async () => {
    const fetch = vi.fn((_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(toLintErrorObject(init.signal?.reason, "Non-Error rejection")),
        );
      });
    });

    await expect(membership(fetch as typeof globalThis.fetch, 5)).rejects.toMatchObject({
      code: "ETIMEDOUT",
      message: "maintainer membership lookup for u timed out after 5ms",
    });
  });

  it("times out stalled membership response bodies", async () => {
    const fetch = vi.fn().mockResolvedValue(stalledResponse());

    await expect(membership(fetch, 5)).rejects.toThrow(
      /maintainer membership response for u timed out after 5ms/,
    );
  });
});

describe("readBoundedGitHubApiJson", () => {
  it("rejects oversized JSON bodies by content length", async () => {
    const cancel = vi.fn(() => Promise.resolve());
    const response = { headers: new Headers({ "content-length": "1025" }), body: { cancel } };

    await expect(
      readBoundedGitHubApiJson(response as unknown as Response, "GitHub API", 1024),
    ).rejects.toMatchObject({
      code: "ETOOBIG",
      message: "GitHub API response body exceeded 1024 bytes",
    });
    expect(cancel).toHaveBeenCalled();
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
