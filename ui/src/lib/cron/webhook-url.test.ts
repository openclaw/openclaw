// @vitest-environment node
import { expect, it } from "vitest";
import { DEFAULT_CRON_FORM } from "../../test-helpers/cron.ts";
import { validateCronForm } from "./form.ts";

function userinfoUrl(field: "username" | "password") {
  const url = new URL("https://example.test/hook");
  url[field] = "fixture";
  return url.href;
}

it.each([
  [userinfoUrl("username"), "cron.errors.webhookUrlWithCredentials"],
  [userinfoUrl("password"), "cron.errors.webhookUrlWithCredentials"],
  ["https://bad host.example.test/hook", "cron.errors.webhookUrlInvalid"],
  ["https:example.test/hook", "cron.errors.webhookUrlProtocol"],
  ["ftp://example.test/hook", "cron.errors.webhookUrlProtocol"],
  ["  ", "cron.errors.webhookUrlRequired"],
  ["http://example.test/hook", undefined],
  ["https://example.test/hook", undefined],
] as const)("validates webhook target %s before submission", (deliveryTo, error) => {
  expect(
    validateCronForm({
      ...DEFAULT_CRON_FORM,
      name: "Webhook job",
      payloadKind: "agentTurn",
      payloadText: "Run",
      deliveryMode: "webhook",
      deliveryTo,
    }),
  ).toEqual(error ? { deliveryTo: error } : {});
});
