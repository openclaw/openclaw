import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { ExecToolDetails } from "../../agents/bash-tools.js";
import { buildExportTrajectoryCommandReply } from "./commands-export-trajectory.js";
import { commandFixture } from "./commands-handler-fixture.test-support.js";
import type {
  deliverPrivateCommandReply,
  resolvePrivateCommandRouteTargets,
  PrivateCommandRouteTarget,
} from "./commands-private-route.js";

const commandMocks = vi.hoisted(() => ({
  createExecTool: vi.fn(),
  resolvePrivateCommandRouteTargets: vi.fn<typeof resolvePrivateCommandRouteTargets>(),
  deliverPrivateCommandReply: vi.fn<typeof deliverPrivateCommandReply>(),
}));

vi.mock("../../agents/bash-tools.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/bash-tools.js")>()),
  createExecTool: commandMocks.createExecTool,
}));

vi.mock("./commands-private-route.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./commands-private-route.js")>()),
  resolvePrivateCommandRouteTargets: commandMocks.resolvePrivateCommandRouteTargets,
  deliverPrivateCommandReply: commandMocks.deliverPrivateCommandReply,
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

type ExecCall = { defaults: Record<string, unknown>; params: { command: string } };

function makeParams(workspaceDir = tempDirs.make("openclaw-export-command-")) {
  return commandFixture("/export-trajectory", {
    workspaceDir,
    cfg: { session: { store: "/tmp/openclaw-sessions.json" } },
    ctx: { SessionKey: "agent:main:slash-session", AccountId: "account-1" },
  });
}

function mockCommandBoundaries(
  options: {
    privateTargets?: Awaited<ReturnType<typeof resolvePrivateCommandRouteTargets>>;
    result?: { content?: Array<{ type: string; text?: string }>; details?: ExecToolDetails };
  } = {},
) {
  const execCalls: ExecCall[] = [];
  const privateReplies: { targets: PrivateCommandRouteTarget[]; text?: string }[] = [];
  commandMocks.createExecTool.mockImplementation((defaults: Record<string, unknown>) => ({
    execute: vi.fn(async (_toolCallId: string, params: ExecCall["params"]) => {
      execCalls.push({ defaults, params });
      return (
        options.result ?? {
          details: {
            status: "approval-pending" as const,
            approvalId: "approval-1",
            approvalSlug: "traj-approval",
            expiresAtMs: Date.now() + 60_000,
            allowedDecisions: ["allow-once", "deny"] as const,
            host: "gateway" as const,
            command: "openclaw sessions export-trajectory --session-key agent:target:session",
          },
        }
      );
    }),
  }));
  commandMocks.resolvePrivateCommandRouteTargets.mockResolvedValue(options.privateTargets ?? []);
  commandMocks.deliverPrivateCommandReply.mockImplementation(async ({ targets, reply }) => {
    privateReplies.push({ targets, text: reply.text });
    return "suppressed";
  });
  return { execCalls, privateReplies };
}

function readEncodedRequestFromCommand(command: string): Record<string, unknown> {
  const match = command.match(/'?--request-json-base64'?\s+'?([A-Za-z0-9_-]+)'?/u);
  const encoded = expectDefined(match?.[1], "encoded export request");
  return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Record<string, unknown>;
}

describe("buildExportTrajectoryCommandReply", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("requests per-run approval with shell-safe trajectory export values", async () => {
    const { execCalls } = mockCommandBoundaries();
    const params = makeParams();
    params.ctx.ApprovalReviewerDeviceId = "device-trajectory-reviewer";
    params.command.commandBodyNormalized = "/export-trajectory bad'; Invoke-Expression evil ;'";

    const reply = await buildExportTrajectoryCommandReply(params);

    expect(reply.text).toContain(
      "Trajectory exports can include prompts, model messages, tool schemas",
    );
    expect(reply.text).toContain("https://docs.openclaw.ai/tools/trajectory");
    expect(reply.text).toContain("do not use allow-all");
    expect(reply.text).toContain("Allowed decisions: allow-once, deny");
    expect(execCalls).toHaveLength(1);
    const execCall = expectDefined(execCalls[0], "exec call");
    expect(execCall.defaults).toMatchObject({
      host: "gateway",
      security: "allowlist",
      ask: "always",
      trigger: "export-trajectory",
      approvalFollowupMode: "agent",
      sessionId: "session-1",
      sessionStore: "/tmp/openclaw-sessions.json",
      currentChannelId: "bot",
      accountId: "account-1",
      approvalReviewerDeviceId: "device-trajectory-reviewer",
    });
    expect(execCall.params).toMatchObject({ ask: "always", background: true });
    const command = execCall.params.command;
    expect(command).not.toContain("--session-key");
    expect(command).not.toContain("openclaw sessions export-trajectory");
    expect(command).toMatch(/'?sessions'?\s+'?export-trajectory'?/u);
    expect(command).toMatch(/'?--request-json-base64'?\s+'?[A-Za-z0-9_-]+'?/u);
    expect(command).toMatch(/'?--json'?$/u);
    expect(command).not.toContain("Invoke-Expression");
    const request = readEncodedRequestFromCommand(command);
    expect(request).toMatchObject({
      sessionKey: "agent:target:session",
      workspace: params.workspaceDir,
      output: "bad'; Invoke-Expression evil ;'",
    });
  });

  it.each([
    {
      result: { details: { status: "running" as const, sessionId: "export-1", startedAt: 1 } },
      text: "Trajectory export is running (exec session export-1).",
    },
    {
      result: {
        details: { status: "failed" as const, exitCode: 1, durationMs: 1, aggregated: "  " },
      },
      text: "(no exec output)",
    },
    {
      result: {
        content: [
          { type: "text", text: "  first " },
          { type: "image" },
          { type: "text", text: "second  " },
        ],
        details: { status: "running" as const, sessionId: "export-1", startedAt: 1 },
      },
      text: "first \nsecond",
    },
    { result: {}, text: "(no exec details returned)" },
  ])("reports $text to the owner", async ({ result, text }) => {
    mockCommandBoundaries({ result });
    const reply = await buildExportTrajectoryCommandReply(makeParams());
    expect(reply.text?.endsWith(text)).toBe(true);
  });

  it.each(["path", "spaced path", "encoded request"])(
    "rejects oversized %s before exec approval",
    async (kind) => {
      const { execCalls } = mockCommandBoundaries();
      const params = makeParams();
      if (kind === "encoded request") {
        params.workspaceDir = `/${"workspace".repeat(1200)}`;
      } else {
        const outputPath = kind === "path" ? "a".repeat(513) : `reports/${"a ".repeat(253)}a`;
        params.command.commandBodyNormalized = `/export-trajectory ${outputPath}`;
      }
      const reply = await buildExportTrajectoryCommandReply(params);
      expect(reply.text).toContain(
        kind === "encoded request"
          ? "Encoded trajectory export request is too large"
          : "Output path is too long",
      );
      expect(execCalls).toHaveLength(0);
    },
  );

  it.each([true, false])("keeps group exports private (owner route=%s)", async (hasRoute) => {
    const { execCalls, privateReplies } = mockCommandBoundaries({
      privateTargets: hasRoute
        ? [
            { channel: "telegram", to: "owner-dm", accountId: "account-1" },
            { channel: "whatsapp", to: "backup-owner-dm", accountId: "account-2" },
          ]
        : [],
    });
    const params = makeParams();
    params.isGroup = true;
    params.command.to = "group-1";
    params.ctx.OriginatingTo = "origin-group";
    params.ctx.MessageThreadId = 42;

    const reply = await buildExportTrajectoryCommandReply(params);
    if (!hasRoute) {
      expect(reply.text).toContain("Run /export-trajectory from an owner DM");
      expect(execCalls).toHaveLength(0);
      expect(privateReplies).toHaveLength(0);
      return;
    }
    expect(reply.text).toContain("Private delivery of the export request was suppressed");
    expect(reply.text).not.toContain(params.workspaceDir);
    expect(reply.text).not.toContain("traj-approval");
    expect(reply.text).not.toContain("--request-json-base64");
    expect(reply.text).not.toContain("agent:target:session");
    expect(privateReplies).toHaveLength(1);
    expect(privateReplies[0]?.targets).toEqual([
      { channel: "telegram", to: "owner-dm", accountId: "account-1" },
    ]);
    expect(privateReplies[0]?.text).toContain("Trajectory exports can include prompts");
    expect(privateReplies[0]?.text).toContain("openclaw sessions export-trajectory");
    expect(privateReplies[0]?.text).toContain("Session: agent:target:session");
    expect(execCalls).toHaveLength(1);
    const execCall = expectDefined(execCalls[0], "exec call");
    expect(execCall.defaults).toMatchObject({
      messageProvider: "telegram",
      currentChannelId: "owner-dm",
      accountId: "account-1",
    });
  });
});
