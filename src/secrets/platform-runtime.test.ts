import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MATERIALIZE_ONLY_SECRET_RESOLUTION_MESSAGE,
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
}): PlatformSecretsRuntimeClient & {
  candidateMetadata: ReturnType<typeof vi.fn>;
  resolve: ReturnType<typeof vi.fn>;
} {
  return {
    candidateMetadata: vi.fn(async () => params.metadata ?? { known: {}, unknown: [] }),
    resolve: vi.fn(async () => params.envelope ?? { resolved: {}, categories: {}, missing: [] }),
  };
}

describe("platform runtime secrets", () => {
  beforeEach(() => {
    resetPlatformSecretMetadataCacheForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
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

  it("rejects exact echo/head for known tenant secrets without resolving plaintext", async () => {
    const runtimeClient = client({
      metadata: { known: { DEPLOY_KEY: { category: "ssh_key" } }, unknown: [] },
    });
    const result = await evaluateSecretAwareExecCommand({
      command: "echo $DEPLOY_KEY | head -c 17",
      env: { ROCKIELAB_TENANT_ID: "tenant-a" },
      client: runtimeClient,
    });
    expect(result).toEqual({
      action: "reject",
      reason: MATERIALIZE_ONLY_SECRET_RESOLUTION_MESSAGE,
    });
    expect(runtimeClient.candidateMetadata).toHaveBeenCalledWith(["DEPLOY_KEY"], "tenant-a");
    expect(runtimeClient.resolve).not.toHaveBeenCalled();
  });

  it("rejects confirmed secrets for exec env without resolving plaintext", async () => {
    const runtimeClient = client({
      metadata: { known: { DEPLOY_KEY: { category: "ssh_key" } }, unknown: [] },
    });
    const result = await evaluateSecretAwareExecCommand({
      command: `mkdir -p ~/.ssh && printf '%s' "$DEPLOY_KEY" > ~/.ssh/deploy_key`,
      env: { ROCKIELAB_TENANT_ID: "tenant-a" },
      client: runtimeClient,
    });
    expect(result).toEqual({
      action: "reject",
      reason: MATERIALIZE_ONLY_SECRET_RESOLUTION_MESSAGE,
    });
    expect(runtimeClient.resolve).not.toHaveBeenCalled();
  });

  it("rejects non-exact use of confirmed secrets with the materialize-only message", async () => {
    const runtimeClient = client({
      metadata: { known: { DEPLOY_KEY: { category: "ssh_key" } }, unknown: [] },
    });
    const result = await evaluateSecretAwareExecCommand({
      command: "printf %s $DEPLOY_KEY",
      env: { ROCKIELAB_TENANT_ID: "tenant-a" },
      client: runtimeClient,
    });
    expect(result).toEqual({
      action: "reject",
      reason: MATERIALIZE_ONLY_SECRET_RESOLUTION_MESSAGE,
    });
    expect(runtimeClient.resolve).not.toHaveBeenCalled();
  });

  it("does not call /api/secrets/resolve for non-materialize exec paths", async () => {
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.endsWith("/api/secrets/metadata")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            known: { DEPLOY_KEY: { category: "ssh_key" } },
            unknown: [],
          }),
        } as Response;
      }
      if (url.endsWith("/api/secrets/resolve")) {
        throw new Error("exec path must not resolve plaintext secrets");
      }
      throw new Error(`unexpected URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    for (const command of ["printf %s $DEPLOY_KEY", "echo $DEPLOY_KEY | head -c 17"]) {
      resetPlatformSecretMetadataCacheForTests();
      await expect(
        evaluateSecretAwareExecCommand({
          command,
          env: {
            ROCKIELAB_TENANT_ID: "tenant-a",
            BROKER_TENANT_TOKEN: "broker-token",
          },
        }),
      ).resolves.toEqual({
        action: "reject",
        reason: MATERIALIZE_ONLY_SECRET_RESOLUTION_MESSAGE,
      });
    }
    const resolveCalls = fetchMock.mock.calls.filter(([input]) =>
      String(input).endsWith("/api/secrets/resolve"),
    );
    expect(resolveCalls).toHaveLength(0);
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
