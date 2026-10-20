import { beforeEach, expect, it, vi } from "vitest";
import { createAdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import {
  isolatedAssistant,
  isolatedCompletionMocks as completion,
  resetIsolatedCompletionTestState,
} from "../../agents/isolated-completion.test-support.js";
import { prepareOperatorModelPolicy } from "../../agents/operator-model-policy.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { agentAvatarGenerateHandler } from "./agents-avatar.js";
import type { GatewayRequestContext, GatewayRequestHandlerOptions } from "./types.js";

const utility = vi.hoisted(() => ({ prepare: vi.fn(), provider: vi.fn(), route: vi.fn() }));
// mock-isolation: Keep provider credentials and configured routes out of this synthetic dispatch test.
vi.mock("../../agents/utility-completion.js", () => ({
  prepareUtilityCompletionForAgent: utility.prepare,
}));
// mock-isolation: Supply a controlled provider harness to exercise the real completion authority checks.
vi.mock("../../agents/isolated-completion-route.js", () => ({
  resolveIsolatedCompletionProvider: utility.provider,
  resolveIsolatedCompletionRoute: utility.route,
}));

const cfg: OpenClawConfig = {
  agents: { defaults: { model: { primary: "test-provider/allowed" } } },
};
const dispatch = vi.fn();
const route = {
  selection: {
    selectedHarnessId: "test-harness",
    harness: { id: "test-harness", runIsolatedCompletionV2: dispatch },
  },
};

beforeEach(() => {
  resetIsolatedCompletionTestState();
  utility.prepare.mockReset().mockResolvedValue({
    config: cfg,
    agentId: "main",
    provider: "test-provider",
    model: "allowed",
    thinkLevel: "off",
    outputTextPolicy: "strict-visible",
  });
  utility.provider.mockReset().mockReturnValue({ provider: "test-provider" });
  utility.route.mockReset().mockResolvedValue(route);
  dispatch.mockReset();
  completion.resolveModelAsync.mockImplementation(async (provider, model) => ({
    logicalRef: { provider, model },
    model: { provider, id: model, api: "openai-completions" },
  }));
  completion.prepareSimpleCompletionModel.mockImplementation(async (params) => {
    const resolved = await params.modelResolver(
      params.provider,
      params.modelId,
      params.agentDir,
      params.cfg,
    );
    return {
      model: resolved.model,
      auth: { apiKey: "synthetic-test-key", source: "fixture", mode: "api-key" },
    };
  });
});

function operator() {
  let allowed = true;
  const authority = createAdmittedRunOperatorAuthority({
    profileId: "avatar-operator",
    scopes: ["operator.admin"],
    assertCurrent: () => {},
    get modelPolicy() {
      return prepareOperatorModelPolicy({
        cfg,
        policy: { allow: allowed ? ["test-provider/allowed"] : [] },
        manifestPlugins: [],
      });
    },
  });
  return {
    authority,
    revokeModel: () => {
      allowed = false;
    },
  };
}

async function generate(authority: ReturnType<typeof operator>["authority"]) {
  const respond = vi.fn();
  await agentAvatarGenerateHandler({
    req: { type: "req", id: "avatar-authority", method: "agents.avatar.generate" },
    params: { agentId: "main", prompt: "A gardener" },
    respond,
    context: { getRuntimeConfig: () => cfg } as GatewayRequestContext,
    client: {
      connect: { role: "operator", scopes: ["operator.admin"] },
      internal: { operatorRunAuthority: authority },
    } as GatewayRequestHandlerOptions["client"],
    isWebchatConnect: () => false,
  });
  return respond;
}

it("does not dispatch after model authority is revoked during route preparation", async () => {
  const access = operator();
  utility.route.mockImplementationOnce(async () => {
    access.revokeModel();
    return route;
  });
  const respond = await generate(access.authority);
  expect(respond).toHaveBeenCalledWith(
    false,
    undefined,
    expect.objectContaining({
      code: "FORBIDDEN",
    }),
  );
  expect(dispatch).not.toHaveBeenCalled();
});

it("does not retry or publish after model access is revoked during the first completion", async () => {
  const access = operator();
  dispatch.mockImplementation(async () => {
    access.revokeModel();
    return {
      assistant: {
        ...isolatedAssistant([{ type: "text", text: "invalid design" }]),
        provider: "test-provider",
        model: "allowed",
      },
    };
  });
  const respond = await generate(access.authority);
  expect(respond).toHaveBeenCalledWith(
    false,
    undefined,
    expect.objectContaining({ code: "FORBIDDEN" }),
  );
  expect(dispatch).toHaveBeenCalledOnce();
});
