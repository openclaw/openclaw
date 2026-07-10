// Reset command tests cover cleanup runtime behavior, workspace attestations, and reset prompts.
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import {
  cleanupCommandLogMessages,
  createCleanupCommandRuntime,
  removePath,
  removeStateAndLinkedPaths,
  removeWorkspaceAttestationPaths,
  resetCleanupCommandMocks,
  silenceCleanupCommandRuntime,
} from "./cleanup-command.test-support.js";

describe("resetCommand", () => {
  const runtime = createCleanupCommandRuntime();
  let resetCommand: typeof import("./reset.js").resetCommand;

  beforeAll(async () => {
    ({ resetCommand } = await import("./reset.js"));
  });

  beforeEach(() => {
    resetCleanupCommandMocks();
    silenceCleanupCommandRuntime(runtime);
  });

  it("recommends creating a backup before state-destructive reset scopes", async () => {
    await resetCommand(runtime, {
      scope: "config+creds+sessions",
      yes: true,
      nonInteractive: true,
      dryRun: true,
    });

    expect(
      cleanupCommandLogMessages(runtime).some((message) =>
        message.includes("openclaw backup create"),
      ),
    ).toBe(true);
  });

  it("does not recommend backup for config-only reset", async () => {
    await resetCommand(runtime, {
      scope: "config",
      yes: true,
      nonInteractive: true,
      dryRun: true,
    });

    expect(
      cleanupCommandLogMessages(runtime).some((message) =>
        message.includes("openclaw backup create"),
      ),
    ).toBe(false);
  });

  it("removes workspace attestations during full reset", async () => {
    await resetCommand(runtime, {
      scope: "full",
      yes: true,
      nonInteractive: true,
      dryRun: true,
    });

    expect(removeWorkspaceAttestationPaths).toHaveBeenCalledWith(
      ["/tmp/.openclaw/workspace"],
      runtime,
      { dryRun: true },
    );
  });

  it.each([
    [
      "external",
      { OPENCLAW_CONFIG_MANAGED: "1", OPENCLAW_NIX_MODE: undefined },
      "OPENCLAW_CONFIG_MANAGED",
    ],
    [
      "Nix",
      { OPENCLAW_CONFIG_MANAGED: undefined, OPENCLAW_NIX_MODE: "1" },
      "OPENCLAW_NIX_MODE_CONFIG_IMMUTABLE",
    ],
  ] as const)(
    "rejects non-dry-run reset before side effects in %s managed mode",
    async (_label, env, code) => {
      await withEnvAsync(env, async () => {
        await expect(
          resetCommand(runtime, {
            scope: "full",
            yes: true,
            nonInteractive: true,
          }),
        ).rejects.toMatchObject({ code });
      });

      expect(removePath).not.toHaveBeenCalled();
      expect(removeStateAndLinkedPaths).not.toHaveBeenCalled();
      expect(removeWorkspaceAttestationPaths).not.toHaveBeenCalled();
    },
  );

  it("keeps managed reset dry-runs available", async () => {
    await withEnvAsync({ OPENCLAW_CONFIG_MANAGED: "1" }, async () => {
      await expect(
        resetCommand(runtime, {
          scope: "config",
          yes: true,
          nonInteractive: true,
          dryRun: true,
        }),
      ).resolves.toBeUndefined();
    });

    expect(removePath).toHaveBeenCalledWith("/tmp/.openclaw/openclaw.json", runtime, {
      dryRun: true,
      label: "/tmp/.openclaw/openclaw.json",
    });
  });
});
