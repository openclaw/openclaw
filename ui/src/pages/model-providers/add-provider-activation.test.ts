/* @vitest-environment jsdom */
import { expect, it } from "vitest";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../../test-helpers/gateway-client.ts";
import { activateAddedKey } from "./add-provider-activation.ts";
import { createHarness } from "./model-providers-page.test-support.tsx";

registerSettingsEnglish();

it.each([
  {
    status: "billing",
    kind: "error",
    reason: "The account has no available credits.",
    advice: "Check the provider’s billing or quota, then save again.",
  },
  {
    status: "auth",
    kind: "error",
    reason: "The provider rejected this credential.",
    advice: "Enter a different key.",
  },
  {
    status: "timeout",
    kind: "warning",
    reason: "The check timed out.",
    advice: "check didn’t finish",
  },
] as const)(
  "keeps $status activation feedback and its matching recovery",
  async ({ status, kind, reason, advice }) => {
    const { context } = createHarness("main");
    const request = createGatewayRequestMock(async () => ({ ok: false, status, error: reason }));
    const client = createTestGatewayClient(request);
    const result = await activateAddedKey({
      context,
      client,
      agentId: "main",
      profileId: "xai:manual-api-key",
      provider: "xai",
    });
    expect(result.message.kind).toBe(kind);
    expect(result.message.text).toContain(reason);
    expect(result.message.text).toContain(advice);
    expect(result.model).toBeUndefined();
    if (status !== "auth") {
      expect(result.message.text).not.toContain("provider didn’t accept it");
      expect(result.message.text).not.toContain("Enter a different key");
    }
  },
);

it.each([
  [["Inference verified: local/nemo"], undefined],
  [
    [
      "Inference verified: local/nemo",
      "local/nemo has an effective context window of 8192 tokens.",
    ],
    "local/nemo has an effective context window of 8192 tokens.",
  ],
])("shows activation notices with a successful key (%j)", async (lines, warning) => {
  const { context } = createHarness("main");
  const request = createGatewayRequestMock(async () => ({
    ok: true,
    modelRef: "local/nemo",
    lines,
  }));
  const result = await activateAddedKey({
    context,
    client: createTestGatewayClient(request),
    agentId: "main",
    profileId: "local:manual-api-key",
    provider: "local",
  });
  expect(result.message.kind).toBe("success");
  expect(result.message.warning).toBe(warning);
  expect(result.model).toMatchObject({ provider: "local", id: "nemo" });
});

it("retains the diagnostic when activation cannot be checked", async () => {
  const { context } = createHarness("main");
  const client = createTestGatewayClient(async () => {
    throw new Error("Activation reply unavailable");
  });
  const result = await activateAddedKey({
    context,
    client,
    agentId: "main",
    profileId: "xai:manual-api-key",
    provider: "xai",
  });
  expect(result.message.kind).toBe("warning");
  expect(result.message.warning).toContain("Activation reply unavailable");
  expect(result.message.text).toContain("couldn’t check it");
  expect(result.model).toBeUndefined();
});
