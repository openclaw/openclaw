import { describe, expect, it } from "vitest";
import {
  hasConfiguredUnavailableCredentialStatus,
  hasResolvedCredentialValue,
  projectCredentialSnapshotFields,
  projectSafeChannelAccountSnapshotFields,
  resolveConfiguredFromCredentialStatuses,
  resolveConfiguredFromRequiredCredentialStatuses,
} from "./account-snapshot-fields.js";

describe("projectSafeChannelAccountSnapshotFields", () => {
  it("omits webhook and public-key style fields from generic snapshots", () => {
    const snapshot = projectSafeChannelAccountSnapshotFields({
      name: "Primary",
      tokenSource: "config",
      tokenStatus: "configured_unavailable",
      signingSecretSource: "config", // pragma: allowlist secret
      signingSecretStatus: "configured_unavailable", // pragma: allowlist secret
      webhookUrl: "https://example.com/webhook",
      webhookPath: "/webhook",
      audienceType: "project-number",
      audience: "1234567890",
      publicKey: "pk_live_123", // pragma: allowlist secret
    });

    expect(snapshot).toEqual({
      name: "Primary",
      tokenSource: "config",
      tokenStatus: "configured_unavailable",
      signingSecretSource: "config", // pragma: allowlist secret
      signingSecretStatus: "configured_unavailable", // pragma: allowlist secret
    });
  });

  it("returns empty object for null or non-object input", () => {
    expect(projectSafeChannelAccountSnapshotFields(null)).toEqual({});
    expect(projectSafeChannelAccountSnapshotFields(undefined)).toEqual({});
    expect(projectSafeChannelAccountSnapshotFields("string")).toEqual({});
    expect(projectSafeChannelAccountSnapshotFields([])).toEqual({});
  });

  it("includes numeric and boolean fields when present", () => {
    const snapshot = projectSafeChannelAccountSnapshotFields({
      linked: true,
      running: false,
      connected: true,
      reconnectAttempts: 3,
      port: 8080,
      allowUnmentionedGroups: false,
    });
    expect(snapshot.linked).toBe(true);
    expect(snapshot.running).toBe(false);
    expect(snapshot.connected).toBe(true);
    expect(snapshot.reconnectAttempts).toBe(3);
    expect(snapshot.port).toBe(8080);
    expect(snapshot.allowUnmentionedGroups).toBe(false);
  });

  it("normalizes allowFrom to non-empty trimmed strings only", () => {
    const snapshot = projectSafeChannelAccountSnapshotFields({
      allowFrom: ["  valid  ", "", 42, null, "another"],
    });
    expect(snapshot.allowFrom).toEqual(["valid", "42", "another"]);
  });

  it("omits fields with empty or whitespace-only string values", () => {
    const snapshot = projectSafeChannelAccountSnapshotFields({
      name: "   ",
      mode: "",
      dmPolicy: " ",
    });
    expect(snapshot).not.toHaveProperty("name");
    expect(snapshot).not.toHaveProperty("mode");
    expect(snapshot).not.toHaveProperty("dmPolicy");
  });
});

describe("resolveConfiguredFromCredentialStatuses", () => {
  it("returns undefined for null or non-object input", () => {
    expect(resolveConfiguredFromCredentialStatuses(null)).toBeUndefined();
    expect(resolveConfiguredFromCredentialStatuses("x")).toBeUndefined();
  });

  it("returns undefined when no recognized credential status keys are present", () => {
    expect(resolveConfiguredFromCredentialStatuses({ other: "value" })).toBeUndefined();
  });

  it("returns false when all credential statuses are missing", () => {
    expect(resolveConfiguredFromCredentialStatuses({ tokenStatus: "missing" })).toBe(false);
  });

  it("returns true when any credential status is not missing", () => {
    expect(resolveConfiguredFromCredentialStatuses({ tokenStatus: "available" })).toBe(true);
    expect(
      resolveConfiguredFromCredentialStatuses({ botTokenStatus: "configured_unavailable" }),
    ).toBe(true);
  });
});

describe("resolveConfiguredFromRequiredCredentialStatuses", () => {
  it("returns undefined when none of the required keys are present", () => {
    expect(resolveConfiguredFromRequiredCredentialStatuses({}, ["tokenStatus"])).toBeUndefined();
  });

  it("returns false when a required key is missing", () => {
    expect(
      resolveConfiguredFromRequiredCredentialStatuses({ tokenStatus: "missing" }, ["tokenStatus"]),
    ).toBe(false);
  });

  it("returns true when required keys are configured or available", () => {
    expect(
      resolveConfiguredFromRequiredCredentialStatuses(
        { botTokenStatus: "available", signingSecretStatus: "configured_unavailable" }, // pragma: allowlist secret
        ["botTokenStatus", "signingSecretStatus"],
      ),
    ).toBe(true);
  });
});

describe("hasConfiguredUnavailableCredentialStatus", () => {
  it("returns false for null input", () => {
    expect(hasConfiguredUnavailableCredentialStatus(null)).toBe(false);
  });

  it("returns false when no credential status is configured_unavailable", () => {
    expect(hasConfiguredUnavailableCredentialStatus({ tokenStatus: "available" })).toBe(false);
  });

  it("returns true when any credential status is configured_unavailable", () => {
    expect(
      hasConfiguredUnavailableCredentialStatus({ appTokenStatus: "configured_unavailable" }),
    ).toBe(true);
  });
});

describe("hasResolvedCredentialValue", () => {
  it("returns false for null input", () => {
    expect(hasResolvedCredentialValue(null)).toBe(false);
  });

  it("returns false when no token or available status is present", () => {
    expect(hasResolvedCredentialValue({ tokenStatus: "missing" })).toBe(false);
    expect(hasResolvedCredentialValue({ token: "   " })).toBe(false);
  });

  it("returns true when a token string is non-empty", () => {
    expect(hasResolvedCredentialValue({ token: "tok-123" })).toBe(true);
    expect(hasResolvedCredentialValue({ botToken: "xoxb-1" })).toBe(true);
  });

  it("returns true when any credential status is available", () => {
    expect(hasResolvedCredentialValue({ userTokenStatus: "available" })).toBe(true);
  });
});

describe("projectCredentialSnapshotFields", () => {
  it("returns empty object for non-object input", () => {
    expect(projectCredentialSnapshotFields(null)).toEqual({});
  });

  it("includes only recognized source and status fields", () => {
    const result = projectCredentialSnapshotFields({
      tokenSource: "config",
      botTokenSource: "env",
      appTokenSource: "config",
      signingSecretSource: "config", // pragma: allowlist secret
      tokenStatus: "available",
      botTokenStatus: "missing",
      appTokenStatus: "configured_unavailable",
      signingSecretStatus: "available", // pragma: allowlist secret
      userTokenStatus: "missing",
      webhookUrl: "https://example.com",
    });
    expect(result).toEqual({
      tokenSource: "config",
      botTokenSource: "env",
      appTokenSource: "config",
      signingSecretSource: "config", // pragma: allowlist secret
      tokenStatus: "available",
      botTokenStatus: "missing",
      appTokenStatus: "configured_unavailable",
      signingSecretStatus: "available", // pragma: allowlist secret
      userTokenStatus: "missing",
    });
    expect(result).not.toHaveProperty("webhookUrl");
  });

  it("omits status fields with unrecognized values", () => {
    const result = projectCredentialSnapshotFields({ tokenStatus: "unknown-value" });
    expect(result).not.toHaveProperty("tokenStatus");
  });
});
