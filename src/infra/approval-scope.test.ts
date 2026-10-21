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
  [
    {
      ...message,
      recipientCount: 3,
      recipients: ["alice@x.com", "bob@y.com"],
      audience: "external",
    },
    "Send to 3 recipients via email (external): alice@x.com, bob@y.com, +1 more",
  ],
  [{ ...message, target: "slack #general" }, "Send to 1 recipient via slack #general"],
  [payment, "Pay 49.99 EUR to Stripe"],
  [{ kind: "external-post", target: "github", visibility: "public" }, "Post publicly to github"],
  [
    { kind: "external-post", target: "github", visibility: "restricted" },
    "Post restricted to github",
  ],
] satisfies [ApprovalScope, string][])("summarizes $kind", (scope, expected) => {
  expect(summarizeApprovalScope(scope)).toBe(expected);
});

it("preserves clean scope fields and visibly escapes spoofing characters", () => {
  const cleanScope = {
    ...message,
    recipients: ["alice@example.com"],
    audience: "internal",
  } satisfies ApprovalScope;
  expect(sanitizeApprovalScope(cleanScope)).toEqual(cleanScope);
  expect(sanitizeApprovalScope({ ...cleanScope, target: "mail\u202Ebox" })).toMatchObject({
    target: "mail\\u{202E}box",
  });
  expect(sanitizeApprovalScope({ ...cleanScope, target: "🦞".repeat(128) })).toMatchObject({
    target: "🦞".repeat(128),
  });
});

it("clamps recipient previews to the declared recipient count", () => {
  const clamped = sanitizeApprovalScope({
    ...message,
    recipients: ["alice@example.com", "bob@example.com"],
  });
  expect(clamped).toMatchObject({ recipientCount: 1, recipients: ["alice@example.com"] });
  expect(summarizeApprovalScope(clamped!)).toBe("Send to 1 recipient via email: alice@example.com");
});

it.each([
  { ...message, target: `${"x".repeat(127)}\u202E` },
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
