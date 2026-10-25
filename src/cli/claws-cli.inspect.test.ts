import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { emptyPluginCapabilityEvidence } from "../claws/packages.test-support.js";
import type { ClawPackage } from "../claws/types.js";
import { defaultRuntime } from "../runtime.js";

const mocks = vi.hoisted(() => ({
  preflightClawPackage: vi.fn(),
  config: { plugins: { load: { paths: ["/configured/plugin"] } } },
}));

vi.mock("../claws/packages.js", async () => ({
  ...(await vi.importActual<typeof import("../claws/packages.js")>("../claws/packages.js")),
  preflightClawPackage: mocks.preflightClawPackage,
}));

vi.mock("../config/config.js", async () => ({
  ...(await vi.importActual<typeof import("../config/config.js")>("../config/config.js")),
  getRuntimeConfig: () => mocks.config,
}));

const { runClawsInspectCommand } = await import("./claws-cli.runtime.js");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

const preflight = {
  ok: true,
  action: "install",
  integrity: `sha256:${"a".repeat(64)}`,
  installId: "audit",
  detectedFormat: "claude",
  mapped: ["commands", "skills"],
  unavailable: ["agents"],
  adapterIdentity: "openclaw/test",
  declaredCapabilities: emptyPluginCapabilityEvidence.declared,
  capabilityGrants: emptyPluginCapabilityEvidence.grants,
  capabilityGrantsByPluginId: emptyPluginCapabilityEvidence.grantsByPluginId,
};

async function writeJson(root: string, name: string, value: unknown) {
  await writeFile(join(root, name), JSON.stringify(value), "utf8");
}

async function createInspectFixture(format: "claude" | "openclaw", packages: ClawPackage[] = []) {
  const root = tempDirs.make("openclaw-claws-inspect-extension-");
  await mkdir(join(root, "profiles"));
  await writeJson(root, "package.json", {
    name: "@acme/demo-agent",
    version: "1.2.3",
    openclaw: { claw: "openclaw.claw.json" },
  });
  await writeJson(root, "openclaw.claw.json", {
    schemaVersion: 1,
    agent: { id: "demo-agent" },
    ...(packages.length ? { packages } : {}),
  });
  await writeFile(
    join(root, "profiles", "openclaw.yml"),
    [
      "schemaVersion: 1",
      "agent: {}",
      "extensions:",
      "  - id: audit-tools",
      "    kind: plugin",
      `    format: ${format}`,
      "    source: clawhub",
      "    ref: '@owner/audit'",
      "    version: 2.0.1",
      "",
    ].join("\n"),
    "utf8",
  );
  const values: unknown[] = [];
  const runtime = {
    log: vi.spyOn(defaultRuntime, "log").mockImplementation(() => {}),
    error: vi.spyOn(defaultRuntime, "error").mockImplementation(() => {}),
    writeJson: vi
      .spyOn(defaultRuntime, "writeJson")
      .mockImplementation((value) => values.push(value)),
    writeStdout: vi.spyOn(defaultRuntime, "writeStdout").mockImplementation(() => {}),
    exit: vi.spyOn(defaultRuntime, "exit").mockImplementation(() => {}),
  };
  return { root, values, runtime };
}

describe("claws inspect extensions", () => {
  beforeEach(() => {
    mocks.preflightClawPackage.mockReset();
  });

  it("reports canonical profile extension mappings", async () => {
    const { root, values, runtime } = await createInspectFixture("claude");
    mocks.preflightClawPackage.mockResolvedValue(preflight);
    await runClawsInspectCommand(root, { json: true });

    expect(values[0]).toMatchObject({
      valid: true,
      extensions: [
        {
          id: "audit-tools",
          detectedFormat: "claude",
          mapped: ["commands", "skills"],
          unavailable: ["agents"],
          adapterIdentity: "openclaw/test",
        },
      ],
    });
    expect(mocks.preflightClawPackage).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "plugin", ref: "@owner/audit" }),
      root,
      { config: mocks.config },
    );
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("strips terminal controls from the reported agent name", async () => {
    const { root, runtime } = await createInspectFixture("claude");
    // Drop the fixture's extension so the report path needs no package preflight.
    await rm(join(root, "profiles", "openclaw.yml"));
    await writeJson(root, "openclaw.claw.json", {
      schemaVersion: 1,
      agent: { id: "demo-agent", name: "Agent\u001b]0;INJECTED_TITLE\u0007CLAW_MARKER_9F3E2D" },
    });

    await runClawsInspectCommand(root, {});

    const lines = runtime.log.mock.calls.map((call) => String(call[0]));
    const agentLine = lines.find((line) => line.startsWith("Agent: "));
    expect(agentLine).toBeDefined();
    expect(agentLine).toContain("CLAW_MARKER_9F3E2D");
    expect(agentLine).not.toMatch(/\p{Cc}/u);
  });

  it("strips terminal controls from reported manifest diagnostics", async () => {
    const { root, runtime } = await createInspectFixture("claude");
    await writeJson(root, "openclaw.claw.json", {
      schemaVersion: 1,
      agent: { id: "demo-agent" },
      metadata: { "key\u001b]0;INJECTED_TITLE\u0007DIAG_MARKER": 1 },
    });

    await runClawsInspectCommand(root, {});

    const output = String(runtime.error.mock.calls[0]?.[0]);
    expect(output).toContain("DIAG_MARKER");
    expect(output).not.toMatch(/\p{Cc}/u);
  });

  it("rejects a plugin declared by both the portable manifest and OpenClaw profile", async () => {
    const { root, values, runtime } = await createInspectFixture("openclaw", [
      { kind: "plugin", source: "clawhub", ref: "@owner/audit", version: "2.0.1" },
    ]);
    mocks.preflightClawPackage.mockResolvedValue({
      ...preflight,
      detectedFormat: "openclaw",
      mapped: ["skills"],
      unavailable: [],
      adapterIdentity: "openclaw/test",
    });
    await runClawsInspectCommand(root, { json: true });

    expect(values[0]).toMatchObject({
      valid: false,
      diagnostics: [expect.objectContaining({ code: "extension_package_collision" })],
    });
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });
});
