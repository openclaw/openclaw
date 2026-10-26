import { expect, it } from "vitest";
import {
  getCredentialUnavailableDiagnostics,
  projectSafeChannelAccountSnapshotFields,
  redactChannelStatusSummaryBaseUrl,
} from "./account-snapshot-fields.js";

function credentialUrl(user: string, password: string, hostAndPath: string): string {
  return `https://${user}:${password}@${hostAndPath}`;
}

it("accepts only typed redacted credential diagnostics", () => {
  const diagnostic = {
    code: "CREDENTIAL_FILE_UNAVAILABLE",
    path: "channels.telegram.tokenFile",
    reason: "not-found",
  };
  expect(
    getCredentialUnavailableDiagnostics({
      credentialDiagnostics: [
        diagnostic,
        { code: "OTHER", path: "ignored", reason: "ignored" },
        { code: "CREDENTIAL_FILE_UNAVAILABLE", path: "", reason: "not-found" },
      ],
    }),
  ).toEqual([diagnostic]);
});

it("preserves diagnostic identity and audience metadata without raw credentials", () => {
  const safeFields = {
    name: "Primary",
    tokenSource: "config",
    tokenStatus: "configured_unavailable",
    signingSecretSource: "config", // pragma: allowlist secret
    signingSecretStatus: "configured_unavailable", // pragma: allowlist secret
    webhookPath: "/webhook",
    audienceType: "project-number",
    audience: "1234567890",
    identity: "user",
    userTokenSource: "config",
    credentialSource: "serviceAccount",
    secretSource: "env",
    apiCredentialStatus: "configured_unavailable",
  };
  const snapshot = projectSafeChannelAccountSnapshotFields({
    ...safeFields,
    webhookUrl: "https://example.com/webhook",
    botToken: "must-not-leak",
    publicKey: "pk_live_123",
  });

  expect(snapshot).toEqual(safeFields);
});

it("redacts URL-shaped audiences while omitting bearer webhook URLs", () => {
  expect(
    projectSafeChannelAccountSnapshotFields({
      audience: credentialUrl("user", "password", "example.test/path?token=private"),
      webhookUrl: "https://example.test/webhooks/id/bearer-token",
    }),
  ).toEqual({ audience: "https://example.test/path?token=***" });
});

it("redacts query, nested URL, and fragment credentials from baseUrl fields", () => {
  const nested = encodeURIComponent(
    credentialUrl("nested-user", "nested-pass", "nested.example/cb?access_token=nested-token"),
  );
  const snapshot = projectSafeChannelAccountSnapshotFields({
    baseUrl: credentialUrl(
      "outer-user",
      "outer-pass",
      `chat.example.test/?token=outer-token&next=${nested}#auth_token=fragment-token`,
    ),
  });

  expect(snapshot.baseUrl).not.toMatch(
    /outer-(user|pass|token)|nested-(user|pass|token)|fragment-token/,
  );
  expect(snapshot.baseUrl).toContain("token=***");
});

it("redacts plugin snapshots without mutating raw account state", () => {
  const rawBaseUrl = credentialUrl("user", "pass", "chat.example.test/?token=secret");
  const account = Object.freeze({ baseUrl: rawBaseUrl });
  const snapshot = { ...account };

  const redacted = redactChannelStatusSummaryBaseUrl(snapshot);

  expect(redacted).toEqual({ baseUrl: "https://chat.example.test/?token=***" });
  expect(account.baseUrl).toBe(rawBaseUrl);
  expect(snapshot.baseUrl).toBe(rawBaseUrl);
});

it("retains object identity when a plugin snapshot baseUrl is already safe", () => {
  const snapshot = { baseUrl: "https://chat.example.test/?keep=visible" };
  expect(redactChannelStatusSummaryBaseUrl(snapshot)).toBe(snapshot);
});

it("preserves non-secret transport liveness timestamps", () => {
  const safeFields = {
    connected: true,
    lastConnectedAt: 123,
    lastInboundAt: 123,
    lastOutboundAt: 234,
    lastMessageAt: null,
    lastEventAt: 345,
    lastTransportActivityAt: 456,
  };
  const snapshot = projectSafeChannelAccountSnapshotFields({
    ...safeFields,
    channelAccessToken: "line-token",
    channelSecret: "line-secret", // pragma: allowlist secret
    probe: { ok: true, token: "probe-secret" },
  });

  expect(snapshot).toEqual(safeFields);
});

it.each([
  {
    input: [" alice ", 42, true, null, {}, ""],
    expected: { allowFrom: ["alice", "42"] },
  },
  { input: [" ", {}, false], expected: {} },
  { input: "alice", expected: {} },
])("projects supported allowFrom entries from $input", ({ input, expected }) => {
  expect(projectSafeChannelAccountSnapshotFields({ allowFrom: input })).toEqual(expected);
});

it("projects recorded lifecycle alongside channel-authored healthState", () => {
  expect(
    projectSafeChannelAccountSnapshotFields({ lifecycle: "blocked", healthState: "degraded" }),
  ).toEqual({ healthState: "degraded", lifecycle: "blocked" });
  expect(projectSafeChannelAccountSnapshotFields({ lifecycle: "unknown" })).toEqual({});
});
