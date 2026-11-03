// Canonical durable approval presentation safety tests.
import { describe, expect, it } from "vitest";
import { prepareExecApprovalPresentation as prepare } from "./approval-presentation.js";
import type { PluginApprovalRequestPayload } from "./plugin-approvals.js";

const allowedDecisions = ["allow-once", "deny"] as const;
const invalidPresentation = "approval cannot be persisted without a valid reviewer presentation";
const rocket = String.fromCodePoint(0x1f680);
const shield = String.fromCodePoint(0x1f6e1);

function plugin(
  request: Partial<PluginApprovalRequestPayload>,
  decisions: Parameters<typeof prepare>[2] = allowedDecisions,
) {
  return prepare(
    "plugin",
    {
      title: "Verify",
      description: "Operator consent required.",
      ...request,
    },
    decisions,
  );
}

function external(
  externalResolution: PluginApprovalRequestPayload["externalResolution"],
  decisions: Parameters<typeof prepare>[2] = ["deny"],
) {
  return plugin({ pluginId: "agentkit", externalResolution }, decisions);
}

describe("prepareExecApprovalPresentation", () => {
  it.each([
    { kind: "exec", request: { command: "printf safe" } },
    {
      kind: "plugin",
      request: { title: "Review payment", description: "The plugin needs operator consent." },
    },
  ] as const)("sanitizes $kind scope and drops scope that exceeds its wire bound", (params) => {
    const scope = {
      kind: "payment",
      amount: "49.99",
      currency: "EUR",
      target: "Stripe\u202E",
    } as const;
    const withTarget = (target: string) =>
      prepare(params.kind, { ...params.request, scope: { ...scope, target } }, allowedDecisions);
    expect(withTarget(scope.target)).toMatchObject({
      scope: { ...scope, target: "Stripe\\u{202E}" },
    });
    const emojiScope = { ...scope, target: "🦞".repeat(128) };
    expect(withTarget(emojiScope.target)).toMatchObject({ scope: emojiScope });
    expect(withTarget(`${"x".repeat(125)}\u202E`)).not.toHaveProperty("scope");
  });

  it("sanitizes exec routing metadata and preserves empty values as null", () => {
    const githubToken = `ghp_${"a".repeat(100)}`;
    const exec = (request: unknown) => prepare("exec", request, allowedDecisions);
    const presentation = exec({
      command: "printf safe",
      host: "gate\nway\u202E",
      nodeId: "node\u0000id",
      agentId: githubToken,
      streamProposal: {
        jobId: "watcher-id",
        name: `Errors\u202E ${githubToken}`,
        operation: "add",
      },
    });

    expect(presentation).toMatchObject({
      kind: "exec",
      host: "gate\\u{A}way\\u{202E}",
      nodeId: "node\\u{0}id",
      agentId: githubToken,
      streamProposal: {
        jobId: "watcher-id",
        name: expect.stringContaining("Errors\\u{202E}"),
        operation: "add",
      },
    });
    expect(
      exec({ command: "printf safe", host: "   ", nodeId: null, agentId: "\t" }),
    ).toMatchObject({ kind: "exec", host: null, nodeId: null, agentId: null });
  });

  it.each([
    ["title", "Deploy\u202Eprod\nnow", "Deploy\\u{202E}prod\\u{A}now"],
    ["description", "Line one\r\nLine two\u0000\u202E", "Line one\nLine two\\u{0}\\u{202E}"],
    ["detail", "Input one\r\nInput two\u0000\u202E", "Input one\nInput two\\u{0}\\u{202E}"],
    ["pluginId", "plugin\u202Eid", "plugin\\u{202E}id"],
    ["toolName", "tool\nname", "tool\\u{A}name"],
    ["agentId", "agent\u0000id", "agent\\u{0}id"],
  ])("escapes spoofing in plugin %s with multiline text preserved", (field, input, output) => {
    expect(plugin({ [field]: input })).toMatchObject({ [field]: output });
  });

  it("applies plugin limits by Unicode code point after sanitization", () => {
    const title = rocket.repeat(80);
    const description = shield.repeat(512);

    expect(plugin({ title, description })).toMatchObject({ kind: "plugin", title, description });
    expect(() => plugin({ title: `${title}${rocket}`, description })).toThrow(invalidPresentation);
    expect(() => plugin({ title, description: `${description}${shield}` })).toThrow(
      invalidPresentation,
    );
  });

  it("truncates oversized plugin detail without invalidating the presentation", () => {
    const presentation = plugin({ detail: "x".repeat(16_385) });

    if (presentation?.kind !== "plugin" || !presentation.detail) {
      throw new Error("expected plugin detail");
    }
    expect(presentation.detail).toMatch(/…\[truncated\]$/u);
    expect(Array.from(presentation.detail)).toHaveLength(16_384);
  });

  it("projects only bounded reviewer-safe external verification metadata", () => {
    expect(
      external({
        label: "Verify with World\u202E",
        decisions: ["allow-once", "allow-always"],
      }),
    ).toMatchObject({
      kind: "plugin",
      pluginId: "agentkit",
      allowedDecisions: ["deny"],
      externalResolution: {
        label: "Verify with World\\u{202E}",
        decisions: ["allow-once", "allow-always"],
      },
    });
  });

  it("applies the external label limit by Unicode code point", () => {
    const label = rocket.repeat(80);
    expect(external({ label })).toMatchObject({ externalResolution: { label } });
    expect(() => external({ label: `${label}${rocket}` })).toThrow(invalidPresentation);
  });

  it.each([
    { label: " ", decisions: undefined },
    { label: "Verify", decisions: [] },
    { label: "Verify", decisions: ["allow-once", "allow-once"] as const },
    { label: "\u202E".repeat(11), decisions: ["allow-once"] as const },
  ])("rejects malformed external verification metadata", (externalResolution) => {
    expect(() => external(externalResolution, allowedDecisions)).toThrow(invalidPresentation);
  });

  it("defaults external verification to allow once", () => {
    expect(external({ label: " Verify\nwith World " }, allowedDecisions)).toMatchObject({
      externalResolution: {
        label: "Verify\\u{A}with World",
        decisions: ["allow-once"],
      },
    });
  });

  it.each([
    { prefix: 79, expectedSuffix: "" },
    { prefix: 78, expectedSuffix: "\u{1F600}" },
  ])(
    "preserves only whole emoji at system-agent UTF-16 boundaries ($prefix)",
    ({ prefix, expectedSuffix }) => {
      expect(
        prepare(
          "system-agent",
          {
            title: `${"a".repeat(prefix)}\u{1F600}`,
            description: `${"a".repeat(511)}\u{1F6E1}`,
            proposalHash: "a".repeat(64),
          },
          allowedDecisions,
        ),
      ).toMatchObject({
        kind: "system-agent",
        title: "a".repeat(prefix) + expectedSuffix,
        description: "a".repeat(511),
      });
    },
  );
});
