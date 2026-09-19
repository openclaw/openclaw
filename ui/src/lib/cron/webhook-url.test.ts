// @vitest-environment node
// Control UI tests cover cron webhook delivery-target validation.
import { describe, expect, it } from "vitest";
import { DEFAULT_CRON_FORM } from "../../test-helpers/cron.ts";
import { validateCronForm } from "./index.ts";

// Build userinfo-bearing URLs at runtime (mirroring what a user could type)
// so the fixtures stay free of literal embedded-credential strings. Any
// non-empty userinfo segment must be rejected, so the values are arbitrary.
const webhookUrlWithUserinfo = (scheme: "http" | "https", withPassword: boolean) => {
  const url = new URL(`${scheme}://example.com/hook`);
  url.username = "user";
  if (withPassword) {
    url.password = url.username;
  }
  return url.href;
};

describe("cron webhook URL validation", () => {
  it.each([
    webhookUrlWithUserinfo("https", true),
    webhookUrlWithUserinfo("http", false),
    "https://exa mple.com/hook",
    "http://",
  ])("rejects webhook URLs the server boundary rejects: %j", (deliveryTo) => {
    const errors = validateCronForm({
      ...DEFAULT_CRON_FORM,
      name: "Webhook job",
      payloadKind: "agentTurn",
      payloadText: "Run",
      deliveryMode: "webhook",
      deliveryTo,
    });

    expect(errors.deliveryTo).toBe("cron.errors.webhookUrlInvalid");
  });

  it("accepts a well-formed webhook URL without userinfo", () => {
    const errors = validateCronForm({
      ...DEFAULT_CRON_FORM,
      name: "Webhook job",
      payloadKind: "agentTurn",
      payloadText: "Run",
      deliveryMode: "webhook",
      deliveryTo: "https://example.com/hook",
    });

    expect(errors.deliveryTo).toBeUndefined();
  });
});
