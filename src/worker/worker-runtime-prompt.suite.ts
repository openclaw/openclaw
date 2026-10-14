import { mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import type {
  WorkerLiveEventParams,
  WorkerTranscriptCommitParams,
} from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import {
  validateWorkerInferenceStartParams,
  type WorkerInferenceStartParams,
} from "../../packages/gateway-protocol/src/schema/worker-inference.js";
import { createOperationalRunInstanceRef } from "../agents/admitted-run-context.js";
import * as boundaryFileRead from "../infra/boundary-file-read.js";
import { prepareSkillBundle } from "../skills/library/bundle.js";
import { parseWorkerLaunchDescriptor, type WorkerLaunchDescriptor } from "./launch-descriptor.js";
import { runWorkerDescriptor } from "./worker.runtime.js";

type WorkerPromptFixture = {
  setup: () => Promise<{
    gateway: {
      inferenceRequests: WorkerInferenceStartParams[];
      liveEventRequests: WorkerLiveEventParams[];
      transcriptRequests: WorkerTranscriptCommitParams[];
      acceptedTranscriptRequests: WorkerTranscriptCommitParams[];
      applicationOrder: string[];
    };
    workspaceDir: string;
    launch: WorkerLaunchDescriptor;
  }>;
  modelRef: { provider: string; model: string };
};

export function registerWorkerPromptTests({ setup, modelRef: MODEL_REF }: WorkerPromptFixture) {
  it.each([false, true])(
    "runs and replays an embedded turn through remote inference (system updates: %s)",
    async (inHistorySystemUpdates) => {
      const { gateway, workspaceDir, launch } = await setup();
      await writeFile(path.join(workspaceDir, "AGENTS.md"), "ambient-worker-context", "utf8");
      launch.assignment.systemPrompt =
        "worker-bootstrap-marker\n<available_skills><skill><name>stable</name></skill></available_skills>";
      launch.assignment.runtimeContext = [{ kind: "conversation-data", text: "retained context" }];
      launch.assignment.inHistorySystemUpdates = inHistorySystemUpdates;
      launch.assignment.includeEmptySnapshots = true;
      const files = [
        { path: "SKILL.md", content: "# Stable worker skill\n", encoding: "utf8" as const },
      ];
      launch.assignment.skillResources = {
        version: 1,
        skills: [
          {
            name: "stable",
            description: "Worker fixture",
            files,
            revision: prepareSkillBundle(files).revision,
          },
        ],
      };

      const result = await runWorkerDescriptor(parseWorkerLaunchDescriptor(launch));

      expect(result.status).toBe("completed");
      expect(gateway.inferenceRequests).toHaveLength(1);
      expect(gateway.inferenceRequests[0]?.modelRef).toEqual(MODEL_REF);
      expect(gateway.inferenceRequests[0]?.context.systemPrompt).toContain(
        "worker-bootstrap-marker",
      );
      const firstCarrier = gateway.inferenceRequests[0]!.context.messages[1];
      expect(firstCarrier).toMatchObject(
        inHistorySystemUpdates
          ? { role: "user", operatorMessage: { turnScoped: true } }
          : { role: "user", runtimeContext: {} },
      );
      expect(firstCarrier).not.toHaveProperty("runtimeContextCarrier");
      expect(firstCarrier?.content).toContain("Active exec sessions:\\nnone");
      if (!inHistorySystemUpdates) {
        expect(firstCarrier).not.toHaveProperty("operatorMessage");
        const inferenceRequest = gateway.inferenceRequests[0]!;
        expect(
          validateWorkerInferenceStartParams({
            ...inferenceRequest,
            context: {
              ...inferenceRequest.context,
              messages: [
                {
                  role: "user",
                  content: "legacy facts",
                  timestamp: 1,
                  runtimeContextCarrier: true,
                },
              ],
            },
          }),
        ).toBe(false);
      }
      expect(gateway.inferenceRequests[0]!.context.messages[0]).not.toHaveProperty(
        "operatorMessage",
      );
      const toolNames = gateway.inferenceRequests[0]?.context.tools?.map((tool) => tool.name) ?? [];
      expect(toolNames).toHaveLength(6);
      const terminalIndex = gateway.applicationOrder.findIndex(
        (entry) => entry === "live:lifecycle:finishing",
      );
      const finalTranscriptIndex = gateway.applicationOrder.findLastIndex((entry) =>
        entry.startsWith("transcript:"),
      );
      expect(finalTranscriptIndex).toBeGreaterThanOrEqual(0);
      expect(terminalIndex).toBeGreaterThan(finalTranscriptIndex);
      expect(toolNames).toEqual(
        expect.arrayContaining(["read", "write", "edit", "apply_patch", "exec", "process"]),
      );
      expect(gateway.liveEventRequests.some((request) => request.event.kind === "assistant")).toBe(
        true,
      );
      const lifecycleEvents = gateway.liveEventRequests.flatMap((request) =>
        request.event.kind === "lifecycle" ? [request.event.payload.phase] : [],
      );
      expect(lifecycleEvents).toContain("start");
      expect(lifecycleEvents).toContain("finishing");
      expect(lifecycleEvents).not.toContain("end");
      expect(gateway.liveEventRequests.at(-1)?.event).toMatchObject({
        kind: "lifecycle",
        payload: { phase: "finishing", stopReason: "stop" },
      });
      expect(gateway.transcriptRequests.length).toBeGreaterThan(0);
      expect(gateway.transcriptRequests.map((request) => request.seq)).toEqual(
        gateway.transcriptRequests.map((_request, index) => index + 3),
      );
      expect(
        gateway.transcriptRequests
          .flatMap((request) => request.messages)
          .map((message) => message.role),
      ).toEqual(["user", "custom", "assistant"]);
      expect(gateway.transcriptRequests.flatMap((request) => request.messages)[1]).toMatchObject({
        role: "custom",
        display: false,
        customType: inHistorySystemUpdates ? "openclaw.system-update" : "openclaw.runtime-context",
        details: inHistorySystemUpdates
          ? { kind: "runtime-context", turnScoped: true }
          : { source: "openclaw-runtime-context", runtimeContextCarrier: true },
      });
      const lastTranscript = gateway.transcriptRequests.at(-1);
      expect(result).toMatchObject({
        transcriptLeafId: `leaf-${lastTranscript?.seq}`,
        transcriptNextSeq: (lastTranscript?.seq ?? 0) + 1,
      });

      const firstPrompt = gateway.inferenceRequests[0]!.context.systemPrompt;
      expect(firstPrompt).toContain("<name>stable</name>");
      if (result.status !== "completed") {
        throw new Error("Expected the first worker turn to complete");
      }
      const next = structuredClone(launch);
      next.assignment.runId = "worker-next-run";
      next.assignment.turnId = "worker-next-turn";
      next.assignment.operationalRunInstance = createOperationalRunInstanceRef(
        next.assignment.runId,
      );
      next.assignment.prompt = "Continue with the same skill.";
      next.assignment.initialMessages = gateway.acceptedTranscriptRequests.flatMap(
        (request) => request.messages,
      );
      next.assignment.transcript = {
        baseLeafId: result.transcriptLeafId,
        nextSeq: result.transcriptNextSeq,
      };
      expect((await runWorkerDescriptor(parseWorkerLaunchDescriptor(next))).status).toBe(
        "completed",
      );
      expect(gateway.inferenceRequests[1]!.context.systemPrompt).toBe(firstPrompt);
      const retained = gateway.inferenceRequests[1]!.context.messages[1];
      // The session entry owns the replay timestamp, independently of prompt creation.
      expect(retained).toEqual({
        ...firstCarrier,
        timestamp: next.assignment.initialMessages[1]?.timestamp,
      });
      const currentCarrier = gateway.inferenceRequests[1]!.context.messages.at(-1);
      expect(currentCarrier).toMatchObject(
        inHistorySystemUpdates
          ? { role: "user", operatorMessage: { turnScoped: true } }
          : { role: "user", runtimeContext: {} },
      );
      expect(currentCarrier).not.toHaveProperty("runtimeContextCarrier");
      if (!inHistorySystemUpdates) {
        expect(currentCarrier).not.toHaveProperty("operatorMessage");
      }
    },
  );

  it.each([false, true])("uses only prepared prompt inputs (Gateway extra: %s)", async (extra) => {
    const { gateway, workspaceDir, launch } = await setup();
    const canonicalWorkspaceDir = await realpath(workspaceDir);
    const promptDir = path.join(workspaceDir, ".openclaw");
    const literalPrompt = path.join(workspaceDir, "not-a-prompt-file.md");
    await mkdir(promptDir);
    await writeFile(path.join(workspaceDir, "AGENTS.md"), "prepared-worker-context");
    for (const name of ["SOUL.md", "IDENTITY.md", "USER.md", "BOOTSTRAP.md", "MEMORY.md"]) {
      await writeFile(path.join(workspaceDir, name), "unselected-workspace-bootstrap-marker");
    }
    await writeFile(path.join(promptDir, "SYSTEM.md"), "ambient-system-marker");
    await writeFile(path.join(promptDir, "APPEND_SYSTEM.md"), "ambient-append-marker");
    await writeFile(literalPrompt, "unrequested-file-contents");
    launch.assignment.systemPrompt = extra ? literalPrompt : "prepared-worker-context";

    const openedFiles = vi.spyOn(boundaryFileRead, "openRootFile");
    try {
      await expect(runWorkerDescriptor(launch)).resolves.toMatchObject({ status: "completed" });
      expect(
        openedFiles.mock.calls
          .map(([params]) => params.absolutePath)
          .filter((filePath) => path.dirname(filePath) === canonicalWorkspaceDir),
      ).toEqual([]);
    } finally {
      openedFiles.mockRestore();
    }

    const prompt = gateway.inferenceRequests[0]?.context.systemPrompt;
    expect(prompt).toBe(launch.assignment.systemPrompt);
    expect.soft(prompt).not.toContain("Available tools:");
    expect.soft(prompt).not.toContain("ambient-system-marker");
    expect.soft(prompt).not.toContain("ambient-append-marker");
    expect.soft(prompt).not.toContain("unrequested-file-contents");
    expect.soft(prompt).not.toContain("unselected-workspace-bootstrap-marker");
    if (extra) {
      expect.soft(prompt).toContain(literalPrompt);
    }
  });
}
