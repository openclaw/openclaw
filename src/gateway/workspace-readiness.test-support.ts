import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs/promises";
import path from "node:path";
import { Value } from "typebox/value";
import { expect } from "vitest";
import { createAdmittedHostCapabilityTestFixture } from "../agents/harness/host-capability.test-support.js";
import { createReadTool } from "../agents/sessions/tools/read.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import { runWithAgentWorkspaceReadiness } from "../agents/workspace-readiness.js";

/** A completed checkout's async callback must not lend its retired run to a successor. */
export async function expectSuccessorWorkspaceRead(params: {
  workspaceDir: string;
  sessionKey: string;
  run: (readWorkspace: () => Promise<void>) => Promise<void>;
}) {
  const file = "successor.txt";
  const contents = "Only the successor's live admission owns this workspace read.\n";
  await fs.mkdir(params.workspaceDir, { recursive: true });
  await fs.writeFile(path.join(params.workspaceDir, file), contents);
  const hosts: Awaited<ReturnType<typeof createAdmittedHostCapabilityTestFixture>>[] = [];
  const bindRead = async (runId: string) => {
    const host = await createAdmittedHostCapabilityTestFixture({
      runId,
      agentId: "main",
      sessionId: "readiness-session",
      sessionKey: params.sessionKey,
      workspaceDir: params.workspaceDir,
      cwd: params.workspaceDir,
    });
    hosts.push(host);
    const read = createReadTool(params.workspaceDir);
    const source: AnyAgentTool = {
      ...read,
      execute: (id, args, signal) => read.execute(id, Value.Parse(read.parameters, args), signal),
    };
    const [bound] = host.hostCapabilities.bindToolSurface([source]);
    if (!bound) {
      throw new Error("Expected a host-bound read tool");
    }
    return () => bound.execute("read-workspace", { path: file });
  };
  let current = true;
  const retired = new Error("Session changed while preparing its project; retry the task.");
  try {
    const original = await runWithAgentWorkspaceReadiness(
      {
        sessionKey: params.sessionKey,
        isReady: () => true,
        waitUntilReady: async () => {},
        assertCurrent: () => {
          if (!current) {
            throw retired;
          }
        },
      },
      async () => ({
        read: await bindRead("original-workspace-run"),
        resume: AsyncLocalStorage.snapshot(),
      }),
    );
    await expect(original.read()).resolves.toMatchObject({
      content: [{ type: "text", text: contents }],
    });
    current = false;
    await expect(original.read()).rejects.toBe(retired);
    let reading: ReturnType<Awaited<ReturnType<typeof bindRead>>> | undefined;
    await original.resume(() =>
      params.run(async () => {
        const read = await bindRead("successor-workspace-run");
        reading = read();
        await reading;
      }),
    );
    expect(reading, "The successor must reach the actual host-bound read").toBeDefined();
    await expect(reading).resolves.toMatchObject({ content: [{ type: "text", text: contents }] });
    // Clearing the successor's inherited scope must not revive already-issued tools.
    await expect(original.read()).rejects.toBe(retired);
  } finally {
    for (const host of hosts.toReversed()) {
      host.closeHost();
      host.closeAdmission();
    }
  }
}
