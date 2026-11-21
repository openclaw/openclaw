import { afterEach, describe, expect, it } from "vitest";
import { redactSensitiveText } from "./redact.js";
import { registerSecretValueForRedaction } from "./secret-redaction-registry.js";
import { resetSecretRedactionRegistryForTest } from "./secret-redaction-registry.test-support.js";

const arn = "arn:aws:sns:us-east-1:123456789012:application-notifications-topic";
const token = "123456789012:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghi";

afterEach(() => resetSecretRedactionRegistryForTest());

describe("AWS ARN context in the bare Telegram heuristic", () => {
  it.each([
    arn,
    arn.replace("aws:", "aws-cn:").replace("us-east-1", "cn-north-1"),
    arn.replace("aws:", "aws-us-gov:").replace("us-east-1", "us-gov-west-1"),
    arn.replace("sns:us-east-1", "iam:"),
  ])("preserves a nonsecret ARN: %s", (value) => {
    expect(redactSensitiveText(`Resource (${value})`, { mode: "tools" })).toBe(
      `Resource (${value})`,
    );
  });

  it.each([
    token,
    `bot${token}`,
    `https://api.telegram.org/bot${token}/sendMessage`,
    arn.replace("arn:aws:", "arn:other:"),
    arn.replace("arn:aws:", "arn:aws--:"),
    arn.replace("arn:aws:", "ARN:AWS:"),
    arn.replace("sns:", ":"),
    arn.replace("us-east-1", "us/east/1"),
    arn.replace("123456789012", "12345678901"),
    arn.replace("123456789012", "1234567890123"),
    arn.replace("123456789012", "bot123456789012"),
    `ch${arn}`,
    `${arn}:${token}`,
  ])("still masks tokens outside a well-formed account context: %s", (value) => {
    const output = redactSensitiveText(value, { mode: "tools" });
    expect(output).not.toBe(value);
    expect(output).toContain("…");
  });

  it.each([16_384, 32_768])(
    "preserves ARN context and masks adjacent tokens across offset %i",
    (offset) => {
      const prefix = `${".".repeat(offset - arn.indexOf("123456789012") - 7)} `;
      const input = `${prefix}${arn} ${token} bot${token}${".".repeat(33_000)}`;
      const output = redactSensitiveText(input, { mode: "tools" });
      expect(output.startsWith(`${prefix}${arn} `)).toBe(true);
      expect(output).not.toContain(token);
    },
  );

  it.each([16_384, 32_768])("masks tokens straddling offset %i", (boundary) => {
    const input = `${arn}${".".repeat(boundary - arn.length - 7)} ${token} bot${token}${".".repeat(33_000)}`;
    const output = redactSensitiveText(input, { mode: "tools" });
    expect(output).toContain(arn);
    expect(output).not.toContain(token);
  });

  it("does not exempt an ARN from configured regexes", () => {
    const output = redactSensitiveText(arn, {
      mode: "tools",
      patterns: ["application-notifications-topic"],
    });
    expect(output).not.toContain("application-notifications-topic");
  });

  it("still masks an exact registered ARN-shaped secret", () => {
    registerSecretValueForRedaction(arn);
    expect(redactSensitiveText(`Resource ${arn}`)).toBe("Resource arn:aw…opic");
  });
});
