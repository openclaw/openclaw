import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { afterEach, describe, expect, it } from "vitest";
import {
  CONTEXT_PRESERVE_TYPES,
  createStructuredContextConfigSchema,
  resolveStructuredContextConfig,
} from "./config.js";
import { __testing, createLayer0ContextEngine } from "./context-engine.js";

const tmpDirs: string[] = [];

async function makeTempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-structured-context-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (!dir) {
      continue;
    }
    await fs.rm(dir, { recursive: true, force: true });
  }
});

function toMessage(role: AgentMessage["role"], content: unknown): AgentMessage {
  return {
    role,
    content,
    timestamp: Date.now(),
  } as AgentMessage;
}

describe("structured-context config", () => {
  it("uses Layer0 defaults when config is undefined", () => {
    const resolved = resolveStructuredContextConfig(undefined);
    expect(resolved.context.enabled).toBe(true);
    expect(resolved.context.recentTurns).toBe(5);
    expect(resolved.context.qualityGuardEnabled).toBe(true);
    expect(resolved.context.qualityGuardMaxRetries).toBe(1);
    expect(resolved.context.oversizedToolOutputPolicy).toBe("artifact_ref");
    expect(resolved.context.preserveTypes).toEqual([...CONTEXT_PRESERVE_TYPES]);
  });

  it("rejects unknown context keys in schema safeParse", () => {
    const schema = createStructuredContextConfigSchema();
    const parsed = schema.safeParse?.({ context: { bad: true } });
    expect(parsed?.success).toBe(false);
  });
});

describe("structured-context context engine", () => {
  it("adds structured system prompt addition and respects recent turn trimming under budget pressure", async () => {
    const engine = createLayer0ContextEngine({
      config: resolveStructuredContextConfig({ context: { recentTurns: 1 } }),
    });

    const messages = [
      toMessage("user", "Please implement #1234 and keep /tmp/output.log unchanged"),
      toMessage("assistant", "Decision: I will keep identifiers exact."),
      toMessage("user", "Next step: update src/context-engine/legacy.ts"),
      toMessage("assistant", "TODO: run focused tests"),
    ];

    const assembled = await engine.assemble({
      sessionId: "session-1",
      messages,
      tokenBudget: 10,
    });

    expect(assembled.systemPromptAddition).toContain("Layer0 Continuity Hints");
    expect(assembled.messages.length).toBeLessThan(messages.length);
  });

  it("emits machine-readable contextRecord and artifact refs in compact result details", async () => {
    const tempDir = await makeTempDir();
    const sessionFile = path.join(tempDir, "session.jsonl");
    const oversizedOutput = "x".repeat(5_000);

    const lines = [
      {
        type: "message",
        message: toMessage("user", "Please fix this and keep ISSUE #24643 in the response."),
      },
      {
        type: "message",
        message: {
          ...toMessage("toolResult", [{ type: "text", text: oversizedOutput }]),
          toolName: "exec",
          toolCallId: "call-1",
        },
      },
    ];

    await fs.writeFile(
      sessionFile,
      `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
      "utf8",
    );

    const engine = createLayer0ContextEngine({
      config: resolveStructuredContextConfig(undefined),
      compactFn: async () => ({
        ok: true,
        compacted: true,
        result: {
          summary: "",
          tokensBefore: 120,
          tokensAfter: 60,
          details: { previous: true },
        },
      }),
      artifactThresholdChars: 128,
    });

    const compacted = await engine.compact({
      sessionId: "session-1",
      sessionFile,
      tokenBudget: 4000,
      runtimeContext: {},
    });

    expect(compacted.ok).toBe(true);
    expect(compacted.compacted).toBe(true);
    expect(compacted.result?.summary).toContain("## Decisions");

    const details = compacted.result?.details as {
      previous?: boolean;
      contextRecord?: { artifactRefs?: Array<{ path: string }> };
      artifactRefs?: Array<{ path: string }>;
    };

    expect(details.previous).toBe(true);
    expect(details.contextRecord).toBeDefined();
    expect(details.artifactRefs).toBeDefined();
    expect((details.artifactRefs?.length ?? 0) > 0).toBe(true);

    const artifactPath = details.artifactRefs?.[0]?.path;
    expect(typeof artifactPath).toBe("string");
    if (artifactPath) {
      const artifactRaw = await fs.readFile(artifactPath, "utf8");
      expect(artifactRaw).toContain("Layer0 Artifact");
    }
  });

  it("detects identifiers for issue refs, file paths, env vars, and backticks", () => {
    const identifiers = __testing.extractIdentifiers(
      "Use `pnpm test -- src/context-engine/context-engine.test.ts` on /tmp/a.log with OPENAI_API_KEY and #24643",
    );

    expect(identifiers).toContain("pnpm test -- src/context-engine/context-engine.test.ts");
    expect(identifiers).toContain("/tmp/a.log");
    expect(identifiers).toContain("OPENAI_API_KEY");
    expect(identifiers).toContain("#24643");
  });
});
