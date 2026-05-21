// End-to-end regression for the 2026-05-20 incident.
//
// On 2026-05-20T11:44:55Z, `openclaw update --yes` on cedric@<host> rewrote
// a wrapper-backed LaunchAgent into a direct `[node, dist/entry.js, gateway,
// --port, 18789]` invocation. The wrapper sourced macOS Keychain secrets,
// so the direct exec immediately failed with:
//
//   Startup failed: required secrets are unavailable.
//   SecretRefResolutionError: Environment variable "OPENCLAW_GATEWAY_TOKEN"
//   is missing or empty.
//
// (Stability log: ~/.openclaw/logs/stability/openclaw-stability-
// 2026-05-20T11-44-50-382Z-31540-gateway.startup_failed.json.)
//
// This test mirrors the exact shape of the incident:
//   - macOS LaunchAgent
//   - ProgramArguments = ["…/launch_gateway.sh"]   (wrapper-only)
//   - environment dict is empty (no OPENCLAW_WRAPPER recorded)
//
// It exercises BOTH the real `auditGatewayServiceConfig` and the real
// wrapper-resolution path in `buildGatewayInstallPlan`, asserting:
//   1. the audit does not flag the destructive `gateway-command-missing`
//      (or `gateway-path-missing`) for a wrapper-only plist;
//   2. the install plan keeps the wrapper as programArguments[0];
//   3. the install plan never falls back to direct `node …/entry.js`
//      execution.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { auditGatewayServiceConfig, SERVICE_AUDIT_CODES } from "../daemon/service-audit.js";

const mocks = vi.hoisted(() => ({
  hasAnyAuthProfileStoreSource: vi.fn(() => false),
  loadAuthProfileStoreForSecretsRuntime: vi.fn(),
  resolvePreferredNodePath: vi.fn(),
  resolveSystemNodeInfo: vi.fn(),
  renderSystemNodeWarning: vi.fn(),
}));

vi.mock("./daemon-install-auth-profiles-source.runtime.js", () => ({
  hasAnyAuthProfileStoreSource: mocks.hasAnyAuthProfileStoreSource,
}));

vi.mock("./daemon-install-auth-profiles-store.runtime.js", () => ({
  loadAuthProfileStoreForSecretsRuntime: mocks.loadAuthProfileStoreForSecretsRuntime,
}));

vi.mock("../daemon/runtime-paths.js", async () => {
  const actual = await vi.importActual<typeof import("../daemon/runtime-paths.js")>(
    "../daemon/runtime-paths.js",
  );
  return {
    ...actual,
    resolvePreferredNodePath: mocks.resolvePreferredNodePath,
    resolveSystemNodeInfo: mocks.resolveSystemNodeInfo,
    renderSystemNodeWarning: mocks.renderSystemNodeWarning,
  };
});

import { buildGatewayInstallPlan } from "./daemon-install-helpers.js";

describe("2026-05-20 wrapper-preservation regression", () => {
  let isolatedHome: string;
  let wrapperPath: string;

  beforeEach(() => {
    isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), "oc-incident-test-"));
    const credentialsDir = path.join(isolatedHome, ".openclaw", "credentials");
    fs.mkdirSync(credentialsDir, { recursive: true });
    wrapperPath = path.join(credentialsDir, "launch_gateway.sh");
    fs.writeFileSync(
      wrapperPath,
      [
        "#!/bin/bash",
        "set -euo pipefail",
        '. "$HOME/.openclaw/credentials/load_openclaw_runtime_env.sh"',
        'exec /opt/homebrew/opt/node/bin/node /opt/homebrew/lib/node_modules/openclaw/dist/entry.js gateway --port 18789',
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    mocks.resolvePreferredNodePath.mockResolvedValue("/opt/homebrew/opt/node/bin/node");
    mocks.resolveSystemNodeInfo.mockResolvedValue({
      path: "/opt/homebrew/opt/node/bin/node",
      version: "24.0.0",
      supported: true,
    });
    mocks.renderSystemNodeWarning.mockReturnValue(undefined);
    mocks.loadAuthProfileStoreForSecretsRuntime.mockReturnValue({ version: 1, profiles: {} });
  });

  afterEach(() => {
    fs.rmSync(isolatedHome, { recursive: true, force: true });
    vi.resetAllMocks();
  });

  function buildIncidentCommand() {
    return {
      programArguments: [wrapperPath],
      environment: {} as Record<string, string>,
      sourcePath: path.join(isolatedHome, "Library", "LaunchAgents", "ai.openclaw.gateway.plist"),
    };
  }

  it("auditGatewayServiceConfig does not flag command-missing or path-missing on a wrapper-only plist", async () => {
    const command = buildIncidentCommand();
    const audit = await auditGatewayServiceConfig({
      env: { HOME: isolatedHome },
      platform: "darwin",
      command,
    });
    // The exact two codes the update-mode doctor used to weaponize into an
    // aggressive / recommended rewrite of the wrapper-backed plist.
    const codes = audit.issues.map((issue) => issue.code);
    expect(codes).not.toContain(SERVICE_AUDIT_CODES.gatewayCommandMissing);
    expect(codes).not.toContain(SERVICE_AUDIT_CODES.gatewayPathMissing);
  });

  it("buildGatewayInstallPlan preserves the wrapper as argv[0] when fed the incident's command shape", async () => {
    const command = buildIncidentCommand();

    const plan = await buildGatewayInstallPlan({
      env: { HOME: isolatedHome },
      port: 18789,
      runtime: "node",
      existingProgramArguments: command.programArguments,
      existingEnvironment: command.environment,
      platform: "darwin",
    });

    // The single most load-bearing assertion: argv[0] is the wrapper.
    expect(plan.programArguments[0]).toBe(wrapperPath);

    // And the regenerated plan must NOT be the direct-exec command that
    // broke the gateway on 2026-05-20.
    const joined = plan.programArguments.join(" ");
    expect(joined).not.toMatch(/\/opt\/homebrew\/opt\/node\/bin\/node\s+\S+entry\.js/);
    expect(joined).not.toMatch(/(?:^|\s)\/usr\/bin\/node\s/);
    expect(plan.programArguments).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/\/dist\/(?:entry|index)\.(?:c?js|mjs)$/)]),
    );

    // And the wrapper is recorded in the managed service env so future
    // doctor runs can find it via OPENCLAW_WRAPPER instead of only argv[0].
    expect(plan.environment.OPENCLAW_WRAPPER).toBe(wrapperPath);
  });

  it("buildGatewayInstallPlan hard-fails when the recovered service points at a wrapper that was removed", async () => {
    // Operator deletes the wrapper before running the next update. The
    // direct-exec fallback is exactly the failure mode this fix is for,
    // so the install plan must refuse rather than silently regenerate
    // `[node, …/entry.js, gateway]`.
    fs.unlinkSync(wrapperPath);
    const command = buildIncidentCommand();

    await expect(
      buildGatewayInstallPlan({
        env: { HOME: isolatedHome },
        port: 18789,
        runtime: "node",
        existingProgramArguments: command.programArguments,
        existingEnvironment: command.environment,
        platform: "darwin",
      }),
    ).rejects.toThrow(/Refusing to rewrite a wrapper-backed gateway service/);
  });
});
