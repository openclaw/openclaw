import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { defaultRuntime } from "../runtime.js";

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

it("rejects retired profiles with a migration diagnostic", async () => {
  const root = tempDirs.make("openclaw-templates-inspect-profile-");
  await mkdir(join(root, "profiles"));
  await writeFile(join(root, "CLAW.md"), "---\nschemaVersion: 1\nagent: { id: worker }\n---\n");
  const values: unknown[] = [];
  vi.spyOn(defaultRuntime, "writeJson").mockImplementation((value) => values.push(value));
  const exit = vi.spyOn(defaultRuntime, "exit").mockImplementation(() => {});
  await runTemplatesInspectCommand(join(root, "CLAW.md"), { json: true });
  expect(values[0]).toMatchObject({
    valid: false,
    diagnostics: [expect.objectContaining({ code: "retired_template_configuration" })],
  });
  expect(exit).toHaveBeenCalledWith(1);
  expect(mocks.preflightTemplatePackage).not.toHaveBeenCalled();
});

it.each(["agent", "diagnostic"] as const)(
  "strips terminal controls from %s output",
  async (kind) => {
    const root = tempDirs.make("templates-redaction-");
    const marker = "TEMPLATE_MARKER";
    const injected = `Agent\u001b]0;INJECTED_TITLE\u0007${marker}`;
    await writeFile(
      join(root, "CLAW.md"),
      `---\n${JSON.stringify({
        schemaVersion: 1,
        agent: { id: "demo-agent", ...(kind === "agent" ? { name: injected } : {}) },
        ...(kind === "diagnostic" ? { metadata: { [injected]: 1 } } : {}),
      })}\n---\n`,
    );
    const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    const error = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
    vi.spyOn(defaultRuntime, "exit").mockImplementation(() => {});
    await runTemplatesInspectCommand(join(root, "CLAW.md"), {});
    const output =
      kind === "agent"
        ? log.mock.calls.map(([line]) => String(line)).find((line) => line.startsWith("Agent: "))
        : String(error.mock.calls[0]?.[0]);
    expect(output).toContain(marker);
    expect(output).not.toMatch(/\p{Cc}/u);
  },
);
