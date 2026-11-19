import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type { PreparedAgentRunAdmission } from "../agents/admitted-run-context.js";
import { resolveBootstrapContextForRun } from "../agents/bootstrap-files.js";
import {
  createMemoryWriteProvenanceObserver,
  withMemoryWriteProvenance,
} from "../agents/memory-write-provenance.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { readMemoryArtifactProvenance } from "../memory/memory-artifact-provenance.js";
import { resetPluginStateStoreForTests } from "../plugin-state/plugin-state-store.js";
import {
  clearMemoryPluginState,
  registerMemoryCapability,
  type MemoryPluginRuntime,
} from "../plugins/memory-state.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { revokeMcpLoopbackClientGrant } from "./mcp-grant-store.js";
import * as mcp from "./mcp-http-request.test-support.js";
import { closeMcpLoopbackServer, ensureMcpLoopbackServer } from "./mcp-http.js";

// Fixed external I/O only: real web_fetch, HTTP grant, tool policy, filesystem, and provenance.
vi.mock("../agents/tools/web-guarded-fetch.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/tools/web-guarded-fetch.js")>()),
  fetchWithWebToolsNetworkGuard: async () => ({
    response: new Response("Synthetic network note", { headers: { "content-type": "text/plain" } }),
    finalUrl: "https://example.com/memory-provenance",
    release: async () => {},
  }),
}));

const { createMemoryRuntime } = await vi.importActual<{
  createMemoryRuntime: (host: {
    runInBackgroundContext: <T>(run: () => T) => T;
  }) => MemoryPluginRuntime;
}>("../../extensions/memory-core/runtime-api.js");
let state: OpenClawTestState;
let config: OpenClawConfig;
const admissions: PreparedAgentRunAdmission[] = [];
const tokens: string[] = [];
const paths = ["MEMORY.md", "USER.md", "memory/nested/note.md"];
beforeAll(async () => {
  state = await createOpenClawTestState({
    prefix: "mcp-memory-provenance-",
    layout: "state-only",
    env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" },
  });
  config = {
    agents: { defaults: { workspace: state.workspaceDir, skipBootstrap: true } },
    plugins: { enabled: false },
    tools: {
      allow: ["write", "edit", "apply_patch", "web_fetch"],
      exec: { security: "full", ask: "off", applyPatch: { enabled: true, allowModels: ["gpt-5"] } },
    },
  };
  await state.writeConfig(config);
  setRuntimeConfigSnapshot(config);
  registerMemoryCapability("memory-core", {
    runtime: createMemoryRuntime({ runInBackgroundContext: (run) => run() }),
  });
  await fs.mkdir(path.join(state.workspaceDir, "memory/nested"), { recursive: true });
  await ensureMcpLoopbackServer();
});
afterAll(async () => {
  tokens.forEach(revokeMcpLoopbackClientGrant);
  admissions.forEach((admission) => admission.close());
  await closeMcpLoopbackServer();
  clearRuntimeConfigSnapshot();
  clearMemoryPluginState();
  resetPluginStateStoreForTests();
  await state?.cleanup();
});

async function grant(runId: string) {
  const runtime = mcp.runtime();
  const admission = mcp.prepareAdmission(runId, "memory-provenance", { cfg: config });
  admissions.push(admission);
  const captured = mcp.captureGrant(
    {
      runtimeOwnerToken: runtime.ownerToken,
      admittedRunContext: await admission.admit("gateway"),
      context: {
        sessionKey: "agent:main:memory-provenance",
        sessionId: runId,
        runId,
        agentId: "main",
        senderIsOwner: true,
        workspaceDir: state.workspaceDir,
        cwd: state.workspaceDir,
        modelProvider: "openai",
        modelId: "gpt-5",
        toolsAllow: ["write", "edit", "apply_patch", "web_fetch"],
      },
    },
    runId,
    (token) => tokens.push(token),
  );
  return {
    admission,
    rawCall: () =>
      mcp.request(
        runtime,
        mcp.toolCall("write", { path: "MEMORY.md", content: "retired" }),
        captured,
      ),
    call: async (name: string, args: Record<string, unknown>) => {
      const response = await mcp.json(
        await mcp.request(runtime, mcp.toolCall(name, args), captured),
      );
      expect(response).toMatchObject({ result: { isError: false } });
    },
    list: async () =>
      mcp.json(
        await mcp.request(runtime, { jsonrpc: "2.0", id: 1, method: "tools/list" }, captured),
      ),
  };
}

it("keeps loopback writes after a network result quarantined through a clean later edit", async () => {
  const seed = withMemoryWriteProvenance(
    {
      readFile: (file: string) => fs.readFile(file),
      writeFile: async (file: string, content: string) => fs.writeFile(file, content),
    },
    createMemoryWriteProvenanceObserver({
      mutationRoot: state.workspaceDir,
      workspaceDir: state.workspaceDir,
      resolveOriginClass: () => "agent",
    }),
  );
  for (const file of paths) {
    await seed.writeFile(path.join(state.workspaceDir, file), "seed\n");
  }
  const tainted = await grant("network-turn");
  await tainted.list(); // Construct and cache writers before the turn becomes tainted.
  await tainted.call("web_fetch", { url: "https://example.com/memory-provenance" });
  await tainted.call("write", { path: "MEMORY.md", content: "network\n" });
  await tainted.call("edit", { path: "USER.md", edits: [{ oldText: "seed", newText: "network" }] });
  await tainted.call("apply_patch", {
    input:
      "*** Begin Patch\n*** Update File: memory/nested/note.md\n@@\n-seed\n+network\n*** End Patch",
  });
  for (const relativePath of paths) {
    expect(
      await readMemoryArtifactProvenance({ workspaceDir: state.workspaceDir, relativePath }),
    ).toMatchObject({ originClass: "untrusted", sessionId: "network-turn" });
  }
  tainted.admission.close();
  const refused = await tainted.rawCall();
  expect(refused.status).toBe(401);
  await refused.body?.cancel();
  const clean = await grant("clean-turn");
  for (const file of paths) {
    await clean.call("edit", {
      path: file,
      edits: [{ oldText: "network", newText: "later clean edit" }],
    });
  }
  for (const relativePath of paths) {
    expect(
      await readMemoryArtifactProvenance({ workspaceDir: state.workspaceDir, relativePath }),
    ).toMatchObject({ originClass: "untrusted", sessionId: "clean-turn" });
  }
  const { contextFiles } = await resolveBootstrapContextForRun({
    workspaceDir: state.workspaceDir,
    config,
    agentId: "main",
    sessionKey: "agent:main:memory-provenance",
  });
  expect(contextFiles.some((file) => file.content.includes("later clean edit"))).toBe(false);
  await clean.call("write", { path: "memory/clean.md", content: "clean control" });
  expect(
    await readMemoryArtifactProvenance({
      workspaceDir: state.workspaceDir,
      relativePath: "memory/clean.md",
    }),
  ).toMatchObject({ originClass: "agent" });
});
