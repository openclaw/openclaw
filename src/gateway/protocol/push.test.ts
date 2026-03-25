import AjvPkg from "ajv";
import { describe, expect, it } from "vitest";
import { PushTestResultSchema } from "./schema/push.js";

describe("gateway protocol push schema", () => {
  const Ajv = AjvPkg as unknown as new (opts?: object) => import("ajv").default;
  const ajv = new Ajv({ allErrors: true, strict: false });
  const validatePushTestResult = ajv.compile(PushTestResultSchema);

  it("accepts push.test results with a transport", () => {
    expect(
      validatePushTestResult({
        ok: true,
        status: 200,
        tokenSuffix: "abcd1234",
        topic: "ai.openclaw.ios",
        environment: "production",
        transport: "relay",
      }),
    ).toBe(true);
  });
});
