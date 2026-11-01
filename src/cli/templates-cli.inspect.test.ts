import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { defaultRuntime } from "../runtime.js";
import { emptyPluginPlanEvidence } from "../templates/packages.test-support.js";
import { writeFixtureJson } from "./cli-fixtures.test-support.js";

const mocks = vi.hoisted(() => ({
  preflightTemplatePackage: vi.fn(),
  config: { plugins: { load: { paths: ["/configured/plugin"] } } },
}));

vi.mock("../templates/packages.js", async () => ({
  ...(await vi.importActual<typeof import("../templates/packages.js")>("../templates/packages.js")),
  preflightTemplatePackage: mocks.preflightTemplatePackage,
}));

vi.mock("../config/config.js", async () => ({
  ...(await vi.importActual<typeof import("../config/config.js")>("../config/config.js")),
  getRuntimeConfig: () => mocks.config,
}));

const { runTemplatesInspectCommand } = await import("./templates-cli.runtime.js");
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
  ...emptyPluginPlanEvidence,
};

it("rejects a plugin declared by both the portable manifest and OpenClaw profile", async () => {
  const root = tempDirs.make("openclaw-templates-inspect-extension-");
  await mkdir(join(root, "profiles"));
  await writeFixtureJson(join(root, "openclaw.template.json"), {
    schemaVersion: 1,
    agent: { id: "demo-agent" },
    packages: [{ kind: "plugin", source: "clawhub", ref: "@owner/audit", version: "2.0.1" }],
  });
  await writeFixtureJson(join(root, "profiles/openclaw.yml"), {
    schemaVersion: 1,
    agent: {},
    extensions: [
      {
        id: "audit-tools",
        kind: "plugin",
        format: "claude",
        source: "clawhub",
        ref: "@owner/audit",
        version: "2.0.1",
      },
    ],
  });
  const values: unknown[] = [];
  vi.spyOn(defaultRuntime, "writeJson").mockImplementation((value) => values.push(value));
  const exit = vi.spyOn(defaultRuntime, "exit").mockImplementation(() => {});
  mocks.preflightTemplatePackage.mockResolvedValue(preflight);
  await runTemplatesInspectCommand(join(root, "openclaw.template.json"), { json: true });
  expect(values[0]).toMatchObject({
    valid: false,
    extensions: [
      {
        id: "audit-tools",
        detectedFormat: "claude",
        mapped: ["commands", "skills"],
        unavailable: ["agents"],
        adapterIdentity: "openclaw/test",
      },
    ],
    diagnostics: [expect.objectContaining({ code: "extension_package_collision" })],
  });
  expect(exit).toHaveBeenCalledWith(1);
});

it.each(["agent", "diagnostic"] as const)(
  "strips terminal controls from %s output",
  async (kind) => {
    const root = tempDirs.make("templates-redaction-");
    const marker = "TEMPLATE_MARKER";
    const injected = `Agent\u001b]0;INJECTED_TITLE\u0007${marker}`;
    await writeFixtureJson(join(root, "openclaw.template.json"), {
      schemaVersion: 1,
      agent: { id: "demo-agent", ...(kind === "agent" ? { name: injected } : {}) },
      ...(kind === "diagnostic" ? { metadata: { [injected]: 1 } } : {}),
    });
    const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    const error = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
    vi.spyOn(defaultRuntime, "exit").mockImplementation(() => {});
    await runTemplatesInspectCommand(join(root, "openclaw.template.json"), {});
    const output =
      kind === "agent"
        ? log.mock.calls.map(([line]) => String(line)).find((line) => line.startsWith("Agent: "))
        : String(error.mock.calls[0]?.[0]);
    expect(output).toContain(marker);
    expect(output).not.toMatch(/\p{Cc}/u);
  },
);
