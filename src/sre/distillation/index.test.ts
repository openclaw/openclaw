import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withEnvAsync } from "../../test-utils/env.js";
import { resolveSreStatePaths } from "../state/paths.js";
import {
  distillCompactionSummary,
  distillSubagentOutcome,
  extractDistilledSummarySections,
} from "./index.js";

const tempRoots: string[] = [];

async function createTempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-distillation-"));
  tempRoots.push(root);
  return root;
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("distillation", () => {
  it("extracts structured summary sections", () => {
    const sections = extractDistilledSummarySections(
      [
        "## Decisions",
        "- do x",
        "",
        "## Open TODOs",
        "- do y",
        "",
        "## Constraints/Rules",
        "- keep z",
        "",
        "## Pending user asks",
        "- answer q",
        "",
        "## Exact identifiers",
        "- abc123",
      ].join("\n"),
    );

    expect(sections.decisions).toEqual(["do x"]);
    expect(sections.openTodos).toEqual(["do y"]);
    expect(sections.constraints).toEqual(["keep z"]);
    expect(sections.pendingAsks).toEqual(["answer q"]);
    expect(sections.identifiers).toEqual(["abc123"]);
  });

  it("writes dossier and memory note for compaction summaries when incident metadata exists", async () => {
    const root = await createTempRoot();
    const workspaceDir = path.join(root, "workspace");
    const sessionsDir = path.join(root, "agents", "main", "sessions");
    const sessionFile = path.join(sessionsDir, "sess-1.jsonl");
    await fs.mkdir(sessionsDir, { recursive: true });
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.writeFile(sessionFile, "", "utf8");
    await fs.writeFile(
      path.join(sessionsDir, "sessions.json"),
      JSON.stringify(
        {
          "agent:main:main": {
            sessionId: "sess-1",
            updatedAt: Date.now(),
            sessionFile,
            incidentId: "incident:123",
            entityRefs: ["entity:thread:1"],
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    await withEnvAsync({ OPENCLAW_STATE_DIR: root }, async () => {
      const result = await distillCompactionSummary({
        summary: "## Decisions\n- ship fix\n\n## Open TODOs\n- verify prod",
        sessionFile,
        sessionId: "sess-1",
        workspaceDir,
      });

      expect(result.dossierPath).toContain("runtime-distillation-");
      expect(result.memoryNotePath).toContain("memory");
      const dossier = await fs.readFile(result.dossierPath as string, "utf8");
      expect(dossier).toContain("incident:123");
      const note = await fs.readFile(result.memoryNotePath as string, "utf8");
      expect(note).toContain("ship fix");
    });
  });

  it("writes dossier note for subagent outcomes when requester session maps to an incident", async () => {
    const root = await createTempRoot();
    const sessionsDir = path.join(root, "agents", "main", "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    await fs.writeFile(
      path.join(sessionsDir, "sessions.json"),
      JSON.stringify(
        {
          "agent:main:main": {
            sessionId: "sess-main",
            updatedAt: Date.now(),
            incidentId: "incident:456",
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    await withEnvAsync({ OPENCLAW_STATE_DIR: root }, async () => {
      const result = await distillSubagentOutcome({
        childSessionKey: "agent:main:subagent:child",
        requesterSessionKey: "agent:main:main",
        runId: "run-1",
        reason: "subagent-complete",
        outcome: "error",
        error: "boom",
      });

      expect(result.dossierPath).toContain("runtime-distillation-");
      const dossier = await fs.readFile(result.dossierPath as string, "utf8");
      expect(dossier).toContain("boom");
    });
  });

  it("serializes concurrent dossier writes and keeps non-destructive artifacts", async () => {
    const root = await createTempRoot();
    const workspaceDir = path.join(root, "workspace");
    const sessionsDir = path.join(root, "agents", "main", "sessions");
    const sessionFile = path.join(sessionsDir, "sess-1.jsonl");
    await fs.mkdir(sessionsDir, { recursive: true });
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.writeFile(sessionFile, "", "utf8");
    await fs.writeFile(
      path.join(sessionsDir, "sessions.json"),
      JSON.stringify(
        {
          "agent:main:main": {
            sessionId: "sess-1",
            updatedAt: Date.now(),
            sessionFile,
            incidentId: "incident:123",
            entityRefs: ["entity:thread:1"],
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    await withEnvAsync({ OPENCLAW_STATE_DIR: root }, async () => {
      const indexPath = path.join(
        resolveSreStatePaths(process.env).dossiersDir,
        "incident:123",
        "index.json",
      );
      const firstIndexWriteStarted = createDeferred<void>();
      const releaseFirstIndexWrite = createDeferred<void>();
      const originalWriteFile = fs.writeFile.bind(fs) as (
        ...args: Parameters<typeof fs.writeFile>
      ) => ReturnType<typeof fs.writeFile>;
      let blockedFirstIndexWrite = false;

      vi.spyOn(fs, "writeFile").mockImplementation(
        async (...args: Parameters<typeof fs.writeFile>) => {
          const [filePath] = args;
          if (!blockedFirstIndexWrite && filePath === indexPath) {
            blockedFirstIndexWrite = true;
            firstIndexWriteStarted.resolve(undefined);
            await releaseFirstIndexWrite.promise;
          }
          return originalWriteFile(...args);
        },
      );

      const summary = "## Decisions\n- ship fix\n\n## Open TODOs\n- verify prod";
      const firstWrite = distillCompactionSummary({
        summary,
        sessionFile,
        sessionId: "sess-1",
        workspaceDir,
      });
      await firstIndexWriteStarted.promise;

      const secondWrite = distillCompactionSummary({
        summary,
        sessionFile,
        sessionId: "sess-1",
        workspaceDir,
      });

      releaseFirstIndexWrite.resolve(undefined);
      const [firstResult, secondResult] = await Promise.all([firstWrite, secondWrite]);

      expect(firstResult.dossierPath).not.toEqual(secondResult.dossierPath);
      expect(firstResult.memoryNotePath).not.toEqual(secondResult.memoryNotePath);

      const dossierDir = path.dirname(firstResult.dossierPath as string);
      const dossierFiles = (await fs.readdir(dossierDir)).filter((file) =>
        file.startsWith("runtime-distillation-"),
      );
      expect(dossierFiles).toHaveLength(2);

      const memoryDir = path.join(workspaceDir, "memory");
      const memoryFiles = (await fs.readdir(memoryDir)).filter((file) =>
        file.includes("runtime-distill-"),
      );
      expect(memoryFiles).toHaveLength(2);

      const index = JSON.parse(await fs.readFile(indexPath, "utf8")) as {
        timeline: Array<{ refId: string }>;
      };
      expect(index.timeline).toHaveLength(2);
      expect(new Set(index.timeline.map((entry) => entry.refId)).size).toBe(2);
    });
  });
});
