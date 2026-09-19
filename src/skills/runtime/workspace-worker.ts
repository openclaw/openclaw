import type { Readable, Writable } from "node:stream";
import type { WorkspaceSkillSourceRequest } from "../loading/workspace-skill-sources.js";
import { decodeSkillWorkerRequest, writeSkillWorkerResult } from "./workspace-worker-io.js";

type WatchRequest = Pick<WorkspaceSkillSourceRequest, "sourcePlan" | "executionWorkspaceDir">;

/** A dedicated subprocess reuses native Skills owners on either kind of workspace host. */
export async function serveWorkspaceSkills(options: {
  workspace: string;
  home: string;
  operation: string;
  input: Readable;
  output: Writable;
}): Promise<void> {
  const { workspace, operation, input, output } = options;
  const write = (value: unknown) => writeSkillWorkerResult(output, value);
  const chunks: Buffer[] = [];
  const inputChunks: AsyncIterable<unknown> = input;
  for await (const raw of inputChunks) {
    if (typeof raw === "string") {
      chunks.push(Buffer.from(raw));
    } else if (raw instanceof Uint8Array) {
      chunks.push(Buffer.from(raw));
    } else {
      throw new Error("Skill worker input must be bytes");
    }
  }
  const text = Buffer.concat(chunks).toString("utf8");
  const decoded = decodeSkillWorkerRequest(text);
  switch (operation) {
    case "discovery": {
      // SAFETY: The adapter serializes the native source plan; workspace identity is checked next.
      const discovery = decoded as WorkspaceSkillSourceRequest;
      assertWorkspace(discovery, workspace);
      const { readWorkspaceSkillSources } = await import("../loading/workspace-skill-loader.js");
      await write(readWorkspaceSkillSources(discovery));
      return;
    }
    default:
      throw new Error(`Unknown skill worker operation: ${operation}`);
  }
}

function assertWorkspace(request: WatchRequest, workspace: string) {
  if (request.sourcePlan.workspaceDir !== workspace) {
    throw new Error("Skill request does not match the provisioned workspace");
  }
}
