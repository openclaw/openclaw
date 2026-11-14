import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { noteInstallPolicyHealth } from "./doctor-install-policy.js";

const noteMock = vi.hoisted(() => vi.fn());

vi.mock("../../packages/terminal-core/src/note.js", () => ({ note: noteMock }));

async function collectInstallPolicyHealthLines(
  cfg: OpenClawConfig,
  options: { deep?: boolean; env?: NodeJS.ProcessEnv } = {},
): Promise<string[]> {
  noteMock.mockClear();
  await noteInstallPolicyHealth(cfg, options);
  const body = noteMock.mock.calls.at(-1)?.[0];
  return typeof body === "string" ? body.split("\n") : [];
}

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function policyConfig(decision: string, reason?: string): Promise<OpenClawConfig> {
  const dir = tempDirs.make("openclaw-doctor-install-policy-");
  const scriptPath = path.join(dir, "policy.cjs");
  const response = JSON.stringify({ protocolVersion: 1, decision, reason });
  await fs.writeFile(scriptPath, `#!/bin/sh\nprintf '%s' ${JSON.stringify(response)}\n`, "utf8");
  await fs.chmod(scriptPath, 0o700);
  return configWithPolicy(scriptPath);
}

function configWithPolicy(scriptPath: string): OpenClawConfig {
  const exec = {
    source: "exec" as const,
    command: scriptPath,
    trustedDirs: [path.dirname(scriptPath)],
  };
  return { security: { installPolicy: { enabled: true, exec } } };
}

it("returns no lines when install policy is disabled", async () => {
  await expect(collectInstallPolicyHealthLines({})).resolves.toEqual([]);
});

it.each([false, true])("checks policy availability (deep=%s)", async (deep) => {
  const config = await policyConfig(deep ? "allow" : "block", "probe blocked");
  const output = (await collectInstallPolicyHealthLines(config, { deep })).join("\n");
  expect(output).toContain("Install policy enabled for: skill, plugin");
  expect(output).toContain(
    deep ? "Deep check allowed the synthetic install request" : "Static checks passed",
  );
  expect(output).not.toContain("probe blocked");
});

it.each(["warn", "block"] as const)(
  "keeps policy-controlled %s reasons on one terminal line",
  async (decision) => {
    const lines = await collectInstallPolicyHealthLines(
      await policyConfig(decision, "review probe\n- ERROR: forged\u001b[31m"),
      { deep: true },
    );
    expectSanitized(lines, "review probe");
    if (decision === "warn") {
      expect(lines.join("\n")).toContain("Deep check returned a warning: review probe");
      expect(lines.join("\n")).toContain("require explicit acknowledgement");
    }
  },
);

it("reports unavailable enabled policy as fail-closed", async () => {
  const onFinding = vi.fn();
  await noteInstallPolicyHealth({ security: { installPolicy: { enabled: true } } }, { onFinding });
  expect(onFinding).toHaveBeenCalledWith(
    expect.objectContaining({
      category: "fix-now",
      severity: "error",
      message: expect.stringContaining("security.installPolicy.exec is not configured"),
      fixHint: expect.stringContaining("remain blocked"),
      docsUrl: expect.stringContaining("tool-permissions#plugins"),
    }),
  );
  expect(noteMock.mock.calls.at(-1)?.[0]).not.toContain("ERROR");
});

it("keeps static validation errors on one terminal line", async () => {
  const dir = tempDirs.make("openclaw-doctor-install-policy-");
  const command = path.join(dir, "missing\n- ERROR: forged\u001b[31m");

  const lines = await collectInstallPolicyHealthLines(configWithPolicy(command));

  expectSanitized(lines, "missing");
});

function expectSanitized(lines: string[], prefix: string) {
  expect(lines).not.toContain("- ERROR: forged");
  expect(lines.join("\n")).toContain(`${prefix}\\n- ERROR: forged`);
  expect(lines.join("\n")).not.toContain("\u001b");
}
