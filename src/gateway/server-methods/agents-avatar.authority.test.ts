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
const design = {
  version: 1,
  id: "garden-keeper",
  name: "Garden Keeper",
  description: "A gardener with a sprout.",
  palette: { shell: "#87b891", claw: "#5b9471", glint: "#fff0b3" },
  layers: { back: "", left_prop: "", right_prop: "", shell_overlay: "", accessory: "" },
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
  utility.route.mockReset();
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

async function generate(
  authority: ReturnType<typeof operator>["authority"],
  hasCurrentClientAuthority = () => true,
) {
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
    hasCurrentClientAuthority,
  });
  return respond;
}

it("returns a preview through the real handler and isolated completion owner", async () => {
  const dispatch = vi.fn(async () => ({
    assistant: {
      ...isolatedAssistant([{ type: "text", text: JSON.stringify(design) }]),
      provider: "test-provider",
      model: "allowed",
    },
  }));
  utility.route.mockResolvedValue({
    selection: {
      selectedHarnessId: "test-harness",
      harness: { id: "test-harness", runIsolatedCompletionV2: dispatch },
    },
  });
  const respond = await generate(operator().authority);
  expect(dispatch).toHaveBeenCalledOnce();
  expect(respond).toHaveBeenCalledWith(
    true,
    expect.objectContaining({ name: "Garden Keeper", svg: expect.stringContaining("<svg") }),
    undefined,
  );
});

it.each(["device", "model"] as const)(
  "does not dispatch to the provider after %s authority is revoked during route preparation",
  async (kind) => {
    const dispatch = vi.fn();
    const access = operator();
    let deviceCurrent = true;
    let firstRoute = true;
    utility.route.mockImplementation(async () => {
      if (firstRoute) {
        firstRoute = false;
        if (kind === "device") {
          deviceCurrent = false;
        } else {
          access.revokeModel();
        }
      }
      return {
        selection: {
          selectedHarnessId: "test-harness",
          harness: { id: "test-harness", runIsolatedCompletionV2: dispatch },
        },
      };
    });
    const respond = await generate(access.authority, () => deviceCurrent);
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: kind === "device" ? "UNAVAILABLE" : "FORBIDDEN",
      }),
    );
    expect(dispatch).not.toHaveBeenCalled();
  },
);

it("does not retry or publish after model access is revoked during the first completion", async () => {
  const access = operator();
  const dispatch = vi.fn(async () => {
    access.revokeModel();
    return {
      assistant: {
        ...isolatedAssistant([{ type: "text", text: "invalid design" }]),
        provider: "test-provider",
        model: "allowed",
      },
    };
  });
  utility.route.mockResolvedValue({
    selection: {
      selectedHarnessId: "test-harness",
      harness: { id: "test-harness", runIsolatedCompletionV2: dispatch },
    },
  });
  const respond = await generate(access.authority);
  expect(respond).toHaveBeenCalledWith(
    false,
    undefined,
    expect.objectContaining({ code: "FORBIDDEN" }),
  );
  expect(dispatch).toHaveBeenCalledOnce();
});
