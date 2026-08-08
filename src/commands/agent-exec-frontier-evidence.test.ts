import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureAuthProfileStore } from "../agents/auth-profiles.js";
import {
  deriveFrontierEvidencePromptCacheKey,
  getFrontierEvidenceExpectedAuthProfileId,
  getFrontierEvidencePolicy,
} from "../agents/frontier-evidence-policy.js";
import type { RuntimeEnv } from "../runtime.js";
import { resolveFrontierEvidenceExecution } from "./agent-exec-frontier-evidence.js";
import { agentExecCommand, resolveExecBaseConfigResolution } from "./agent-exec.js";

const tempRoots: string[] = [];

async function makeTempRoot(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function createRuntime(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  };
}

function successResult() {
  return {
    payloads: [{ text: "done" }],
    meta: {
      durationMs: 25,
      finalAssistantVisibleText: "done",
      agentMeta: {
        sessionId: "session-result",
        provider: "openai",
        model: "gpt-5.4",
        usage: { input: 10, output: 2, total: 12 },
      },
    },
  };
}

async function writeFrontierEvidenceFixture(params: {
  credentialEnvName: string;
  profileId: string;
}): Promise<{
  configPath: string;
  policyPath: string;
  policySha256: string;
}> {
  const root = await makeTempRoot("openclaw-frontier-evidence-");
  const configPath = path.join(root, "openclaw.json5");
  const config = `{
    agents: {
      defaults: {
        model: { primary: "openai/gpt-5.4@${params.profileId}", fallbacks: [] },
        models: {
          "openai/gpt-5.4": { agentRuntime: { id: "openclaw" } },
        },
      },
    },
    auth: {
      profiles: {
        "${params.profileId}": { provider: "openai", mode: "api_key" },
      },
    },
  }\n`;
  await fs.writeFile(configPath, config, "utf8");
  const policy = {
    version: 1,
    configSha256: createHash("sha256").update(config).digest("hex"),
    defaultAgentId: "main",
    provider: "openai",
    model: "gpt-5.4",
    api: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    runtime: "openclaw",
    authBindingId: "c".repeat(32),
    contentDigestKey: "d".repeat(64),
    credentialState: "frozen_in_memory",
    credentialEnvName: params.credentialEnvName,
    fallbacks: "disabled",
    proxy: "disabled",
    tls: "default",
    localService: "disabled",
    endpoint: {
      origin: "https://api.openai.com",
      pathname: "/v1/responses",
      method: "POST",
      transport: "responses-sdk",
    },
    thinking: "high",
    seed: "absent",
    authoredRequestParams: "absent",
    maxLogicalCalls: 64,
    expectedReasoning: { effort: "high", summary: "auto" },
    expectedInclude: ["reasoning.encrypted_content"],
    expectedMetadata: {
      source: "openai_transport_turn_state",
      keys: [
        "openclaw_session_id",
        "openclaw_transport",
        "openclaw_turn_attempt",
        "openclaw_turn_id",
      ],
      valueClass: "volatile_execution_metadata",
    },
    expectedToolChoice: "absent",
    expectedPromptCacheKey: "session_boundary",
    expectedPromptCacheRetention: "absent",
    expectedMaxRetries: 2,
  };
  const rawPolicy = `${JSON.stringify(policy)}\n`;
  const policyPath = path.join(root, "policy.json");
  await fs.writeFile(policyPath, rawPolicy, { encoding: "utf8", mode: 0o600 });
  await fs.chmod(policyPath, 0o600);
  return {
    configPath,
    policyPath,
    policySha256: createHash("sha256").update(rawPolicy).digest("hex"),
  };
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
  vi.restoreAllMocks();
});

describe("agent exec frontier evidence admission", () => {
  it("uses the admitted credential from the in-memory frontier snapshot", async () => {
    const credentialEnvName = "OPENAI_API_KEY";
    const previousCredential = process.env[credentialEnvName];
    process.env[credentialEnvName] = "sk-admitted";
    const fixture = await writeFrontierEvidenceFixture({
      credentialEnvName,
      profileId: "openai:matrix",
    });
    let observedCredential: unknown;
    let observedExpectedProfileId: string | undefined;
    let observedPolicySha256: string | undefined;
    let observedPromptCacheKey: unknown;
    try {
      const result = await agentExecCommand(
        "inspect",
        {
          config: fixture.configPath,
          frontierEvidencePolicy: fixture.policyPath,
          frontierEvidencePolicySha256: fixture.policySha256,
          frontierEvidenceRunNonce: "1".repeat(64),
          thinking: "high",
        },
        createRuntime(),
        {
          runAgent: vi.fn(async (opts) => {
            process.env[credentialEnvName] = "sk-mutated-after-admission";
            observedCredential = ensureAuthProfileStore().profiles["openai:matrix"];
            observedExpectedProfileId = getFrontierEvidenceExpectedAuthProfileId();
            observedPolicySha256 = getFrontierEvidencePolicy()?.policySha256;
            observedPromptCacheKey = opts.promptCacheKey;
            return successResult();
          }),
        },
      );
      expect(result.exitCode).toBe(0);
    } finally {
      if (previousCredential === undefined) {
        delete process.env[credentialEnvName];
      } else {
        process.env[credentialEnvName] = previousCredential;
      }
    }

    expect(observedCredential).toMatchObject({
      type: "api_key",
      provider: "openai",
      key: "sk-admitted",
    });
    expect(observedExpectedProfileId).toBe("openai:matrix");
    expect(observedPolicySha256).toBe(fixture.policySha256);
    expect(observedPromptCacheKey).toBe(
      deriveFrontierEvidencePromptCacheKey("d".repeat(64), "1".repeat(64)),
    );
    expect(getFrontierEvidencePolicy()).toBeUndefined();
    expect(getFrontierEvidenceExpectedAuthProfileId()).toBeUndefined();
  });

  it("rejects missing, orphaned, or malformed run nonces before policy admission", async () => {
    await expect(
      resolveFrontierEvidenceExecution({
        baseConfig: {},
        opts: { frontierEvidenceRunNonce: "1".repeat(64) },
      }),
    ).rejects.toThrow("run nonce requires a frontier evidence policy");
    await expect(
      resolveFrontierEvidenceExecution({
        baseConfig: {},
        opts: {
          config: "config.json5",
          frontierEvidencePolicy: "policy.json",
          frontierEvidencePolicySha256: "a".repeat(64),
        },
      }),
    ).rejects.toThrow("requires a pinned config, path, SHA-256, and run nonce");
    await expect(
      resolveFrontierEvidenceExecution({
        baseConfig: {},
        opts: {
          config: "config.json5",
          frontierEvidencePolicy: "policy.json",
          frontierEvidencePolicySha256: "a".repeat(64),
          frontierEvidenceRunNonce: "ABC",
        },
      }),
    ).rejects.toThrow("must be 64 lowercase hex characters");
    expect(deriveFrontierEvidencePromptCacheKey("d".repeat(64), "1".repeat(64))).not.toBe(
      deriveFrontierEvidencePromptCacheKey("d".repeat(64), "2".repeat(64)),
    );
  });

  it("rejects a mismatched frontier policy digest before the agent runs", async () => {
    const credentialEnvName = "OPENAI_API_KEY";
    const previousCredential = process.env[credentialEnvName];
    process.env[credentialEnvName] = "sk-admitted";
    const fixture = await writeFrontierEvidenceFixture({
      credentialEnvName,
      profileId: "openai:matrix",
    });
    const runAgent = vi.fn(async () => successResult());
    try {
      const result = await agentExecCommand(
        "inspect",
        {
          config: fixture.configPath,
          frontierEvidencePolicy: fixture.policyPath,
          frontierEvidencePolicySha256: "0".repeat(64),
          frontierEvidenceRunNonce: "1".repeat(64),
          thinking: "high",
        },
        createRuntime(),
        { runAgent },
      );
      expect(result).toMatchObject({
        exitCode: 1,
        envelope: {
          error: {
            kind: "exception",
            message: "frontier evidence policy SHA-256 mismatch",
          },
        },
      });
    } finally {
      if (previousCredential === undefined) {
        delete process.env[credentialEnvName];
      } else {
        process.env[credentialEnvName] = previousCredential;
      }
    }
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("binds frontier admission to the exact config bytes used for execution", async () => {
    const credentialEnvName = "OPENAI_API_KEY";
    const previousCredential = process.env[credentialEnvName];
    process.env[credentialEnvName] = "sk-admitted";
    const fixture = await writeFrontierEvidenceFixture({
      credentialEnvName,
      profileId: "openai:matrix",
    });
    const resolution = await resolveExecBaseConfigResolution({ config: fixture.configPath });
    const configA = await fs.readFile(fixture.configPath, "utf8");
    const configB = `${configA.trimEnd()}\n// swapped after the execution snapshot\n`;
    const policy = JSON.parse(await fs.readFile(fixture.policyPath, "utf8")) as {
      configSha256: string;
    };
    policy.configSha256 = createHash("sha256").update(configB).digest("hex");
    const policyRaw = `${JSON.stringify(policy)}\n`;
    await fs.writeFile(fixture.policyPath, policyRaw, { encoding: "utf8", mode: 0o600 });
    const policySha256 = createHash("sha256").update(policyRaw).digest("hex");
    await fs.writeFile(fixture.configPath, configB, "utf8");
    try {
      await expect(
        resolveFrontierEvidenceExecution({
          baseConfig: resolution.config,
          configSnapshot: resolution.pinnedSnapshot,
          opts: {
            config: fixture.configPath,
            frontierEvidencePolicy: fixture.policyPath,
            frontierEvidencePolicySha256: policySha256,
            frontierEvidenceRunNonce: "1".repeat(64),
            thinking: "high",
          },
        }),
      ).rejects.toThrow("frontier evidence config SHA-256 mismatch");
    } finally {
      if (previousCredential === undefined) {
        delete process.env[credentialEnvName];
      } else {
        process.env[credentialEnvName] = previousCredential;
      }
    }
    expect(resolution.pinnedSnapshot?.sha256).toBe(
      createHash("sha256").update(configA).digest("hex"),
    );
  });

  it("rejects included config because the root digest cannot freeze child files", async () => {
    const root = await makeTempRoot("openclaw-frontier-include-");
    const configPath = path.join(root, "openclaw.json5");
    await fs.writeFile(path.join(root, "model.json5"), "{ agents: {} }\n", "utf8");
    await fs.writeFile(configPath, '{ $include: "./model.json5" }\n', "utf8");

    await expect(
      resolveExecBaseConfigResolution({
        config: configPath,
        frontierEvidencePolicy: path.join(root, "policy.json"),
      }),
    ).rejects.toThrow("frontier evidence pinned config cannot use $include");
  });

  it("rejects a thinking-level downgrade before the agent runs", async () => {
    const credentialEnvName = "OPENAI_API_KEY";
    const previousCredential = process.env[credentialEnvName];
    process.env[credentialEnvName] = "sk-admitted";
    const fixture = await writeFrontierEvidenceFixture({
      credentialEnvName,
      profileId: "openai:matrix",
    });
    const runAgent = vi.fn(async () => successResult());
    try {
      const result = await agentExecCommand(
        "inspect",
        {
          config: fixture.configPath,
          frontierEvidencePolicy: fixture.policyPath,
          frontierEvidencePolicySha256: fixture.policySha256,
          frontierEvidenceRunNonce: "1".repeat(64),
          thinking: "medium",
        },
        createRuntime(),
        { runAgent },
      );
      expect(result).toMatchObject({
        exitCode: 1,
        envelope: {
          error: {
            kind: "exception",
            message: "frontier evidence thinking level mismatch",
          },
        },
      });
    } finally {
      if (previousCredential === undefined) {
        delete process.env[credentialEnvName];
      } else {
        process.env[credentialEnvName] = previousCredential;
      }
    }
    expect(runAgent).not.toHaveBeenCalled();
  });
});
