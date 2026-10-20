import { expectDefined } from "@openclaw/normalization-core/expect";
import { Value } from "typebox/value";
import { expect, it, vi } from "vitest";
import { runWithAgentToolExecutionContext } from "../../../packages/agent-core/src/tool-execution-context.js";
import { finalizeAgentToolAvailability } from "../agent-tool-availability.js";
import { applyGatewayToolPolicy } from "../gateway-tool-policy.js";
import { createSandboxTestContext } from "../sandbox/test-fixtures.js";
import type { SandboxContext } from "../sandbox/types.js";
import { makeAssistantMessageFixture } from "../test-helpers/assistant-message-fixtures.js";
import { createHostSandboxFsBridge } from "../test-helpers/host-sandbox-fs-bridge.js";
import { createCronToolSchema } from "./cron-tool-schema.js";
import { withGatewayToolCallerIdentity } from "./gateway-caller-context.js";
import { createGitHubPublishTool } from "./github-publish-tool.js";
import type { InProcessGatewayCaller } from "./in-process-gateway.js";

const caller = { agentId: "main", sessionKey: "agent:main:host-owned" };
const publication = {
  requestId: "publication-1",
  status: "requested" as const,
  message: "Publication was accepted.",
};
function setup(actionsAvailable = false) {
  const callGateway = vi.fn(
    async (_method: string, _params: Record<string, unknown>) => publication,
  );
  const tool = createGitHubPublishTool({
    callGateway: callGateway as InProcessGatewayCaller,
    actionsAvailable,
  });
  const execute = (args: unknown, id = "choice") =>
    withGatewayToolCallerIdentity(caller, () => tool.execute(id, args));
  return { callGateway, tool, execute };
}

it("applies deployment action limits when publication and operator actions are available", () => {
  const [tool] = applyGatewayToolPolicy([createGitHubPublishTool({ actionsAvailable: true })], {
    tools: {
      gatewayPolicy: {
        allow: ["github_publish"],
        actions: { github_publish: ["publish", "inspect"] },
      },
    },
  });
  expect(tool?.parameters).toMatchObject({
    properties: { action: { enum: ["publish", "inspect"] } },
  });
});

function publicationSandbox(overrides: Partial<SandboxContext> = {}) {
  return createSandboxTestContext({
    overrides: {
      workspaceSource: "managed-worktree",
      fsBridge: {
        ...createHostSandboxFsBridge("/tmp/github-publish"),
        readFileWithSource: async () => {
          throw new Error("Schema fixture does not read files");
        },
      },
      backend: {
        id: "docker",
        runtimeId: "fixture",
        runtimeLabel: "fixture",
        workdir: "/workspace",
        buildExecSpec: async () => {
          throw new Error("Schema fixture does not execute commands");
        },
        runShellCommand: async () => {
          throw new Error("Schema fixture does not execute commands");
        },
      },
      ...overrides,
    },
  });
}

it.each<{
  name: string;
  sandbox: Partial<SandboxContext> | null;
  refresh: boolean;
  evidence: boolean;
}>([
  { name: "direct session", sandbox: null, refresh: false, evidence: false },
  { name: "writable managed sandbox", sandbox: {}, refresh: true, evidence: true },
  {
    name: "read-only managed sandbox",
    sandbox: { workspaceAccess: "ro" },
    refresh: false,
    evidence: true,
  },
  {
    name: "unmanaged sandbox",
    sandbox: { workspaceSource: undefined },
    refresh: false,
    evidence: true,
  },
  { name: "missing backend", sandbox: { backend: undefined }, refresh: false, evidence: true },
  { name: "missing file bridge", sandbox: { fsBridge: undefined }, refresh: true, evidence: false },
  {
    name: "missing source-aware read",
    sandbox: { fsBridge: createHostSandboxFsBridge("/tmp/github-publish") },
    refresh: true,
    evidence: false,
  },
  { name: "disabled sandbox", sandbox: { enabled: false }, refresh: false, evidence: false },
])("offers only supported sandbox actions for $name", ({ sandbox, refresh, evidence }) => {
  for (const actionsAvailable of [false, true]) {
    const tool = createGitHubPublishTool({
      sandbox: sandbox === null ? null : publicationSandbox(sandbox),
      actionsAvailable,
    });
    for (const [action, offered, properties] of [
      ["refresh_base", refresh, ["conflictsResolved", "baseCommit"]],
      ["upload_evidence", evidence, ["evidence"]],
    ] as const) {
      expect(Value.Check(tool.parameters, { action }), action).toBe(offered);
      for (const property of properties) {
        if (offered) {
          expect(tool.parameters).toHaveProperty(`properties.${property}`);
        } else {
          expect(tool.parameters).not.toHaveProperty(`properties.${property}`);
        }
        expect(tool.description.includes(property), property).toBe(offered);
      }
      expect(tool.description.includes(action), action).toBe(offered);
    }
    if (!refresh) {
      expect(tool.description).not.toMatch(/refresh/i);
    }
    expect(Value.Check(tool.parameters, {})).toBe(true);
    for (const action of ["publish", "edit", "ready", "request_review"]) {
      expect(Value.Check(tool.parameters, { action }), action).toBe(true);
    }
    for (const action of ["inspect", "merge", "close"]) {
      expect(Value.Check(tool.parameters, { action }), action).toBe(actionsAvailable);
    }
    expect(
      Value.Check(tool.parameters, { action: "ready", publishingSessionKey: "agent:main:child" }),
    ).toBe(actionsAvailable);
    const description = tool.description;
    finalizeAgentToolAvailability([tool]);
    expect(tool.description).toBe(description);
  }
});

it.each(["edit", "refresh_base", "ready", "request_review", "upload_evidence"])(
  "rejects draft on %s without changing PR state",
  async (action) => {
    const { callGateway, execute } = setup(true);
    await expect(execute({ action, draft: false })).rejects.toThrow(
      "draft only selects the state when publishing a new PR",
    );
    expect(callGateway).not.toHaveBeenCalled();
  },
);

it("offers current-PR preparation without privileged actions", () => {
  const tool = createGitHubPublishTool({ sandbox: publicationSandbox() });
  const check = (args: unknown, valid = true) =>
    expect(Value.Check(tool.parameters, args)).toBe(valid);
  const request = {
    requestId: "a1111111-1111-4111-8111-111111111111",
    expectedHeadCommit: "a".repeat(40),
  };
  for (const action of ["edit", "ready"]) {
    check({ action });
  }
  check({ action: "request_review", ...request });
  check({ action: "request_review", focus: "extra instructions" }, false);
  check({
    action: "upload_evidence",
    ...request,
    evidence: { path: "proof.png", sha256: "b".repeat(64), sizeBytes: 68 },
  });
  check({ action: "edit", title: "New title", expectedTitle: "Old title" });
  for (const action of ["inspect", "merge", "close"]) {
    check({ action }, false);
  }
  for (const action of ["ready", "edit"]) {
    check({ action, publishingSessionKey: "another" }, false);
  }
  expect(tool.description).toContain("used only when creating a PR");
  expect(tool.description).toContain("Edit never synchronizes, stages, commits or pushes");
  const actionOnly = createGitHubPublishTool({
    publicationAvailable: false,
    actionsAvailable: true,
  });
  expect(Value.Check(actionOnly.parameters, { action: "edit" })).toBe(false);
});

it.each(["available", "absent", "self-scoped", "denied"] as const)(
  "offers a scheduled continuation only with %s automation creation",
  (availability) => {
    const publish = createGitHubPublishTool();
    const automations = {
      name: "automations",
      description: "Schedule work",
      parameters: createCronToolSchema({ selfRemoveOnly: availability === "self-scoped" }),
    };
    finalizeAgentToolAvailability(
      [publish, ...(availability === "absent" ? [] : [automations])],
      availability === "denied" ? { toolExecutionAllow: ["github_publish"] } : undefined,
    );
    if (availability === "available") {
      expect(publish.description).toContain(
        'automations: at + agentTurn + sessionTarget "session:<this session key from Runtime>"',
      );
    } else {
      expect(publish.description).not.toContain("automations:");
      expect(publish.description).toContain("a scheduled continuation is unavailable");
    }
  },
);

it.each(["responseId", "turnId"] as const)(
  "scopes reused call IDs by %s and keeps replays stable across runs",
  async (identityField) => {
    const { callGateway, tool } = setup();
    const calls = ["First publication", "Second publication"].map((title, index) => {
      const toolCall = {
        type: "toolCall" as const,
        id: "github_publish_0",
        name: tool.name,
        arguments: { title },
      };
      return {
        toolCall,
        assistantMessage: makeAssistantMessageFixture({
          [identityField]: `turn-${index + 1}`,
          stopReason: "toolUse",
          content: [toolCall],
        }),
      };
    });
    const first = expectDefined(calls[0], "first assistant turn");
    for (const [index, context] of [...calls, first, first].entries()) {
      await withGatewayToolCallerIdentity(
        {
          ...caller,
          operationalRunInstance: {
            instanceId: "instance-1",
            runId: index === 3 ? "run-2" : "run-1",
          },
        },
        () =>
          runWithAgentToolExecutionContext(context, () =>
            tool.execute(context.toolCall.id, context.toolCall.arguments),
          ),
      );
    }

    const firstRequest = {
      sessionKey: caller.sessionKey,
      idempotencyKey: "turn-1:github_publish_0",
      title: "First publication",
    };
    expect(callGateway.mock.calls.map(([, params]) => params)).toEqual([
      firstRequest,
      { ...firstRequest, idempotencyKey: "turn-2:github_publish_0", title: "Second publication" },
      firstRequest,
      firstRequest,
    ]);
  },
);

it.each([undefined, false, true])(
  "preserves the draft choice %s in bounded model intent",
  async (draft) => {
    const { callGateway, execute, tool } = setup();
    const args = { title: "Publish the fix", ...(draft !== undefined ? { draft } : {}) };
    const request = { action: "publish", ...args };
    expect(Value.Check(tool.parameters, request)).toBe(true);
    await execute(request, "tool-call-1");
    expect(callGateway).toHaveBeenCalledWith("sessions.github.publish", {
      sessionKey: caller.sessionKey,
      idempotencyKey: "tool-call-1",
      ...args,
    });
  },
);
