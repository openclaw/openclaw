import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { replaceTranscriptEvents } from "../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import { invalidateLoggingConfigCache, readLoggingConfig } from "../logging/config.js";
import { registerSecretValueForRedaction } from "../logging/secret-redaction-registry.js";
import { resetSecretRedactionRegistryForTest } from "../logging/secret-redaction-registry.test-support.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { exportTrajectoryBundle } from "./export.js";
import {
  assistantMessage,
  messageEntry,
  sessionHeader,
  writeEntries,
} from "./export.test-helpers.js";
import { appendSqliteTrajectoryRuntimeEvents } from "./runtime-store.test-support.js";

afterEach(() => {
  resetSecretRedactionRegistryForTest();
  invalidateLoggingConfigCache();
});

function readBundle(outputDir: string) {
  const invalid: string[] = [];
  const documents = new Map<string, unknown>();
  const text = fs
    .readdirSync(outputDir)
    .map((file) => {
      const content = fs.readFileSync(path.join(outputDir, file), "utf8");
      try {
        if (file.endsWith(".json")) {
          documents.set(file, JSON.parse(content));
        } else if (file.endsWith(".jsonl")) {
          documents.set(
            file,
            content
              .trim()
              .split("\n")
              .map((line) => JSON.parse(line)),
          );
        }
      } catch {
        invalid.push(file);
      }
      return content;
    })
    .join("\n");
  return { invalid, documents, text };
}

const quotedSecret = 'sk-synthetic-export-"quoted-secret';

it.each(["token", "target"])(
  "keeps quoted %s text parseable through the export API",
  async (word) => {
    await withOpenClawTestState({ layout: "state-only" }, async (state) => {
      await state.writeConfig({});
      invalidateLoggingConfigCache();
      const sessionFile = state.path("session.jsonl");
      const outputDir = state.path("bundle");
      writeEntries(sessionFile, [
        sessionHeader(state.workspaceDir),
        messageEntry(
          "quoted-command",
          null,
          assistantMessage([
            {
              type: "toolCall",
              id: "quoted",
              name: "exec",
              arguments: { command: `echo "=== deploy ${word} ==="`, apiKey: quotedSecret },
            },
          ]),
        ),
      ]);
      await exportTrajectoryBundle({
        sessionFile,
        outputDir,
        sessionId: "session-1",
        workspaceDir: state.workspaceDir,
      });
      const bundle = readBundle(outputDir);
      expect(bundle.text).not.toContain("quoted-secret");
      expect(bundle.invalid).toEqual([]);
      if (word === "target") {
        expect(bundle.text).toContain("deploy target");
      }
    });
  },
);

it("preserves contextual custom matching beyond one chunk and registered protection", async () => {
  await withOpenClawTestState({ layout: "state-only" }, async (state) => {
    const pattern = String.raw`"projectNote"\s*:\s*"(project-note-opaque)"\s*,\s*"publicNote"\s*:\s*"project-note-opaque"`;
    await state.writeConfig({ logging: { redactPatterns: [pattern] } });
    invalidateLoggingConfigCache();
    expect(readLoggingConfig()).toMatchObject({
      redactPatterns: [pattern],
    });
    const registered = "FIXTURE-LOOKUP-OPAQ-7422";
    registerSecretValueForRedaction(registered);
    const values = {
      padding: "x".repeat(40_000),
      projectNote: "project-note-opaque",
      publicNote: "project-note-opaque",
      lookupTag: registered,
      apiKey: quotedSecret,
    };
    const sessionTarget = {
      agentId: "main",
      sessionKey: "agent:main:export-redaction",
      sessionId: "session-1",
      storePath: state.path("sessions.json"),
    };
    await replaceTranscriptEvents(sessionTarget, [
      sessionHeader(state.workspaceDir),
      messageEntry(
        "custom-command",
        null,
        assistantMessage([{ type: "toolCall", id: "custom", name: "exec", arguments: values }]),
      ),
    ]);
    appendSqliteTrajectoryRuntimeEvents(sessionTarget, [
      {
        traceSchema: "openclaw-trajectory",
        schemaVersion: 1,
        traceId: "session-1",
        source: "runtime",
        type: "context.compiled",
        ts: "2026-04-22T08:00:00.000Z",
        seq: 1,
        sessionId: "session-1",
        data: { tools: [{ name: "example", ...values }], systemPrompt: `Lookup ${registered}` },
      },
    ]);
    const outputDir = state.path("bundle");
    await exportTrajectoryBundle({
      sessionTarget,
      outputDir,
      sessionId: "session-1",
      workspaceDir: state.workspaceDir,
    });
    const bundle = readBundle(outputDir);
    expect(bundle.text).not.toContain(registered);
    expect(bundle.text).not.toContain("quoted-secret");
    expect(bundle.invalid).toEqual([]);
    expect(bundle.documents.get("tools.json")).toEqual([
      expect.objectContaining({ projectNote: "projec…aque", publicNote: "project-note-opaque" }),
    ]);
    expect(bundle.documents.get("session-branch.json")).toMatchObject({
      entries: [
        expect.objectContaining({
          message: expect.objectContaining({
            content: [
              expect.objectContaining({
                arguments: expect.objectContaining({
                  projectNote: "projec…aque",
                  publicNote: "project-note-opaque",
                }),
              }),
            ],
          }),
        }),
      ],
    });
    expect(fs.statSync(path.join(outputDir, "tools.json")).size).toBeGreaterThan(32_768);
  });
});
