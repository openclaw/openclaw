import type { Model } from "@openclaw/llm-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { defersTokenCompactionToChatGPTBoundary } from "./agent-runner-memory-runtime.js";
import { createTestFollowupRun } from "./agent-runner.test-fixtures.js";

type Route = Pick<Model, "provider" | "api" | "baseUrl">;
const boundary = vi.hoisted(() => ({
  plan: vi.fn<() => { plan: { modelRoute?: Route } }>(),
  extra: vi.fn<() => Record<string, unknown>>(),
}));

vi.mock("../../agents/auth-profiles.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/auth-profiles.js")>()),
  getPreparedRuntimeAuthProfileStoreSnapshot: () => undefined,
}));
vi.mock("../../agents/runtime-plan/prepare-auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/runtime-plan/prepare-auth.js")>()),
  prepareAgentRuntimeAuth: boundary.plan,
}));
vi.mock("../../agents/embedded-agent-runner/extra-params.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/embedded-agent-runner/extra-params.js")>()),
  resolvePreparedExtraParams: boundary.extra,
}));

const native: Route = {
  provider: "openai",
  api: "openai-chatgpt-responses",
  baseUrl: "https://chatgpt.com/backend-api/codex",
};
const run = () => createTestFollowupRun({ provider: "openai", model: "fixture-model" }).run;

beforeEach(() => {
  boundary.plan.mockReset().mockReturnValue({ plan: { modelRoute: native } });
  boundary.extra.mockReset().mockReturnValue({});
});

describe("post-reply native compaction eligibility", () => {
  it.each<{ name: string; route: Route }>([
    {
      name: "regular OpenAI API",
      route: { provider: "openai", api: "openai-responses", baseUrl: "https://api.openai.com/v1" },
    },
    { name: "compatible proxy", route: { ...native, baseUrl: "https://proxy.invalid/v1" } },
    {
      name: "another SDK provider",
      route: {
        provider: "anthropic",
        api: "anthropic-messages",
        baseUrl: "https://api.anthropic.com",
      },
    },
  ])("does not load provider runtime parameters for $name", async ({ route }) => {
    boundary.plan.mockReturnValue({ plan: { modelRoute: route } });
    boundary.extra.mockImplementation(() => {
      throw new Error("An ineligible route must not load provider runtime parameters");
    });
    await expect(defersTokenCompactionToChatGPTBoundary(run())).resolves.toBe(false);
    expect(boundary.extra).not.toHaveBeenCalled();
  });

  it.each([
    { extra: {}, expected: true },
    { extra: { responsesCompactEndpoint: false }, expected: false },
    { extra: { responsesServerCompaction: false }, expected: false },
  ])("preserves native request policy $extra", async ({ extra, expected }) => {
    boundary.extra.mockReturnValue(extra);
    await expect(defersTokenCompactionToChatGPTBoundary(run())).resolves.toBe(expected);
    expect(boundary.extra).toHaveBeenCalledOnce();
  });

  it("retains ordinary maintenance when no current route is available", async () => {
    boundary.plan.mockReturnValue({ plan: {} });
    await expect(defersTokenCompactionToChatGPTBoundary(run())).resolves.toBe(false);
    expect(boundary.extra).not.toHaveBeenCalled();
  });

  it("retains ordinary maintenance when route metadata is stale", async () => {
    boundary.plan.mockImplementation(() => {
      throw new Error("Stale route metadata");
    });
    await expect(defersTokenCompactionToChatGPTBoundary(run())).resolves.toBe(false);
    expect(boundary.extra).not.toHaveBeenCalled();
  });
});
