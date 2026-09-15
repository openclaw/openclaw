import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  listRegisteredAgentHarnesses,
  registerAgentHarness,
} from "../../agents/harness/registry.js";
import { restoreRegisteredAgentHarnesses } from "../../agents/harness/registry.test-support.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  resolveSessionPlacementDisabledReason,
  SESSION_PLACEMENT_PREPARED_AUTH_REASON,
  SESSION_PLACEMENT_WORKSPACE_SYMLINKS_REASON,
} from "./device-placement-eligibility.js";
import {
  resolveMissingPreparedAuthForPlacement,
  resolveSessionPlacementPreflight,
  workspaceHasEscapingSymlinks,
} from "./session-placement-preflight.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map(async (root) => {
      await fs.rm(root, { recursive: true, force: true });
    }),
  );
});

async function makeTempRoot(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

describe("session-host placement preflight", () => {
  it("detects escaping workspace symlinks for environments.list projection", async () => {
    const root = await makeTempRoot("openclaw-session-preflight-symlink-");
    const outside = await makeTempRoot("openclaw-session-preflight-outside-");
    await fs.symlink(outside, path.join(root, "escape"));
    await expect(workspaceHasEscapingSymlinks(root)).resolves.toBe(true);
    const preflight = await resolveSessionPlacementPreflight({
      config: {} as OpenClawConfig,
      workspacePath: root,
    });
    expect(preflight.workspaceHasEscapingSymlinks).toBe(true);
    expect(resolveSessionPlacementDisabledReason(preflight)).toBe(
      SESSION_PLACEMENT_WORKSPACE_SYMLINKS_REASON,
    );
  });

  it("marks missing prepared auth for remote-exec when homeScope is user", () => {
    const registered = listRegisteredAgentHarnesses();
    registerAgentHarness({
      id: "codex-remote",
      label: "Codex remote",
      autoSelection: { providerIds: ["openai"] },
      supports: () => ({ supported: true }),
      cloudPlacement: {
        mode: "remote-exec",
        devicePlacement: {
          requiredNodeCommands: ["codex.exec-server.stdio.v1"],
          consumesWorkerSlot: false,
        },
      },
      runAttempt: async () => {
        throw new Error("preflight must not execute");
      },
    });
    try {
      const config = {
        plugins: { entries: { codex: { config: { appServer: { homeScope: "user" } } } } },
      } as OpenClawConfig;
      expect(resolveMissingPreparedAuthForPlacement({ config, runtimeId: "codex-remote" })).toBe(
        true,
      );
      expect(resolveSessionPlacementDisabledReason({ missingPreparedAuth: true })).toBe(
        SESSION_PLACEMENT_PREPARED_AUTH_REASON,
      );
    } finally {
      restoreRegisteredAgentHarnesses(registered);
    }
  });

  it("stacks symlink and prepared-auth disabledReason for list/preflight projection", async () => {
    const reason = resolveSessionPlacementDisabledReason({
      workspaceHasEscapingSymlinks: true,
      missingPreparedAuth: true,
    });
    expect(reason).toContain(SESSION_PLACEMENT_WORKSPACE_SYMLINKS_REASON);
    expect(reason).toContain(SESSION_PLACEMENT_PREPARED_AUTH_REASON);
  });
});
