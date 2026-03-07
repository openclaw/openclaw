import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  listKnowledgeTransferRules,
  removeKnowledgeTransferRule,
  resolveKnowledgeTransferMode,
  resolveKnowledgeTransferPathDecision,
  setKnowledgeTransferPairMode,
  upsertKnowledgeTransferRule,
} from "./knowledge-transfer-policy.js";

function buildConfig(): OpenClawConfig {
  return {
    tools: {
      agentToAgent: {
        knowledgeTransfer: {
          enabled: true,
          defaultExportMode: "ask",
          defaultImportMode: "ask",
          approvalTimeoutSeconds: 120,
        },
      },
    },
  } as OpenClawConfig;
}

describe("knowledge-transfer-policy", () => {
  let stateDir = "";
  let previousStateDir: string | undefined;

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-kt-policy-"));
    previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = stateDir;
  });

  afterEach(async () => {
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("defaults to deny when no rules are configured", async () => {
    const exportDecision = await resolveKnowledgeTransferPathDecision({
      requesterAgentId: "requester",
      targetAgentId: "source",
      side: "export",
      sourcePath: "MEMORY.md",
      baseDir: stateDir,
    });
    expect(exportDecision.allowed).toBe(false);
    expect(exportDecision.decision).toBe("hide");
    expect(exportDecision.source).toBe("default_deny");

    const importDecision = await resolveKnowledgeTransferPathDecision({
      requesterAgentId: "requester",
      targetAgentId: "source",
      side: "import",
      sourcePath: "memory/public/share.md",
      baseDir: stateDir,
    });
    expect(importDecision.allowed).toBe(false);
    expect(importDecision.decision).toBe("hide");
    expect(importDecision.source).toBe("default_deny");
  });

  it("resolves pair rules before wildcard rules and keeps side-specific behavior", async () => {
    await upsertKnowledgeTransferRule({
      requesterAgentId: "*",
      targetAgentId: "*",
      side: "export",
      pathPattern: "memory/**",
      decision: "auto",
      baseDir: stateDir,
    });
    await upsertKnowledgeTransferRule({
      requesterAgentId: "*",
      targetAgentId: "*",
      side: "import",
      pathPattern: "memory/**",
      decision: "auto",
      baseDir: stateDir,
    });

    await upsertKnowledgeTransferRule({
      requesterAgentId: "requester",
      targetAgentId: "source",
      side: "export",
      pathPattern: "memory/private/**",
      decision: "hide",
      baseDir: stateDir,
    });
    await upsertKnowledgeTransferRule({
      requesterAgentId: "requester",
      targetAgentId: "source",
      side: "import",
      pathPattern: "memory/public/**",
      decision: "ask",
      baseDir: stateDir,
    });

    const privateExport = await resolveKnowledgeTransferPathDecision({
      requesterAgentId: "requester",
      targetAgentId: "source",
      side: "export",
      sourcePath: "memory/private/secrets.md",
      baseDir: stateDir,
    });
    expect(privateExport.allowed).toBe(false);
    expect(privateExport.decision).toBe("hide");
    expect(privateExport.source).toBe("pair");

    const publicExport = await resolveKnowledgeTransferPathDecision({
      requesterAgentId: "requester",
      targetAgentId: "source",
      side: "export",
      sourcePath: "memory/public/share.md",
      baseDir: stateDir,
    });
    expect(publicExport.allowed).toBe(true);
    expect(publicExport.mode).toBe("auto");
    expect(publicExport.source).toBe("global_wildcard");

    const publicImport = await resolveKnowledgeTransferPathDecision({
      requesterAgentId: "requester",
      targetAgentId: "source",
      side: "import",
      sourcePath: "memory/public/share.md",
      baseDir: stateDir,
    });
    expect(publicImport.allowed).toBe(true);
    expect(publicImport.mode).toBe("ask");
    expect(publicImport.source).toBe("pair");
  });

  it("uses last matching rule wins semantics within a pair", async () => {
    await upsertKnowledgeTransferRule({
      requesterAgentId: "requester",
      targetAgentId: "source",
      side: "export",
      pathPattern: "memory/public/**",
      decision: "hide",
      baseDir: stateDir,
    });
    await upsertKnowledgeTransferRule({
      requesterAgentId: "requester",
      targetAgentId: "source",
      side: "export",
      pathPattern: "memory/public/**",
      decision: "auto",
      baseDir: stateDir,
    });

    const decision = await resolveKnowledgeTransferPathDecision({
      requesterAgentId: "requester",
      targetAgentId: "source",
      side: "export",
      sourcePath: "memory/public/notes.md",
      baseDir: stateDir,
    });
    expect(decision.allowed).toBe(true);
    expect(decision.mode).toBe("auto");
  });

  it("supports mode shorthand and explicit rule removal", async () => {
    const cfg = buildConfig();
    await setKnowledgeTransferPairMode({
      requesterAgentId: "requester",
      targetAgentId: "source",
      mode: "auto",
      baseDir: stateDir,
    });

    const mode = await resolveKnowledgeTransferMode({
      cfg,
      requesterAgentId: "requester",
      targetAgentId: "source",
      baseDir: stateDir,
    });
    expect(mode.mode).toBe("auto");

    const rules = await listKnowledgeTransferRules({
      requesterAgentId: "requester",
      targetAgentId: "source",
      baseDir: stateDir,
    });
    expect(rules.length).toBeGreaterThanOrEqual(2);

    const removed = await removeKnowledgeTransferRule({
      id: rules[0]?.id ?? "",
      requesterAgentId: "requester",
      targetAgentId: "source",
      baseDir: stateDir,
    });
    expect(removed.removed).toBe(true);

    const rulesAfterRemove = await listKnowledgeTransferRules({
      requesterAgentId: "requester",
      targetAgentId: "source",
      baseDir: stateDir,
    });
    expect(rulesAfterRemove.length).toBe(rules.length - 1);
  });
});
