// Check Boundary Safety tests cover high-confidence boundary guard behavior.
import { describe, expect, it } from "vitest";
import {
  diffBoundaryInventory,
  findBoundarySafetyViolations,
  isBoundarySafetyCandidateFile,
  main,
} from "../../scripts/check-boundary-safety.mjs";

describe("check-boundary-safety", () => {
  it("flags user-visible head truncation with raw slice", () => {
    const source = `
      const previewText = messageText.length > maxChars ? messageText.slice(0, maxChars - 1) + "…" : messageText;
    `;

    expect(findBoundarySafetyViolations(source, "src/channels/example.ts")).toEqual([
      {
        line: 2,
        ruleId: "boundary/text-utf16-truncation",
        match: "messageText.slice(0, maxChars - 1)",
        guidance:
          "Use truncateUtf16Safe(...) for head truncation or sliceUtf16Safe(...) for non-head slicing.",
      },
    ]);
  });

  it("accepts UTF-16-safe truncation helpers", () => {
    const source = `
      import { truncateUtf16Safe } from "../utils.js";
      const previewText = messageText.length > maxChars ? truncateUtf16Safe(messageText, maxChars - 1) + "…" : messageText;
    `;

    expect(findBoundarySafetyViolations(source, "src/channels/example.ts")).toStrictEqual([]);
  });

  it("does not flag protocol, byte-offset, or collection slices", () => {
    const source = `
      const packet = frame.slice(offset, offset + length);
      const hashPrefix = digest.slice(0, 8);
      const pathSegments = packageName.split("/").slice(0, 2);
      const latestMessages = messages.slice(0, -1);
      const firstLabels = labels.slice(0, 13);
      const scoredSnippets = snippets.filter(Boolean).map(scoreSnippet).slice(0, 12);
    `;

    expect(findBoundarySafetyViolations(source, "src/protocol/frame.ts")).toStrictEqual([]);
  });

  it("flags string-producing truncation chains", () => {
    const source = `
      const promptPreview = texts.map((text) => text.trim()).join("\\n").slice(0, maxChars);
    `;

    expect(findBoundarySafetyViolations(source, "src/channels/example.ts")).toEqual([
      {
        line: 2,
        ruleId: "boundary/text-utf16-truncation",
        match: 'texts.map((text) => text.trim()).join("\\n").slice(0, maxChars)',
        guidance:
          "Use truncateUtf16Safe(...) for head truncation or sliceUtf16Safe(...) for non-head slicing.",
      },
    ]);
  });

  it("flags awaited external response json reads", () => {
    const source = `
      export async function readProvider(response: Response) {
        return (await response.json()) as { ok: boolean };
      }
    `;

    expect(findBoundarySafetyViolations(source, "extensions/provider/runtime.ts")).toEqual([
      {
        line: 3,
        ruleId: "boundary/response-body-limit",
        match: "response.json()",
        guidance:
          "Use readResponseWithLimit(...), readProviderJsonResponse(...), readResponseTextSnippet(...), or openclaw/plugin-sdk/response-limit-runtime from plugin code.",
      },
    ]);
  });

  it("flags awaited response reads with catch chains", () => {
    const source = `
      export async function readProvider(res: Response) {
        const body = await res.text().catch(() => "");
        return body;
      }
    `;

    expect(findBoundarySafetyViolations(source, "src/agents/provider-client.ts")).toEqual([
      {
        line: 3,
        ruleId: "boundary/response-body-limit",
        match: "res.text()",
        guidance:
          "Use readResponseWithLimit(...), readProviderJsonResponse(...), readResponseTextSnippet(...), or openclaw/plugin-sdk/response-limit-runtime from plugin code.",
      },
    ]);
  });

  it("does not flag Express response writers", () => {
    const source = `
      app.get("/health", (_req, res) => {
        return res.json({ ok: true });
      });
    `;

    expect(
      findBoundarySafetyViolations(source, "extensions/browser/src/browser/routes/health.ts"),
    ).toStrictEqual([]);
  });

  it("keeps tests, fixtures, generated files, and scripts out of production candidates", () => {
    expect(isBoundarySafetyCandidateFile("src/agents/provider-client.ts")).toBe(true);
    expect(isBoundarySafetyCandidateFile("src/agents/provider-client.test.ts")).toBe(false);
    expect(isBoundarySafetyCandidateFile("src/agents/provider-client.test-helpers.ts")).toBe(false);
    expect(isBoundarySafetyCandidateFile("test/fixtures/provider-client.ts")).toBe(false);
    expect(
      isBoundarySafetyCandidateFile("src/auto-reply/reply/export-html/vendor/marked.min.js"),
    ).toBe(false);
    expect(isBoundarySafetyCandidateFile("scripts/check-boundary-safety.mjs")).toBe(false);
  });

  it("diffs baseline entries by stable file, rule, and match identity", () => {
    const baseline = [
      {
        file: "src/agents/provider-client.ts",
        line: 3,
        ruleId: "boundary/response-body-limit",
        match: "res.json()",
        guidance: "Use readResponseWithLimit(...)",
      },
    ];
    const actual = [
      baseline[0],
      {
        file: "src/channels/example.ts",
        line: 7,
        ruleId: "boundary/text-utf16-truncation",
        match: "messageText.slice(0, maxChars)",
        guidance: "Use truncateUtf16Safe(...)",
      },
    ];

    expect(diffBoundaryInventory(baseline, actual)).toEqual({
      missing: [],
      unexpected: [actual[1]],
    });
  });

  it("keeps baseline-known findings stable when only line numbers move", () => {
    const baseline = [
      {
        file: "src/agents/provider-client.ts",
        line: 3,
        ruleId: "boundary/response-body-limit",
        match: "res.json()",
        guidance: "Use readResponseWithLimit(...)",
      },
    ];
    const actual = [
      {
        ...baseline[0],
        line: 9,
      },
    ];

    expect(diffBoundaryInventory(baseline, actual)).toEqual({
      missing: [],
      unexpected: [],
    });
  });

  it("keeps JSON mode stdout parseable", async () => {
    const output = { stdout: "", stderr: "" };
    const io = {
      stdout: {
        write(chunk: string) {
          output.stdout += chunk;
        },
      },
      stderr: {
        write(chunk: string) {
          output.stderr += chunk;
        },
      },
    };

    await expect(main(["--json"], io)).resolves.toBe(0);
    expect(JSON.parse(output.stdout)).toEqual(expect.any(Array));
    expect(output.stdout).not.toContain("Boundary safety changed-file check passed");
    expect(output.stderr).toContain("Boundary safety changed-file check passed");
  });
});
