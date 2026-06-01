import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  evaluateSecretAwareExecCommand,
  parseExactEchoHeadCommand,
  resetPlatformSecretMetadataCacheForTests,
  validateResolveEnvelope,
  type CandidateMetadata,
  type PlatformSecretsRuntimeClient,
  type ResolveEnvelope,
} from "./platform-runtime.js";

function client(params: {
  metadata?: CandidateMetadata;
  envelope?: ResolveEnvelope;
}): PlatformSecretsRuntimeClient {
  return {
    candidateMetadata: vi.fn(async () => params.metadata ?? { known: {}, unknown: [] }),
    resolve: vi.fn(async () => params.envelope ?? { resolved: {}, categories: {}, missing: [] }),
  };
}

describe("platform runtime secrets", () => {
  beforeEach(() => {
    resetPlatformSecretMetadataCacheForTests();
  });

  it("parses only the exact echo/head form", () => {
    expect(parseExactEchoHeadCommand(" echo   $DEPLOY_KEY | head -c 4 ")).toEqual({
      name: "DEPLOY_KEY",
      count: 4,
    });
    expect(parseExactEchoHeadCommand(" echo   ${DEPLOY_KEY} | head -c 4 ")).toEqual({
      name: "DEPLOY_KEY",
      count: 4,
    });
    for (const command of [
      "echo '$DEPLOY_KEY' | head -c 4",
      "FOO=1 echo $DEPLOY_KEY | head -c 4",
      "echo $DEPLOY_KEY | head -c 0",
      "echo $DEPLOY_KEY | head -c 65",
      "echo $deploy_key | head -c 4",
      "echo $DEPLOY_KEY | head -c 4 | cat",
      "echo $DEPLOY_KEY | head -c 4 > out",
    ]) {
      expect(parseExactEchoHeadCommand(command), command).toBeNull();
    }
  });

  it("treats HOME and PATH as ordinary when metadata says they are unknown", async () => {
    const result = await evaluateSecretAwareExecCommand({
      command: "echo $HOME && echo $PATH",
      env: { ROCKIELAB_TENANT_ID: "tenant-a" },
      client: client({ metadata: { known: {}, unknown: ["HOME", "PATH"] } }),
    });
    expect(result).toEqual({ action: "pass" });
  });

  it("treats ordinary env references as non-secret when tenant runtime identity is absent", async () => {
    const result = await evaluateSecretAwareExecCommand({
      command: "echo $PATH && echo $FOO",
      env: {},
      client: client({ metadata: { known: { FOO: { category: "token" } }, unknown: ["PATH"] } }),
    });
    expect(result).toEqual({ action: "pass" });
  });

  it("handles exact secret form without disclosing prefix bytes", async () => {
    const secret = "CANARY_SECRET_VALUE_abcdef";
    const runtimeClient = client({
      metadata: { known: { DEPLOY_KEY: { category: "ssh_key" } }, unknown: [] },
      envelope: {
        resolved: { DEPLOY_KEY: secret },
        categories: { DEPLOY_KEY: "ssh_key" },
        missing: [],
      },
    });
    const result = await evaluateSecretAwareExecCommand({
      command: "echo $DEPLOY_KEY | head -c 17",
      env: { ROCKIELAB_TENANT_ID: "tenant-a" },
      client: runtimeClient,
    });
    expect(result.action).toBe("handled");
    if (result.action !== "handled") {
      return;
    }
    expect(result.text).toBe("<redacted:DEPLOY_KEY>");
    expect(result.text).not.toContain(secret);
    expect(result.text).not.toContain(secret.slice(0, 17));
    expect(result.details).toMatchObject({
      accepted: true,
      name: "DEPLOY_KEY",
      requestedCount: 17,
    });
  });

  it("resolves confirmed secrets for gateway env injection", async () => {
    const result = await evaluateSecretAwareExecCommand({
      command: `mkdir -p ~/.ssh && printf '%s' "$DEPLOY_KEY" > ~/.ssh/deploy_key`,
      env: { ROCKIELAB_TENANT_ID: "tenant-a" },
      client: client({
        metadata: { known: { DEPLOY_KEY: { category: "ssh_key" } }, unknown: [] },
        envelope: {
          resolved: { DEPLOY_KEY: "CANARY_SECRET_VALUE_abcdef" },
          categories: { DEPLOY_KEY: "ssh_key" },
          missing: [],
        },
      }),
      allowEnvInjection: true,
    });
    expect(result.action).toBe("inject");
    if (result.action !== "inject") {
      return;
    }
    expect(result.env).toEqual({ DEPLOY_KEY: "CANARY_SECRET_VALUE_abcdef" });
    expect(result.redactor.redact("CANARY_SECRET_VALUE_abcdef")).toBe("<redacted:DEPLOY_KEY>");
  });

  it("rejects non-exact use of confirmed secrets when env injection is not allowed", async () => {
    const result = await evaluateSecretAwareExecCommand({
      command: "printf %s $DEPLOY_KEY",
      env: { ROCKIELAB_TENANT_ID: "tenant-a" },
      client: client({
        metadata: { known: { DEPLOY_KEY: { category: "ssh_key" } }, unknown: [] },
      }),
    });
    expect(result).toMatchObject({ action: "reject" });
  });

  it("fails closed without ROCKIELAB_TENANT_ID and ignores token fallbacks as identity", async () => {
    const result = await evaluateSecretAwareExecCommand({
      command: "echo $DEPLOY_KEY | head -c 17",
      env: {
        ROCKIELAB_TENANT_TOKEN: "legacy-token",
        BROKER_TENANT_TOKEN: "broker-token",
      },
      client: client({
        metadata: { known: { DEPLOY_KEY: { category: "ssh_key" } }, unknown: [] },
      }),
    });
    expect(result).toEqual({
      action: "reject",
      reason: "ROCKIELAB_TENANT_ID is required.",
    });
  });

  it("validates resolve v2 exact-set envelopes before materialization", () => {
    expect(() =>
      validateResolveEnvelope({
        requested: ["DEPLOY_KEY"],
        metadata: { DEPLOY_KEY: "ssh_key" },
        envelope: {
          resolved: { DEPLOY_KEY: "secret" },
          categories: { DEPLOY_KEY: "ssh_key" },
          missing: [],
        },
      }),
    ).not.toThrow();
    const invalidEnvelopes: ResolveEnvelope[] = [
      {
        resolved: { DEPLOY_KEY: "secret", EXTRA: "x" },
        categories: { DEPLOY_KEY: "ssh_key", EXTRA: "token" },
        missing: [],
      },
      { resolved: {}, categories: {}, missing: ["DEPLOY_KEY"] },
      {
        resolved: { DEPLOY_KEY: "secret" },
        categories: { DEPLOY_KEY: "token" },
        missing: [],
      },
      { resolved: { DEPLOY_KEY: "secret" }, categories: {}, missing: [] },
      {
        resolved: { DEPLOY_KEY: "secret" },
        categories: { DEPLOY_KEY: "ssh_key" },
        missing: ["DEPLOY_KEY"],
      },
    ];
    for (const envelope of invalidEnvelopes) {
      expect(() =>
        validateResolveEnvelope({
          requested: ["DEPLOY_KEY"],
          metadata: { DEPLOY_KEY: "ssh_key" },
          envelope,
        }),
      ).toThrow();
    }
  });
});
