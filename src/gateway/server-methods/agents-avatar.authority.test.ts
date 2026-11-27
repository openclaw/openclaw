import { beforeEach, expect, it, vi } from "vitest";
import { createTestOperatorAuthority } from "../../agents/admitted-run-context.test-support.js";
import {
  isolatedAssistant,
  isolatedCompletionMocks as completion,
  resetIsolatedCompletionTestState,
} from "../../agents/isolated-completion.test-support.js";
import { prepareOperatorModelPolicy } from "../../agents/operator-model-policy.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createGardenKeeperDesign } from "../avatar-design.test-support.js";
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
const design = createGardenKeeperDesign("A gardener with a sprout.", "");

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
  return {
    get authority() {
      return createTestOperatorAuthority({
        profileId: "avatar-operator",
        scopes: ["operator.admin"],
        modelPolicy: prepareOperatorModelPolicy({
          cfg,
          policy: { allow: allowed ? ["test-provider/allowed"] : [] },
          manifestPlugins: [],
        }),
      });
    },
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

it.each(["device", "model"] as const)(
  "retains the device fence and admitted model policy during route preparation (%s)",
  async (kind) => {
    const dispatch = vi.fn(async () => ({
      assistant: {
        ...isolatedAssistant([{ type: "text", text: JSON.stringify(design) }]),
        provider: "test-provider",
        model: "allowed",
      },
    }));
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
    if (kind === "device") {
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "UNAVAILABLE" }),
      );
      expect(dispatch).not.toHaveBeenCalled();
    } else {
      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ name: "Garden Keeper", svg: expect.stringContaining("<svg") }),
        undefined,
      );
      expect(dispatch).toHaveBeenCalledOnce();
      expect(await generate(access.authority)).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "FORBIDDEN" }),
      );
      expect(dispatch).toHaveBeenCalledOnce();
    }
  },
);

it("does not retry or publish after device authority is revoked during the first completion", async () => {
  const access = operator();
  let deviceCurrent = true;
  const dispatch = vi.fn(async () => {
    deviceCurrent = false;
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
  const respond = await generate(access.authority, () => deviceCurrent);
  expect(respond).toHaveBeenCalledWith(
    false,
    undefined,
    expect.objectContaining({ code: "UNAVAILABLE" }),
  );
  expect(dispatch).toHaveBeenCalledOnce();
});
