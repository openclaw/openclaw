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
import {
  getGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "./gateway-caller-context.js";
import { createGitHubPublishTool, githubPublishToolDefinition } from "./github-publish-tool.js";
import { callInProcessGatewayTool } from "./in-process-gateway.js";

vi.mock("./in-process-gateway.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./in-process-gateway.js")>()),
  callInProcessGatewayTool: vi.fn(),
}));

const caller = { agentId: "main", sessionKey: "agent:main:host-owned" };
const publication = {
  requestId: "publication-1",
  status: "requested" as const,
  message: "Publication was accepted.",
};
const pullRequestUrl = "https://github.com/example/repository/pull/1";
const inspection = { action: "inspect_pr", pullRequestUrl };
const preparation = { ...inspection, action: "prepare_pr" };
const unavailable = async () => {
  throw new Error("Schema fixture must not perform IO");
};
function restrictActions(
  definition: Pick<ReturnType<typeof createGitHubPublishTool>, "name" | "parameters">,
  actions: string[],
) {
  const [tool] = applyGatewayToolPolicy([definition], {
    tools: { gatewayPolicy: { allow: ["github_publish"], actions: { github_publish: actions } } },
  });
  return expectDefined(tool, "restricted tool").parameters;
}
function setup(actionsAvailable = false) {
  const callGateway = vi
    .mocked(callInProcessGatewayTool)
    .mockReset()
    .mockResolvedValue(publication);
  const tool = createGitHubPublishTool({ actionsAvailable });
  const execute = (args: unknown, id = "choice") =>
    withGatewayToolCallerIdentity(caller, () => tool.execute(id, args));
  return { callGateway, tool, execute };
}

it("applies deployment action limits when publication and operator actions are available", () => {
  const restricted = restrictActions(createGitHubPublishTool({ actionsAvailable: true }), [
    "publish",
    "inspect",
  ]);
  expect(restricted).toMatchObject({
    properties: { action: { enum: ["publish", "inspect"] } },
  });
  expect(Value.Check(restricted, inspection)).toBe(false);
  for (const definition of [
    githubPublishToolDefinition,
    createGitHubPublishTool(),
    createGitHubPublishTool({ publicationAvailable: false, actionsAvailable: true }),
  ]) {
    expect(Value.Check(restrictActions(definition, ["inspect_pr"]), inspection)).toBe(true);
  }
  expect(Value.Check(restricted, preparation)).toBe(false);
  for (const definition of [
    githubPublishToolDefinition,
    createGitHubPublishTool({ sandbox: publicationSandbox() }),
  ]) {
    const parameters = restrictActions(definition, ["prepare_pr"]);
    expect(Value.Check(parameters, preparation)).toBe(true);
    expect(Value.Check(parameters, inspection)).toBe(false);
    expect(Value.Check(parameters, { pullRequestUrl: preparation.pullRequestUrl })).toBe(false);
  }
});

function publicationSandbox(overrides: Partial<SandboxContext> = {}) {
  return createSandboxTestContext({
    overrides: {
      workspaceSource: "managed-worktree",
      fsBridge: {
        ...createHostSandboxFsBridge("/tmp/github-publish"),
        readFileWithSource: unavailable,
      },
      backend: {
        id: "docker",
        runtimeId: "fixture",
        runtimeLabel: "fixture",
        workdir: "/workspace",
        buildExecSpec: unavailable,
        runShellCommand: unavailable,
      },
      ...overrides,
    },
  });
}

it.each<[string, Partial<SandboxContext> | null, boolean, boolean, boolean]>([
  ["direct session", null, false, false, false],
  ["writable managed sandbox", {}, true, true, true],
  ["read-only managed sandbox", { workspaceAccess: "ro" }, false, false, true],
  ["unmanaged local sandbox", { workspaceSource: undefined }, true, false, true],
  [
    "unmanaged remote sandbox",
    { workspaceSource: undefined, backendId: "ssh" },
    false,
    false,
    true,
  ],
  ["missing backend", { backend: undefined }, false, false, true],
  ["missing file bridge", { fsBridge: undefined }, true, true, false],
  [
    "missing source-aware read",
    { fsBridge: createHostSandboxFsBridge("/tmp/github-publish") },
    true,
    true,
    false,
  ],
  ["disabled sandbox", { enabled: false }, false, false, false],
])("offers only supported sandbox actions for %s", (_name, sandbox, prepare, refresh, evidence) => {
  for (const actionsAvailable of [false, true]) {
    const tool = createGitHubPublishTool({
      sandbox: sandbox === null ? null : publicationSandbox(sandbox),
      actionsAvailable,
    });
    for (const [action, offered, properties] of [
      ["prepare_pr", prepare, []],
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
    const description = tool.description;
    finalizeAgentToolAvailability([tool]);
    expect(tool.description).toBe(description);
  }
});

it.each([
  "inspect_pr",
  "prepare_pr",
  "edit",
  "refresh_base",
  "ready",
  "request_review",
  "upload_evidence",
])("rejects draft on %s without changing PR state", async (action) => {
  const { callGateway, execute } = setup(true);
  await expect(execute({ action, draft: false })).rejects.toThrow(
    "draft only selects the state when publishing a new PR",
  );
  expect(callGateway).not.toHaveBeenCalled();
});

// Unbound sandboxed conversations yield first; github-publish-tool.handoff.test.ts owns that path.
it.each([
  {},
  { conflictsResolved: false },
  { conflictsResolved: true, expectedHeadCommit: "a".repeat(40) },
])(
  "dispatches preparation with its current sandbox and acknowledgement %j before owner qualification",
  async (acknowledgement) => {
    const sandbox = publicationSandbox();
    const callGateway = vi
      .mocked(callInProcessGatewayTool)
      .mockReset()
      .mockImplementation(async () => {
        expect(getGatewayToolCallerIdentity()?.workspaceBaseRefreshSandbox).toBe(sandbox);
        return publication;
      });
    const tool = createGitHubPublishTool({ sandbox });
    const input = { ...preparation, ...acknowledgement };
    expect(Value.Check(tool.parameters, input)).toBe(true);
    await withGatewayToolCallerIdentity(caller, () => tool.execute("prepare", input));
    expect(callGateway).toHaveBeenCalledExactlyOnceWith(
      "sessions.github.action",
      { sessionKey: caller.sessionKey, ...input },
      { timeoutMs: 600_000 },
    );
  },
);

it("offers current-PR preparation without privileged actions", () => {
  const tool = createGitHubPublishTool({ sandbox: publicationSandbox() });
  const check = (args: unknown, valid = true) =>
    expect(Value.Check(tool.parameters, args)).toBe(valid);
  check(inspection);
  check(preparation);
  const request = {
    requestId: "a1111111-1111-4111-8111-111111111111",
    expectedHeadCommit: "a".repeat(40),
  };
  for (const action of ["publish", "edit", "ready", "request_review"]) {
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
  expect(tool.description).toContain("omit action to append accepted changes to the original PR");
  expect(tool.description).toContain("used only when creating a PR");
  expect(tool.description).toContain("retain requestId, finish the turn and await its result here");
  expect(tool.description).toContain("do not submit another publication to recover it");
  expect(tool.description).toContain("Edit never synchronizes, stages, commits or pushes");
  expect(tool.description).not.toContain("Imported source publication is not available");
  const actionOnly = createGitHubPublishTool({
    publicationAvailable: false,
    actionsAvailable: true,
  });
  expect(Value.Check(actionOnly.parameters, { action: "edit" })).toBe(false);
  expect(Value.Check(actionOnly.parameters, preparation)).toBe(false);
  const operator = createGitHubPublishTool({ actionsAvailable: true });
  for (const action of ["inspect", "merge", "close"]) {
    for (const { parameters } of [actionOnly, operator]) {
      expect(Value.Check(parameters, { action })).toBe(true);
    }
  }
  expect(
    Value.Check(operator.parameters, {
      action: "ready",
      publishingSessionKey: "agent:main:child",
    }),
  ).toBe(true);
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
