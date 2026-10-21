// Canonical durable approval presentation safety tests.
import { describe, expect, it } from "vitest";
import { prepareExecApprovalPresentation as prepare } from "./approval-presentation.js";
import type { ExecApprovalRequestPayload } from "./exec-approvals-core.js";
import type { PluginApprovalRequestPayload } from "./plugin-approvals.js";

const allowedDecisions = ["allow-once", "deny"] as const;
const invalidPresentation = "approval cannot be persisted without a valid reviewer presentation";
const rocket = String.fromCodePoint(0x1f680);
const shield = String.fromCodePoint(0x1f6e1);

function exec(request: {
  command: string;
  host?: string | null;
  nodeId?: string | null;
  agentId?: string | null;
  streamProposal?: ExecApprovalRequestPayload["streamProposal"];
}) {
  return prepare("exec", request, allowedDecisions);
}

function plugin(
  request: Partial<PluginApprovalRequestPayload>,
  decisions: Parameters<typeof prepare>[2] = allowedDecisions,
) {
  return prepare(
    "plugin",
    {
      title: "World verification",
      description: "Verify personhood before continuing.",
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
    const presentation = prepare(params.kind, { ...params.request, scope }, allowedDecisions);

    expect(presentation).toMatchObject({
      kind: params.kind,
      scope: { ...scope, target: "Stripe\\u{202E}" },
    });

    const oversizedScopePresentation = prepare(
      params.kind,
      { ...params.request, scope: { ...scope, target: `${"x".repeat(125)}\u202E` } },
      allowedDecisions,
    );

    expect(oversizedScopePresentation).toMatchObject({ kind: params.kind });
    expect(oversizedScopePresentation).not.toHaveProperty("scope");
  });

  it("sanitizes exec routing metadata and preserves empty values as null", () => {
    const githubToken = `ghp_${"a".repeat(100)}`;
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

  it("escapes control and bidi spoofing while preserving description line breaks", () => {
    const presentation = plugin({
      title: "Deploy\u202Eprod\nnow",
      description: "Line one\r\nLine two\u0000\u202E",
      detail: "Input one\r\nInput two\u0000\u202E",
      pluginId: "plugin\u202Eid",
      toolName: "tool\nname",
      agentId: "agent\u0000id",
    });

    expect(presentation).toMatchObject({
      kind: "plugin",
      title: "Deploy\\u{202E}prod\\u{A}now",
      description: "Line one\nLine two\\u{0}\\u{202E}",
      detail: "Input one\nInput two\\u{0}\\u{202E}",
      pluginId: "plugin\\u{202E}id",
      toolName: "tool\\u{A}name",
      agentId: "agent\\u{0}id",
    });
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

    expect(presentation).toMatchObject({
      kind: "plugin",
      detail: expect.stringMatching(/…\[truncated\]$/u),
    });
    if (presentation?.kind !== "plugin" || !presentation.detail) {
      throw new Error("expected plugin detail");
    }
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
    const buildWithLabel = (value: string) =>
      plugin({ externalResolution: { label: value, decisions: ["allow-once"] } }, ["deny"]);

    expect(buildWithLabel(label)).toMatchObject({
      kind: "plugin",
      externalResolution: { label },
    });
    expect(() => buildWithLabel(`${label}${rocket}`)).toThrow(invalidPresentation);
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

  it("drops split emoji at the title and description boundaries without lone surrogates", () => {
    const title = `${"a".repeat(79)}\u{1F600}`;
    const description = `${"a".repeat(511)}\u{1F6E1}`;
    const presentation = prepare(
      "system-agent",
      {
        title,
        description,
        proposalHash: "a".repeat(64),
      },
      allowedDecisions,
    );
    expect(presentation).toMatchObject({
      kind: "system-agent",
      title: "a".repeat(79),
      description: "a".repeat(511),
    });
  });

  it("keeps an emoji that fits within the title limit intact", () => {
    const title = `${"a".repeat(78)}\u{1F600}`;
    const presentation = prepare(
      "system-agent",
      { title, description: "d", proposalHash: "a".repeat(64) },
      allowedDecisions,
    );
    expect(presentation).toMatchObject({ kind: "system-agent", title });
  });
});
