import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { noteInstallPolicyHealth } from "./doctor-install-policy.js";

const noteMock = vi.hoisted(() => vi.fn());

vi.mock("../../packages/terminal-core/src/note.js", () => ({ note: noteMock }));

async function collectPolicyOutput(
  cfg: OpenClawConfig,
  options: { deep?: boolean; env?: NodeJS.ProcessEnv } = {},
): Promise<string> {
  noteMock.mockClear();
  await noteInstallPolicyHealth(cfg, options);
  const body = noteMock.mock.calls.at(-1)?.[0];
  return typeof body === "string" ? body : "";
}

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function policy(decision: "allow" | "warn" | "block", reason?: string) {
  const dir = tempDirs.make("openclaw-doctor-install-policy-");
  const response = JSON.stringify({ protocolVersion: 1, decision, reason });
  const scriptPath = path.join(dir, "policy.cjs");
  await fs.writeFile(scriptPath, `#!/bin/sh\nprintf '%s' ${JSON.stringify(response)}\n`, "utf8");
  await fs.chmod(scriptPath, 0o700);
  return configWithPolicy(scriptPath);
}

function expectSanitized(body: string, prefix: string) {
  expect(body.split("\n")).not.toContain("- ERROR: forged");
  expect(body).toContain(`${prefix}\\n- ERROR: forged`);
  expect(body).not.toContain("\u001b");
}

function configWithPolicy(command: string): OpenClawConfig {
  const exec = { source: "exec" as const, command, trustedDirs: [path.dirname(command)] };
  return { security: { installPolicy: { enabled: true, exec } } };
}

describe("Install policy Doctor output", () => {
  it("returns no lines when install policy is disabled", async () => {
    await expect(collectPolicyOutput({})).resolves.toBe("");
  });

  it("reports static availability without running the command by default", async () => {
    const body = await collectPolicyOutput(await policy("block", "probe blocked"));
    expect(body).toContain("Install policy enabled for: skill, plugin");
    expect(body).toContain("Static checks passed");
    expect(body).not.toContain("probe blocked");
  });

  it("runs the synthetic probe in deep mode", async () => {
    const body = await collectPolicyOutput(await policy("allow"), { deep: true });
    expect(body).toContain("Deep check allowed the synthetic install request");
  });

  it.each(["warn", "block", "missing"] as const)(
    "keeps %s policy diagnostics on one terminal line",
    async (decision) => {
      const prefix = decision === "missing" ? "missing" : "review probe";
      const text = `${prefix}\n- ERROR: forged\u001b[31m`;
      const cfg =
        decision === "missing"
          ? configWithPolicy(path.join(tempDirs.make("openclaw-doctor-install-policy-"), text))
          : await policy(decision, text);
      const body = await collectPolicyOutput(cfg, { deep: decision !== "missing" });
      expectSanitized(body, prefix);
      if (decision === "warn") {
        expect(body).toContain("Deep check returned a warning: review probe");
        expect(body).toContain("require explicit acknowledgement");
      }
    },
  );

  it("reports unavailable enabled policy as fail-closed", async () => {
    const body = await collectPolicyOutput({
      security: { installPolicy: { enabled: true } },
    });
    expect(body).toContain("security.installPolicy.exec is not configured");
    expect(body).toContain("will be blocked");
  });
});
