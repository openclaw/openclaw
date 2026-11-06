// OpenAI web-search minimal tests cover QA Lab hosted provider schema evidence.
import { describe, expect, it } from "vitest";
import { testing } from "../../../../scripts/e2e/lib/openai-web-search-minimal/client.mjs";

// Keep scenario defaults independent so changing the client cannot rewrite its expected inputs.
const GATEWAY_SCHEMA_ERROR = "provider rejected the request schema or tool payload";
const GATEWAY_SCHEMA_GUIDANCE =
  "The AI service couldn't accept this request. Try a new conversation with /new, or choose another model in the Control UI.";
const GATEWAY_SCHEMA_DETAIL = String.raw`LLM request rejected: The following tools cannot be used with reasoning\.effort \'minimal\'\: web\_search\.`;
const SUCCESS_MARKER = "OPENCLAW_SCHEMA_E2E_OK";

describe("scripts/e2e/lib/openai-web-search-minimal/client.mjs", () => {
  it.each([GATEWAY_SCHEMA_ERROR, GATEWAY_SCHEMA_GUIDANCE, GATEWAY_SCHEMA_DETAIL])(
    "accepts the gateway schema rejection in reject mode: %s",
    (message) => {
      expect(
        testing.validateRejectResult({
          ok: false,
          error: new Error(`GatewayClientRequestError: ${message} | invalid_request_error`),
        }),
      ).toContain(message);
    },
  );

  it.each(["LLM request rejected: Unknown model | invalid_request_error"])(
    "fails reject mode on unrelated errors: %s",
    (message) => {
      expect(() =>
        testing.validateRejectResult({
          ok: false,
          error: new Error(message),
        }),
      ).toThrow(/reject mode failed for an unexpected reason/u);
    },
  );

  it("rejects out-of-range gateway ports before connecting", () => {
    expect(() => testing.resolveGatewayPort({ PORT: "65536" })).toThrow("invalid PORT: 65536");
  });
  it("accepts success markers from the gateway agent result envelope", () => {
    expect(() =>
      testing.validateSuccessResult({
        ok: true,
        value: {
          result: {
            meta: { finalAssistantVisibleText: SUCCESS_MARKER },
            payloads: [{ text: "secondary reply" }],
          },
          status: "ok",
        },
      }),
    ).not.toThrow();
  });

  it("fails success mode when the agent run completes without the marker", () => {
    expect(() =>
      testing.validateSuccessResult({
        ok: true,
        value: { status: "ok" },
      }),
    ).toThrow(/completed without success marker/u);
  });

  it("does not accept success markers from error payload text", () => {
    expect(() =>
      testing.validateSuccessResult({
        ok: true,
        value: {
          payloads: [{ isError: true, text: SUCCESS_MARKER }],
          status: "ok",
        },
      }),
    ).toThrow(/completed without success marker/u);
  });
});
