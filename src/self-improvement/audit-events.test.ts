import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendSelfImprovementAuditEvent,
  appendSelfImprovementModelPreflightAuditEvent,
  listSelfImprovementAuditEvents,
  resolveSelfImprovementAuditEventStorePath,
} from "./audit-events.js";

let tmpDir: string;

describe("self-improvement audit events", () => {
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-self-improvement-audit-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("redacts summaries and metadata before durable writes", async () => {
    await appendSelfImprovementAuditEvent({
      stateDir: tmpDir,
      event: {
        actor: "gateway",
        kind: "analysis_run",
        targetId: "/Users/openclaw/openclaw/.state/self-improvement",
        summary: "Analyzed /Users/openclaw/openclaw with token=abcdefghijklmnopqrstuvwxyz123456",
        metadata: {
          proofPath: "/private/tmp/openclaw-proof.json",
          token: "abcdefghijklmnopqrstuvwxyz123456",
          modelId: "ollama/qwen3.6:27b-q8_0",
          attempts: 2,
          ready: true,
          evidence: ["Read ~/openclaw/secrets.txt", "Retained /opt/homebrew/bin/node output"],
        },
      },
    });

    const storePath = resolveSelfImprovementAuditEventStorePath(tmpDir);
    const raw = await fs.readFile(storePath, "utf8");
    expect(raw).not.toContain("/Users/openclaw");
    expect(raw).not.toContain("/private/tmp");
    expect(raw).not.toContain("~/openclaw");
    expect(raw).not.toContain("/opt/homebrew");
    expect(raw).not.toContain("abcdefghijklmnopqrstuvwxyz123456");

    const [event] = await listSelfImprovementAuditEvents({ stateDir: tmpDir });
    expect(event?.targetId).toContain("[local-path]");
    expect(event?.summary).toContain("[local-path]");
    expect(event?.metadata).toMatchObject({
      proofPath: "[local-path]",
      modelId: "ollama/qwen3.6:27b-q8_0",
      attempts: 2,
      ready: true,
    });
    expect(String(event?.metadata?.token)).not.toContain("abcdefghijklmnopqrstuvwxyz123456");
    expect(event?.metadata?.evidence).toEqual([
      "Read [local-path]",
      "Retained [local-path] output",
    ]);
  });

  it("sanitizes old audit records on read without rewriting the store", async () => {
    const storePath = resolveSelfImprovementAuditEventStorePath(tmpDir);
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(
      storePath,
      JSON.stringify(
        {
          version: 1,
          events: [
            {
              id: "sie_old",
              createdAt: Date.parse("2026-05-07T12:00:00.000Z"),
              actor: "governor",
              kind: "analysis_run",
              targetId: "self-improvement",
              summary: "Fallback reason included /var/tmp/openclaw.log",
              metadata: {
                fallbackReason:
                  "Local model preflight read /Users/openclaw/.openclaw/openclaw.json",
                secretValue: "sk-testsecretabcdefghijklmnopqrstuvwxyz",
                ignoredObject: { nested: "/Users/openclaw/secret" },
              },
            },
          ],
        },
        null,
        2,
      ),
    );

    const [event] = await listSelfImprovementAuditEvents({ stateDir: tmpDir });
    expect(event?.summary).toContain("[local-path]");
    expect(event?.metadata?.fallbackReason).toContain("[local-path]");
    expect(String(event?.metadata?.secretValue)).not.toContain(
      "sk-testsecretabcdefghijklmnopqrstuvwxyz",
    );
    expect(event?.metadata).not.toHaveProperty("ignoredObject");
    expect(JSON.stringify(event)).not.toContain("/Users/openclaw");
    expect(JSON.stringify(event)).not.toContain("/var/tmp");
    expect(JSON.stringify(event)).not.toContain("sk-testsecretabcdefghijklmnopqrstuvwxyz");
  });

  it("records sanitized model preflight audit events without model output", async () => {
    const event = await appendSelfImprovementModelPreflightAuditEvent({
      stateDir: tmpDir,
      result: {
        checkedAt: Date.parse("2026-05-07T12:00:00.000Z"),
        ready: true,
        readiness: "degraded",
        readyTier: "crossCheck",
        readyModelId: "ollama/openclaw-control-qwen3-30b-q6-chatfix:latest",
        reviewPolicy: "local_first",
        reviewModelId: "ollama/qwen3.6:27b-q8_0",
        fallbackModelId: "ollama/openclaw-control-qwen3-30b-q6-chatfix:latest",
        strategicModelId: "ollama/openclaw-strategic-qwen3-235b:latest",
        localFirst: true,
        hostedEscalationAllowed: false,
        strategicLocalAllowed: false,
        strategicRequested: false,
        attempts: [
          {
            attempt: 1,
            tier: "primaryReview",
            modelId: "ollama/qwen3.6:27b-q8_0",
            status: "blocked",
            local: true,
            schemaValidated: false,
            groupsReviewed: 0,
            preflightStatus: "missing_config",
            providerConfigured: false,
            preflightMs: 1,
            error:
              "Local model preflight read /Users/openclaw/.openclaw/openclaw.json with token=abcdefghijklmnopqrstuvwxyz123456",
            remediationHint:
              "Register /Users/openclaw/.openclaw/openclaw.json after removing token=abcdefghijklmnopqrstuvwxyz123456.",
          },
          {
            attempt: 2,
            tier: "crossCheck",
            modelId: "ollama/openclaw-control-qwen3-30b-q6-chatfix:latest",
            status: "invalid_json",
            local: true,
            schemaValidated: false,
            groupsReviewed: 0,
            preflightStatus: "passed",
            preflightSource: "default_ollama",
            providerConfigured: false,
            preflightMs: 7,
            completionMs: 1234,
            diagnostic: "missing_required_fields",
            error:
              "Reviewer returned invalid JSON. Reason: review groups were missing summary, recommendedAction, or confidence.",
          },
        ],
        preflightStatus: "missing_config",
        preflightMs: 8,
        schemaValidated: false,
        blockedPrimaryReason:
          "Local model preflight read /Users/openclaw/.openclaw/openclaw.json with token=abcdefghijklmnopqrstuvwxyz123456",
      },
    });

    expect(event).toMatchObject({
      kind: "model_preflight",
      actor: "gateway",
      targetId: "self-improvement-models",
      summary: "Checked Self-Improvement model readiness: degraded.",
      metadata: {
        readiness: "degraded",
        ready: true,
        readyTier: "crossCheck",
        readyModelId: "ollama/openclaw-control-qwen3-30b-q6-chatfix:latest",
        reviewModelId: "ollama/qwen3.6:27b-q8_0",
        attemptCount: 2,
        passedAttempts: 0,
        blockedAttempts: 1,
        failedAttempts: 0,
        invalidJsonAttempts: 1,
        primaryRemediationHint: "Register [local-path] after removing token=***",
        blockedRemediationHints: ["primaryReview: Register [local-path] after removing token=***"],
        invalidJsonDiagnostics: ["missing_required_fields"],
        completionDurations: ["crossCheck:1234ms"],
        preflightSources: ["crossCheck:default_ollama:default"],
        defaultOllamaFallbackAttempts: 1,
        attemptBlockers: [
          "primaryReview:blocked:missing_config: Local model preflight read [local-path] with token=***",
          "crossCheck:invalid_json:passed: Reviewer returned invalid JSON. Reason: review groups were missing summary, recommendedAction, or confidence.",
        ],
        attemptStatuses: ["primaryReview:blocked:missing_config", "crossCheck:invalid_json:passed"],
      },
    });

    const raw = await fs.readFile(resolveSelfImprovementAuditEventStorePath(tmpDir), "utf8");
    expect(raw).not.toContain("/Users/openclaw");
    expect(raw).not.toContain("abcdefghijklmnopqrstuvwxyz123456");
    expect(raw).not.toContain("private chain");
  });

  it("lists sanitized events newest first with optional kind filtering", async () => {
    await appendSelfImprovementAuditEvent({
      stateDir: tmpDir,
      event: {
        actor: "governor",
        kind: "analysis_run",
        targetId: "self-improvement",
        summary: "Analyzed recommendations",
        createdAt: 1,
      },
    });
    await appendSelfImprovementAuditEvent({
      stateDir: tmpDir,
      event: {
        actor: "gateway",
        kind: "model_preflight",
        targetId: "self-improvement-models",
        summary: "Checked model readiness",
        createdAt: 2,
      },
    });
    await appendSelfImprovementAuditEvent({
      stateDir: tmpDir,
      event: {
        actor: "gateway",
        kind: "proposal_status_updated",
        targetId: "sip_1",
        summary: "Updated proposal",
        createdAt: 3,
      },
    });

    const all = await listSelfImprovementAuditEvents({ stateDir: tmpDir, limit: 2 });
    expect(all.map((event) => event.kind)).toEqual(["proposal_status_updated", "model_preflight"]);

    const filtered = await listSelfImprovementAuditEvents({
      stateDir: tmpDir,
      kind: ["analysis_run", "model_preflight"],
    });
    expect(filtered.map((event) => event.kind)).toEqual(["model_preflight", "analysis_run"]);
  });
});
