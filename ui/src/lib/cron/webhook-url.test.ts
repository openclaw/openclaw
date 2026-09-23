// @vitest-environment node
import { describe, expect, it } from "vitest";
import { DEFAULT_CRON_FORM } from "../../test-helpers/cron.ts";
import { validateCronForm } from "./index.ts";

function userinfoUrl(field: "username" | "password") {
  const url = new URL("https://example.test/hook");
  url[field] = "fixture";
  return url.href;
}

function validateWebhook(deliveryTo: string) {
  return validateCronForm({
    ...DEFAULT_CRON_FORM,
    name: "Webhook job",
    payloadKind: "agentTurn",
    payloadText: "Run",
    deliveryMode: "webhook",
    deliveryTo,
  });
}

describe("cron webhook URL validation", () => {
  it.each([
    { name: "username", value: userinfoUrl("username") },
    { name: "password without username", value: userinfoUrl("password") },
    { name: "malformed host", value: "https://bad host.example.test/hook" },
  ])("rejects $name before submission", ({ value }) => {
    expect(validateWebhook(value)).toEqual({ deliveryTo: "cron.errors.webhookUrlInvalid" });
  });

  it("retains the literal HTTP(S) prefix requirement", () => {
    expect(validateWebhook("https:example.test/hook")).toEqual({
      deliveryTo: "cron.errors.webhookUrlInvalid",
    });
  });

  it("keeps an empty target distinct from an invalid URL", () => {
    expect(validateWebhook("  ")).toEqual({ deliveryTo: "cron.errors.webhookUrlRequired" });
  });

  it.each(["http", "https"])(
    "accepts a valid %s target without leaving a blocking error key",
    (scheme) => {
      expect(validateWebhook(`${scheme}://example.test/hook`)).toEqual({});
    },
  );
});
