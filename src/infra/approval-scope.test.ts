import { expect, it } from "vitest";
import {
  sanitizeApprovalScope,
  summarizeApprovalScope,
  type ApprovalScope,
} from "./approval-scope.js";

const message = {
  kind: "message-send",
  target: "email",
  recipientCount: 1,
} satisfies ApprovalScope;
const payment = {
  kind: "payment",
  amount: "49.99",
  currency: "EUR",
  target: "Stripe",
} satisfies ApprovalScope;
const grant = {
  kind: "standing-grant",
  automation: "nightly backup",
  command: "id -un",
} satisfies ApprovalScope;

it.each([
  [{ ...message, target: "slack #general" }, "Send to 1 recipient via slack #general"],
  [payment, "Pay 49.99 EUR to Stripe"],
  [
    { kind: "external-post", target: "github", visibility: "restricted" },
    "Post restricted to github",
  ],
] satisfies [ApprovalScope, string][])("summarizes $kind", (scope, expected) => {
  expect(summarizeApprovalScope(scope)).toBe(expected);
});

it("clamps recipient previews to the declared recipient count", () => {
  const clamped = sanitizeApprovalScope({
    ...message,
    recipients: ["alice@example.com", "bob@example.com"],
    audience: "internal",
  });
  expect(clamped).toEqual({ ...message, recipients: ["alice@example.com"], audience: "internal" });
  expect(summarizeApprovalScope(clamped!)).toBe(
    "Send to 1 recipient via email (internal): alice@example.com",
  );
});

it.each([
  { ...message, recipients: [`${"x".repeat(127)}\u202E`] },
  { ...payment, amount: `${"x".repeat(39)}\u202E` },
  { ...payment, currency: `${"x".repeat(11)}\u202E` },
  { ...grant, automation: `${"x".repeat(127)}\u202E` },
  { ...grant, automation: "nightly", command: `${"x".repeat(255)}\u202E` },
] satisfies ApprovalScope[])("rejects oversized escaped $kind fields", (scope) => {
  expect(sanitizeApprovalScope(scope)).toBeNull();
});

it("sanitizes and summarizes standing-grant scopes", () => {
  const sanitized = sanitizeApprovalScope({ ...grant, expiresInDays: 30 });
  expect(sanitized).toEqual({ ...grant, expiresInDays: 30 });
  expect(summarizeApprovalScope(sanitized!)).toBe(
    'Always allow runs this exact command for "nightly backup" without asking, for 30 days (revocable)',
  );
  expect(summarizeApprovalScope(grant)).toBe(
    'Always allow runs this exact command for "nightly backup" without asking, until revoked (revocable)',
  );
});
