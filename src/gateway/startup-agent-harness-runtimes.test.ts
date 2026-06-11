import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { collectGatewayStartupSessionAgentHarnessRuntimes } from "./startup-agent-harness-runtimes.js";

describe("collectGatewayStartupSessionAgentHarnessRuntimes", () => {
  it("collects persisted plugin harnesses from agent session stores", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-startup-harnesses-"));
    try {
      const config = {
        session: {
          store: path.join(root, "sessions-{agentId}.json"),
        },
        agents: {
          list: [{ id: "main", default: true }, { id: "worker" }],
        },
      } as OpenClawConfig;

      await fs.writeFile(
        path.join(root, "sessions-main.json"),
        JSON.stringify({
          "agent:main:codex": { agentHarnessId: "codex-app-server" },
          "agent:main:pi": { agentHarnessId: "pi" },
        }),
      );
      await fs.writeFile(
        path.join(root, "sessions-worker.json"),
        JSON.stringify({
          "agent:worker:auto": { agentHarnessId: "auto" },
          "agent:worker:native": { agentHarnessId: "native-runner" },
        }),
      );

      expect(collectGatewayStartupSessionAgentHarnessRuntimes({ config })).toEqual([
        "codex",
        "native-runner",
      ]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
